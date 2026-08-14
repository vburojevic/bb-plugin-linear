import { governBackgroundInterval, type BudgetSnapshot } from "../linear/budget.js";
import { describeError, isLinearError } from "../linear/errors.js";
import type { LinearClient } from "../linear/client.js";
import type { TickResult } from "../linear/types.js";
import type { Store } from "../store/store.js";
import { applyIssues } from "./apply.js";
import { BALANCED, nextInterval, type Cadence, type TierInput } from "./tiers.js";
import { DISCARDED_TICK, planTick, type TickOutcome } from "./tick.js";
import { advanceWatermark } from "./watermark.js";
import { parseInstant } from "../format.js";
import type { CommentRow } from "../store/rows.js";
import type { SyncProfile } from "../settings.js";

/**
 * One tick, start to finish.
 *
 * Separated from the loop so the interesting behaviour — what gets written,
 * what the watermarks become, what happens when a tick times out — is testable
 * against an in-memory store and a fake client, with no timers involved.
 */

export interface TickDeps {
  readonly client: LinearClient;
  readonly store: Store;
  readonly now: () => number;
  readonly log?: (level: "debug" | "info" | "warn", message: string) => void;
  readonly signal?: AbortSignal;
}

export interface TickInput {
  readonly teamIds: readonly string[];
  readonly issuesWatermark: number;
  readonly commentsWatermark: number;
  readonly tickNumber: number;
}

export async function runTick(deps: TickDeps, input: TickInput): Promise<TickOutcome> {
  if (input.teamIds.length === 0) return DISCARDED_TICK;

  const plan = planTick({
    teamIds: input.teamIds,
    issuesSince: new Date(input.issuesWatermark).toISOString(),
    commentsSince: new Date(input.commentsWatermark).toISOString(),
    tickNumber: input.tickNumber,
  });

  let result: TickResult;
  try {
    result = await deps.client.tick(plan.variables, { initiator: "background" });
  } catch (error) {
    // A timeout, a dropped connection, a rate limit. The partial result — if
    // there even is one — is thrown away and the next tick retries from the
    // unchanged watermark. Writing a hollow snapshot as truth is how a panel
    // ends up confidently wrong.
    deps.log?.("debug", `Tick failed, discarding: ${describeError(error)}`);
    if (isLinearError(error)) throw error;
    return DISCARDED_TICK;
  }

  if (deps.signal?.aborted) return DISCARDED_TICK;

  const at = deps.now();
  const issues = applyIssues(deps.store, result.issues.nodes, at);

  const comments: CommentRow[] = result.comments.nodes.map((node) => ({
    id: node.id,
    issueId: node.issue?.id ?? "",
    userId: node.user?.id ?? null,
    parentId: node.parent?.id ?? null,
    body: node.body,
    url: node.url,
    createdAt: parseInstant(node.createdAt),
    updatedAt: parseInstant(node.updatedAt) ?? at,
    editedAt: parseInstant(node.editedAt),
    resolvedAt: parseInstant(node.resolvedAt),
  }));
  // A comment whose issue is not in the mirror belongs to something outside
  // the backfill window. Dropping it is better than writing an orphan the
  // detail pane can never show.
  const attached = comments.filter(
    (comment) => comment.issueId !== "" && deps.store.issue(comment.issueId) !== null,
  );
  deps.store.putComments(attached);

  let newestComment: number | null = null;
  for (const comment of attached) {
    if (newestComment === null || comment.updatedAt > newestComment) {
      newestComment = comment.updatedAt;
    }
  }

  return {
    applied: true,
    issuesWritten: issues.written,
    commentsWritten: attached.length,
    changed: issues.written > 0 || attached.length > 0,
    issuesWatermark: advanceWatermark(input.issuesWatermark, {
      newestUpdatedAt: issues.newestUpdatedAt,
      complete: !result.issues.pageInfo.hasNextPage,
    }),
    commentsWatermark: advanceWatermark(input.commentsWatermark, {
      newestUpdatedAt: newestComment,
      complete: !result.comments.pageInfo.hasNextPage,
    }),
    issuesComplete: !result.issues.pageInfo.hasNextPage,
    commentsComplete: !result.comments.pageInfo.hasNextPage,
  };
}

/**
 * How long to wait, once the tier and the budget have both had their say.
 *
 * The tier decides urgency; the governor may only slow it down. Below 20 % of
 * the request budget it clamps to the Warm ceiling, below 5 % to Cold, and an
 * **unknown** budget clamps to Warm — which is the stated mitigation for the
 * one rate-limiting fact that could not be verified offline. If a header ever
 * disappears, the plugin gets slower, not louder.
 */
export function cadenceFor(
  input: TierInput,
  profile: SyncProfile,
  budget: BudgetSnapshot | null,
  pressure: (snapshot: BudgetSnapshot | null) => "unknown" | "healthy" | "low" | "critical",
  random?: () => number,
): Cadence {
  const cadence = nextInterval(input, profile, random);
  const governed = governBackgroundInterval(cadence.baseMs, pressure(budget), {
    warm: BALANCED.warm.floor,
    cold: BALANCED.cold.floor,
  });
  return governed === cadence.baseMs
    ? cadence
    : { ...cadence, baseMs: governed, delayMs: governed };
}
