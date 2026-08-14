import { z } from "zod";

/**
 * Sync cursors, and the two rules that keep them honest.
 *
 * **The watermark is Linear's own timestamp, never the local clock.** A
 * machine whose clock runs three seconds fast against Linear's skips three
 * seconds of changes on every tick, forever, silently — and nobody notices
 * until an issue that definitely moved is definitely not in the panel.
 *
 * **Checkpoint to the NEWEST `updatedAt` in a completed walk, minus an
 * overlap** — and do not move at all on an incomplete one.
 *
 * The earlier rule here was "checkpoint to the oldest", reasoning that
 * checkpointing to the newest skips whatever a crash mid-walk had not
 * reached. That reasoning is sound, but it describes the *incomplete* case,
 * which this function already handles by refusing to move. In the only branch
 * where the oldest was actually used — a walk that read everything newer than
 * the cursor — it was a permanent pin: the next query returns the same rows,
 * whose oldest is the same value, so the cursor never advances again while
 * the matching set grows without bound. Two independent audits found this;
 * the notification lane next door had always used the newest, correctly.
 *
 * The overlap stays, and is still necessary: `orderBy: updatedAt` with cursor
 * pagination genuinely drifts when rows mutate mid-walk. It is free because
 * every write is an upsert by `id`.
 */

/** Sixty seconds of deliberate re-reading. Costs one page occasionally;
 *  prevents a silent gap permanently. */
export const WATERMARK_OVERLAP_MS = 60_000;

export const watermarkSchema = z.object({
  v: z.literal(1),
  /** Epoch milliseconds, from Linear's own `updatedAt`. */
  at: z.number(),
});
export type Watermark = z.infer<typeof watermarkSchema>;

export interface PageOutcome {
  /** The newest `updatedAt` in the walk just applied, or `null` for an empty
   *  page. This is the checkpoint on a complete walk. */
  readonly newestUpdatedAt: number | null;
  /** Whether the walk finished. A partial walk must not advance the cursor
   *  past what it actually read. */
  readonly complete: boolean;
}

/**
 * The next watermark, or the current one unchanged.
 *
 * Never moves backwards and never moves on an incomplete walk. Both are
 * deliberate: a watermark that moves backwards re-reads forever, and one that
 * moves on a partial walk loses whatever the walk did not reach.
 */
export function advanceWatermark(current: number, outcome: PageOutcome): number {
  if (!outcome.complete) return current;
  if (outcome.newestUpdatedAt === null) return current;
  const candidate = outcome.newestUpdatedAt - WATERMARK_OVERLAP_MS;
  return Math.max(current, candidate);
}

/**
 * What to send as the `updatedAt: { gt: … }` filter.
 *
 * A watermark of zero means "never synced", and the caller decides what that
 * means — a backfill, not a query for everything since 1970.
 */
export function sinceFor(watermark: number): string | null {
  return watermark <= 0 ? null : new Date(watermark).toISOString();
}
