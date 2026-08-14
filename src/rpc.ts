/**
 * The rpc surface this plugin currently ships.
 *
 * Deliberately slim: the old panel's 24-method contract was cut with the
 * panel, and each new surface adds its methods here as it lands —
 * schema-first, so the wire boundary is validated in both directions from
 * day one. Detail shapes are reused from `contract.ts` rather than re-drawn,
 * because the projections that build them (`select/detail.ts`) are shared.
 */

import { z } from "zod";
import {
  rpcContract as legacyContract,
  stateOptionSchema,
  toneSchema,
} from "./contract.js";
import { defineRpcContract } from "./sdk-runtime.js";

/** What the header chip and the side panel both know about a thread. */
export const threadIssueSchema = z.object({
  /** The bound issue, or null when the thread is unbound. */
  binding: z
    .object({
      issueId: z.string(),
      identifier: z.string(),
      title: z.string(),
      stateName: z.string(),
      tone: toneSchema,
      url: z.string().nullable(),
      /** How the binding was made — shown so trust is inspectable. */
      origin: z.enum(["spawn", "manual", "branch", "message"]),
      stateOptions: z.array(stateOptionSchema),
    })
    .nullable(),
  /** The fuzzy rung's candidate, or null. Never set while bound. */
  suggestion: z
    .object({
      issueId: z.string(),
      identifier: z.string(),
      title: z.string(),
    })
    .nullable(),
});
export type ThreadIssue = z.infer<typeof threadIssueSchema>;

export const serverRpcContract = defineRpcContract({
  /** The settings card and homepage section: who is connected, per slot. */
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      accounts: z.array(
        z.object({
          slot: z.string(),
          label: z.string(),
          orgName: z.string().nullable(),
          orgUrlKey: z.string().nullable(),
          displayName: z.string().nullable(),
          error: z.string().nullable(),
        }),
      ),
    }),
  },

  /* ── M3: the thread's issue ──────────────────────────────────────────── */

  threadIssue: {
    input: z.object({ threadId: z.string() }),
    output: threadIssueSchema,
  },

  /** Bind manually (issueId set) or unbind (issueId null). Accepting a
   *  suggestion routes through here too — the accept click IS a manual
   *  binding, and its provenance says so. */
  bindThread: {
    input: z.object({ threadId: z.string(), issueId: z.string().nullable() }),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  /* ── The issue pane, on the legacy shapes ────────────────────────────── */
  /*
   * Lifted verbatim from the predecessor's contract so its Detail and
   * Editors components port unchanged: same method names, same schemas, same
   * undefined-means-untouched / null-means-clear patch semantics, same
   * add/remove label discipline (never a replacement set).
   */
  issue: legacyContract.issue,
  updateIssue: legacyContract.updateIssue,
  editorOptions: legacyContract.editorOptions,
  comment: legacyContract.comment,
});
