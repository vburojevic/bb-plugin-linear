/**
 * The binding ladder: which Linear issue is this bb thread working on?
 *
 * Four rungs, strongest first, and the strength ordering is the design:
 *
 *   1. **An existing link** — a spawn, a manual `bb linear link`, or a rung
 *      below that already persisted. Ground truth; never re-litigated here.
 *   2. **The branch name** — Linear generated it (`gitBranchFormat`), bb
 *      checked it out, and the mirror indexes it. Deterministic, auto-binds.
 *   3. **An issue key in the thread's text** — "fix LIN-12" names its issue.
 *      Deterministic when the key resolves in scope, auto-binds.
 *   4. **A fuzzy title match** — never binds. It becomes a *suggestion* the
 *      user confirms with one click, because a wrong binding combined with
 *      write-back moves the wrong ticket, and the suggestion UI makes being
 *      wrong cost one glance instead of one incident.
 *
 * Pure: every dependency is injected, every outcome is a value. The caller
 * persists deterministic outcomes (rungs 2–3) and caches suggestions.
 */

import { identifiersInText } from "./select/identifiers.js";
import type { IssueRow, ThreadLinkOrigin, ThreadLinkRow } from "./store/rows.js";

export interface LadderIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly teamId: string;
}

export interface LadderDeps {
  threadLink(threadId: string): ThreadLinkRow | null;
  issuesByBranch(branchName: string): IssueRow[];
  issueByIdentifier(identifier: string): IssueRow | null;
  /** Open issues of the readable teams, for the fuzzy rung. Bounded by the
   *  caller — the scorer is O(candidates). */
  openIssues(): readonly LadderIssue[];
  /** The thread's readable team ids; an issue outside them never binds. */
  readTeamIds: ReadonlySet<string>;
}

export interface LadderInput {
  readonly threadId: string;
  readonly branchName: string | null;
  /** Texts worth scanning for issue keys, in confidence order — the thread
   *  title first, then whatever messages the caller had at hand. */
  readonly texts: readonly string[];
  /** The thread title alone, for the fuzzy rung. */
  readonly title: string | null;
}

export type LadderOutcome =
  | {
      readonly kind: "bound";
      readonly issueId: string;
      readonly teamId: string;
      readonly origin: ThreadLinkOrigin;
      /** False when rung 1 answered — the link already exists and the caller
       *  must not write it again. */
      readonly isNew: boolean;
    }
  | {
      readonly kind: "suggestion";
      readonly issueId: string;
      readonly identifier: string;
      readonly title: string;
      readonly score: number;
    }
  | { readonly kind: "none" };

export function resolveBinding(deps: LadderDeps, input: LadderInput): LadderOutcome {
  // Rung 1 — an existing link is the answer, whatever made it.
  const existing = deps.threadLink(input.threadId);
  if (existing !== null) {
    return {
      kind: "bound",
      issueId: existing.issueId,
      teamId: existing.teamId,
      origin: existing.origin,
      isNew: false,
    };
  }

  // Rung 2 — the branch. Scope-checked: a branch that names another team's
  // issue is a fact worth ignoring, not a binding — writing to a board this
  // project cannot read is exactly the accident the scope rules exist for.
  if (input.branchName !== null && input.branchName !== "") {
    const match = deps
      .issuesByBranch(input.branchName)
      .find((issue) => deps.readTeamIds.has(issue.teamId));
    if (match !== undefined) {
      return { kind: "bound", issueId: match.id, teamId: match.teamId, origin: "branch", isNew: true };
    }
  }

  // Rung 3 — a key in the text. First resolvable identifier wins: the first
  // key in a message is overwhelmingly the one the message is about.
  for (const text of input.texts) {
    if (text === "") continue;
    for (const identifier of identifiersInText(text).identifiers) {
      const issue = deps.issueByIdentifier(identifier);
      if (issue !== null && deps.readTeamIds.has(issue.teamId)) {
        return { kind: "bound", issueId: issue.id, teamId: issue.teamId, origin: "message", isNew: true };
      }
    }
  }

  // Rung 4 — fuzzy, suggestion only.
  const suggestion = suggestByTitle(input.title, deps.openIssues());
  if (suggestion !== null) return suggestion;

  return { kind: "none" };
}

/* ── The fuzzy rung ──────────────────────────────────────────────────────── */

/** Below this, a match is noise. Chosen against the test fixtures: real pairs
 *  ("Fix the webhook health check" → "Webhook health check demotes to
 *  polling") score well above it, and unrelated titles well below. */
export const SUGGESTION_THRESHOLD = 0.5;
/** The best match must beat the runner-up by this much, or the honest answer
 *  is "ambiguous" and the chip stays quiet. A suggestion that flickers
 *  between two issues is worse than none. */
export const SUGGESTION_MARGIN = 0.15;

const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "is", "are",
  "it", "its", "this", "that", "fix", "fixes", "add", "adds", "update",
  "updates", "implement", "implements", "build", "builds", "make", "makes",
]);

function tokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    found.add(raw);
  }
  return found;
}

/** Set-cosine over content tokens. Cheap, order-free, and — unlike substring
 *  matching — indifferent to which surface abbreviated what. */
export function titleSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.sqrt(left.size * right.size);
}

function suggestByTitle(
  title: string | null,
  candidates: readonly LadderIssue[],
): LadderOutcome | null {
  if (title === null) return null;
  if (tokens(title).size < 2) return null; // one content word matches everything a little

  let best: { issue: LadderIssue; score: number } | null = null;
  let second = 0;
  for (const issue of candidates) {
    const score = titleSimilarity(title, issue.title);
    if (best === null || score > best.score) {
      second = best?.score ?? 0;
      best = { issue, score };
    } else if (score > second) {
      second = score;
    }
  }

  if (best === null) return null;
  if (best.score < SUGGESTION_THRESHOLD) return null;
  if (best.score - second < SUGGESTION_MARGIN) return null;

  return {
    kind: "suggestion",
    issueId: best.issue.id,
    identifier: best.issue.identifier,
    title: best.issue.title,
    score: best.score,
  };
}
