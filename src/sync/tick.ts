import { estimateComplexity, SELF_IMPOSED_COMPLEXITY_BUDGET } from "../linear/complexity.js";
import { TICK, TICK_COMMENT_PAGE_SIZE, TICK_ISSUE_PAGE_SIZE } from "../linear/documents.js";

/**
 * Deciding what one tick asks for.
 *
 * Everything here is pure. The service is the loop; this is the arithmetic it
 * runs first.
 */

/**
 * Split bound teams across alternating ticks when one tick would cost too
 * much.
 *
 * **Sharding rather than a longer interval**, deliberately. Raising the
 * interval makes a forty-team organisation *slower*; sharding makes it cost
 * twice as many requests at the same latency, and the budget absorbs that —
 * 480 of 2,500 becomes 960 of 2,500, which is still under 40 %.
 *
 * The shards are deterministic (a rotating window over a sorted list) rather
 * than random, so a team is never starved by luck and the sequence is
 * reproducible in a test.
 */
export function shardTeams(
  teamIds: readonly string[],
  shardCount: number,
  tickNumber: number,
): string[] {
  if (shardCount <= 1 || teamIds.length <= 1) return [...teamIds];
  const sorted = [...teamIds].sort();
  const size = Math.ceil(sorted.length / shardCount);
  const shard = ((tickNumber % shardCount) + shardCount) % shardCount;
  return sorted.slice(shard * size, shard * size + size);
}

export interface TickPlan {
  readonly teamIds: readonly string[];
  /** How many shards the full bound set was split into. 1 means no split. */
  readonly shardCount: number;
  readonly estimatedComplexity: number;
  readonly variables: Record<string, unknown>;
}

/**
 * Build one tick, splitting it if the estimate says it will not fit.
 *
 * The estimate is against this plugin's own 8,000-point budget rather than
 * Linear's 10,000-point ceiling, and the gap is the point: the document is
 * built from a **live team list**, so a tick that fits today stops fitting on
 * the day somebody binds another team. Sharding at 8,000 keeps that headroom
 * permanently instead of discovering it in production.
 */
export function planTick(input: {
  readonly teamIds: readonly string[];
  readonly issuesSince: string;
  readonly commentsSince: string;
  readonly tickNumber: number;
}): TickPlan {
  const variablesFor = (teamIds: readonly string[]): Record<string, unknown> => ({
    teamIds: [...teamIds],
    issuesSince: input.issuesSince,
    commentsSince: input.commentsSince,
    issues: TICK_ISSUE_PAGE_SIZE,
    comments: TICK_COMMENT_PAGE_SIZE,
  });

  // The document's shape does not change with the team count — the team ids
  // travel as a variable — so the estimate is the same for one team and forty.
  // Sharding is therefore driven by the *page sizes*, and the cost is computed
  // once.
  const estimate = estimateComplexity(TICK.source, TICK.pageSizes ?? {});

  let shardCount = 1;
  while (
    estimate > SELF_IMPOSED_COMPLEXITY_BUDGET &&
    shardCount < input.teamIds.length &&
    shardCount < 8
  ) {
    shardCount += 1;
  }

  const teamIds = shardTeams(input.teamIds, shardCount, input.tickNumber);
  return {
    teamIds,
    shardCount,
    estimatedComplexity: estimate,
    variables: variablesFor(teamIds),
  };
}

/**
 * A tick that timed out is **discarded, not committed**.
 *
 * Writing a hollow snapshot as truth is how a panel ends up confidently wrong:
 * half a page applied, the watermark advanced past what was never read, and no
 * error anywhere. The next tick retries from the unchanged watermark, which
 * costs one request.
 */
export interface TickOutcome {
  readonly applied: boolean;
  readonly issuesWritten: number;
  readonly commentsWritten: number;
  readonly changed: boolean;
  readonly issuesWatermark: number | null;
  readonly commentsWatermark: number | null;
  readonly issuesComplete: boolean;
  readonly commentsComplete: boolean;
}

export const DISCARDED_TICK: TickOutcome = {
  applied: false,
  issuesWritten: 0,
  commentsWritten: 0,
  changed: false,
  issuesWatermark: null,
  commentsWatermark: null,
  issuesComplete: false,
  commentsComplete: false,
};
