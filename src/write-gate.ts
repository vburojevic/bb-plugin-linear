/**
 * The write switch: one flip makes the plugin read-only.
 *
 * While `allowWrites` is off, every GraphQL mutation — issue edits, comments,
 * creations, attachments, archives, relations, webhook registration, all of
 * it — is refused with one sentence that names the remedy. Reads are
 * untouched: the mirror fills, the panel renders, search answers. (It ships
 * on; turning it off is the owner's one-flip way to let the plugin observe a
 * workspace it must not touch.)
 *
 * The guarantee is structural, not disciplinary. Every mutation the plugin
 * can ever send is a document in `src/linear/documents.ts` with
 * `kind: "mutation"`, and every document goes to Linear through one
 * transport, and the transport consults this gate before a mutation leaves
 * the machine. A new tool, CLI command, rpc handler or automation added next
 * year is gated the day it is written, because there is no second path out.
 * (`test/write-gate.test.ts` walks the whole document registry to prove it.)
 *
 * Two deliberate scope decisions:
 *
 * - **Local state is never gated.** Thread↔issue links, project bindings,
 *   inbox seen/dismiss, sort preferences — bb's own tables, never Linear's.
 *   Gating them would break reading workflows to protect nothing.
 * - **The gate fails closed.** A consent check that throws refuses the write.
 *   "The settings read broke, so the write went through" is not a sentence
 *   anyone should ever have to say.
 */

import type { LinearDocument } from "./linear/documents.js";
import { refused } from "./linear/errors.js";
import type { MutationVerdict } from "./linear/transport.js";
import type { AgentWrites, LinearSettings } from "./settings.js";

/** The one remedy sentence, written once so every surface quotes the same
 *  command and a test can pin it. */
export const WRITE_CONSENT_REMEDY =
  "Writes to Linear are off. Reads work; every change is refused until you allow it — turn on \"Allow changes to Linear\" in this plugin's settings, or run: bb plugin config linear set allowWrites true";

/** True only for an explicit true. `undefined` (older install, unparseable
 *  row) reads as **no consent** — absence of an answer is not a yes. */
export function writesAllowed(settings: Pick<LinearSettings, "allowWrites">): boolean {
  return settings.allowWrites === true;
}

export type { MutationVerdict } from "./linear/transport.js";

/**
 * The transport asks this before a mutation leaves the machine. Queries are
 * always allowed — that is what "reads are untouched" means, and a gate that
 * could refuse a read would make consent look like an outage.
 */
export function mutationVerdict(
  document: Pick<LinearDocument, "kind" | "name">,
  allowWrites: boolean,
): MutationVerdict {
  if (document.kind !== "mutation") return { allowed: true };
  if (allowWrites) return { allowed: true };
  return { allowed: false, refusal: refused(WRITE_CONSENT_REMEDY) };
}

/**
 * What agents may do once the master switch has had its say.
 *
 * Withheld rather than degraded, per the house rule: with writes disallowed,
 * agents are not even OFFERED comment or write tools — a tool that exists
 * only to be refused teaches a model to stop trusting tools. `agentWrites`
 * then narrows further among consenting installs.
 */
export function effectiveAgentWrites(
  allowWrites: boolean,
  configured: AgentWrites,
): AgentWrites {
  return allowWrites ? configured : "off";
}
