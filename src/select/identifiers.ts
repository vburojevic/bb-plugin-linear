/**
 * Finding Linear issues in ordinary text.
 *
 * Used by the chat message action, which is handed a message's visible text and
 * has to decide what "open this in Linear" means. It runs in the registration
 * callback — no rpc, no store, no team list — so it is deliberately **loose**,
 * and the strictness lives one step later where it belongs: every identifier
 * found here is resolved against the mirror, and anything that is not a real
 * issue simply disappears.
 *
 * That split is the whole design. A parser that tried to be precise here would
 * need the workspace's team keys, which are not available in that scope, and
 * would still be wrong for a workspace that adds a team tomorrow. Resolution
 * already answers the question exactly, so this only has to avoid missing
 * things.
 *
 * The cost of a false positive is therefore one local SQLite lookup that
 * returns nothing — `UTF-8`, `SHA-256`, `RFC-2119` and `COVID-19` all match
 * this pattern and all resolve to nothing, which is why the caller falls back
 * silently rather than reporting "no issue called UTF-8".
 */

/**
 * A Linear identifier: an uppercase team key, a hyphen, a number.
 *
 * The key is 2–10 characters because Linear generates 3 and allows editing;
 * one character would match `A-1` in prose and every ordered list ever
 * written. Bounded digits for the same reason — `PAGE-1234567890123` is a
 * phone number, not an issue.
 *
 * Anchored on non-word boundaries at both ends so `SHENG-12` does not yield
 * `ENG-12`, which would open somebody else's issue from a word that merely
 * contains a team key.
 */
const IDENTIFIER = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,7})(?![A-Za-z0-9])/g;

/**
 * A Linear issue URL, in either of the two shapes Linear itself produces:
 * `linear.app/<workspace>/issue/ENG-123/slug` and the short
 * `linear.app/<workspace>/issue/ENG-123`.
 *
 * Matched separately and first, because the identifier inside a URL is
 * surrounded by slashes rather than word boundaries, and because a URL is a
 * far stronger signal than the same characters loose in a sentence.
 */
const ISSUE_URL = /linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d{1,7})/gi;

/**
 * A message that names forty issues is a pasted report, and a picker of forty
 * is not an answer to "open this". Everything past the cap is dropped rather
 * than truncated silently — the caller says so.
 */
export const MAX_IDENTIFIERS = 12;

export interface FoundIdentifiers {
  /** Uppercased, de-duplicated, in the order they first appear. */
  readonly identifiers: readonly string[];
  /** How many were dropped by the cap. */
  readonly dropped: number;
}

/**
 * Every identifier in some text, first-appearance order, de-duplicated.
 *
 * Order matters: the first identifier in a message is overwhelmingly the one
 * the message is *about*, and a single-match message opens straight to it.
 */
export function identifiersInText(text: string): FoundIdentifiers {
  if (text === "") return { identifiers: [], dropped: 0 };

  const seen = new Set<string>();
  const found: string[] = [];

  const take = (raw: string): void => {
    const identifier = raw.toUpperCase();
    if (seen.has(identifier)) return;
    seen.add(identifier);
    found.push(identifier);
  };

  // URLs first, so a link and a bare mention of the same issue collapse to one
  // entry rather than two — and so the URL's position decides the order.
  for (const match of text.matchAll(ISSUE_URL)) {
    if (match[1] !== undefined) take(match[1]);
  }
  for (const match of text.matchAll(IDENTIFIER)) {
    if (match[1] !== undefined && match[2] !== undefined) take(`${match[1]}-${match[2]}`);
  }

  return {
    identifiers: found.slice(0, MAX_IDENTIFIERS),
    dropped: Math.max(0, found.length - MAX_IDENTIFIERS),
  };
}
