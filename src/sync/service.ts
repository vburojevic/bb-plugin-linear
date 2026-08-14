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

  /*
   * One tick may walk several pages.
   *
   * A single page was a terminal state, not a pause: the watermark refuses to
   * advance on an incomplete walk (correctly — everything unread lies behind
   * it), so a burst bigger than one page meant `hasNextPage` stayed true and
   * the cursor never moved again. Following the cursor is what turns "there is
   * more" into "then read the rest".
   *
   * Bounded, because a tick is background work sharing an hourly request
   * budget with the person clicking: past the cap the walk stops, stays
   * incomplete, keeps its watermark, and resumes on the next tick with the
   * same cursor semantics. Progress every tick, never an unbounded one.
   */
  const at = deps.now();
  let issuesAfter: string | null = null;
  let commentsAfter: string | null = null;
  let issuesComplete = false;
  let commentsComplete = false;
  let issuesWritten = 0;
  let commentsWritten = 0;
  let newestIssue: number | null = null;
  let newestComment: number | null = null;

  for (let page = 0; page < TICK_PAGE_LIMIT; page += 1) {
    let result: TickResult;
    try {
      result = await deps.client.tick(
        {
          ...plan.variables,
          // A connection that already finished is asked for nothing more; its
          // cursor sits at the end and returns an empty page.
          issuesAfter,
          commentsAfter,
        },
        { initiator: "background" },
      );
    } catch (error) {
      // A timeout, a dropped connection, a rate limit. The partial result — if
      // there even is one — is thrown away. Pages already applied stay (every
      // write is an upsert), but the walk is incomplete, so the watermark does
      // not move and the next tick re-reads from the same place.
      deps.log?.("debug", `Tick failed, discarding: ${describeError(error)}`);
      if (isLinearError(error)) throw error;
      return page === 0 ? DISCARDED_TICK : partialTick(issuesWritten, commentsWritten, input);
    }

    if (deps.signal?.aborted) {
      return page === 0 ? DISCARDED_TICK : partialTick(issuesWritten, commentsWritten, input);
    }

    const pageIssues = applyIssues(deps.store, result.issues.nodes, at);
    issuesWritten += pageIssues.written;
    if (
      pageIssues.newestUpdatedAt !== null &&
      (newestIssue === null || pageIssues.newestUpdatedAt > newestIssue)
    ) {
      newestIssue = pageIssues.newestUpdatedAt;
    }

    const applied = applyCommentPage(deps, result, at);
    commentsWritten += applied.written;
    if (applied.newest !== null && (newestComment === null || applied.newest > newestComment)) {
      newestComment = applied.newest;
    }

    issuesComplete = !result.issues.pageInfo.hasNextPage;
    commentsComplete = !result.comments.pageInfo.hasNextPage;
    if (issuesComplete && commentsComplete) break;

    issuesAfter = result.issues.pageInfo.endCursor ?? issuesAfter;
    commentsAfter = result.comments.pageInfo.endCursor ?? commentsAfter;
    // A cursor that does not move would spin this loop against the budget.
    if (!issuesComplete && result.issues.pageInfo.endCursor === null) break;
    if (!commentsComplete && result.comments.pageInfo.endCursor === null) break;
  }

  return {
    applied: true,
    issuesWritten,
    commentsWritten,
    changed: issuesWritten > 0 || commentsWritten > 0,
    issuesWatermark: advanceWatermark(input.issuesWatermark, {
      newestUpdatedAt: newestIssue,
      complete: issuesComplete,
    }),
    commentsWatermark: advanceWatermark(input.commentsWatermark, {
      newestUpdatedAt: newestComment,
      complete: commentsComplete,
    }),
    issuesComplete,
    commentsComplete,
  };
}

/** How many pages one tick may walk. Five pages is 500 issues of change in a
 *  single tick — far past a normal interval's churn, and a hard ceiling on
 *  what background work can spend in one pass. */
export const TICK_PAGE_LIMIT = 5;

/** A walk that stopped early: the rows already applied are kept, but neither
 *  watermark moves, so the next tick re-reads from the same place. */
function partialTick(
  issuesWritten: number,
  commentsWritten: number,
  input: TickInput,
): TickOutcome {
  return {
    applied: true,
    issuesWritten,
    commentsWritten,
    changed: issuesWritten > 0 || commentsWritten > 0,
    issuesWatermark: input.issuesWatermark,
    commentsWatermark: input.commentsWatermark,
    issuesComplete: false,
    commentsComplete: false,
  };
}

function applyCommentPage(
  deps: TickDeps,
  result: TickResult,
  at: number,
): { written: number; newest: number | null } {
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
  const mirroredIssueIds = new Set(
    deps.store
      .issuesByIds(
        comments
          .map((comment) => comment.issueId)
          .filter((id): id is string => id !== ""),
      )
      .map((issue) => issue.id),
  );
  const attached = comments.filter(
    (comment) => comment.issueId !== "" && mirroredIssueIds.has(comment.issueId),
  );
  deps.store.putComments(attached);

  let newest: number | null = null;
  for (const comment of attached) {
    if (newest === null || comment.updatedAt > newest) newest = comment.updatedAt;
  }

  return { written: attached.length, newest };
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
