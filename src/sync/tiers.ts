import type { SyncProfile } from "../settings.js";

/**
 * How often to poll, and why.
 *
 * Every number here carries its reason. The arithmetic that matters: a
 * personal API key gets **2,500 requests per hour**, and the worst realistic
 * steady state is Hot at 10 s (360/hr) plus the inbox at 30 s (120/hr) — 480
 * of 2,500, about 19 %. That leaves room for mutations, panel interactions and
 * a second machine on the same account, which is the actual design constraint:
 * a plugin that consumes its user's whole budget by existing is a plugin that
 * breaks their other tools.
 *
 * `nextInterval` is pure. The service is a loop around it.
 */

export type Tier = "hot" | "foreground" | "warm" | "cold";

export interface TierIntervals {
  /** The floor a tier decays from. */
  readonly floor: number;
  /** The ceiling it decays to when nothing changes. */
  readonly ceiling: number;
}

/** The `balanced` profile. `responsive` halves every number, `frugal` doubles
 *  them — one multiplier rather than three tables, so the relationships
 *  between tiers survive the choice. */
export const BALANCED: Record<Tier, TierIntervals> = {
  // A thread is running on a linked issue, or a local mutation landed in the
  // last two minutes. Somebody is watching this issue right now.
  hot: { floor: 10_000, ceiling: 10_000 },
  // The panel is on screen. It decays because a panel left open on a second
  // monitor is not the same as a panel being read.
  foreground: { floor: 20_000, ceiling: 60_000 },
  // A binding exists and nothing is on screen.
  warm: { floor: 120_000, ceiling: 120_000 },
  // No frontend connected, or half an hour with nothing changing.
  cold: { floor: 600_000, ceiling: 600_000 },
};

/** The notification feed runs on its own clock, independent of the tiers
 *  above: a notification is worth knowing about whether or not the panel is
 *  open. */
export const INBOX: TierIntervals = { floor: 30_000, ceiling: 300_000 };

const PROFILE_MULTIPLIER: Record<SyncProfile, number> = {
  responsive: 0.5,
  balanced: 1,
  frugal: 2,
};

/** A local mutation keeps the poller hot for two minutes, which is long
 *  enough to catch the server-side automations a write can trigger — workflow
 *  rules, SLA recalculation, auto-assignment — without pinning the tier to a
 *  click somebody made and walked away from. */
export const MUTATION_HOT_WINDOW_MS = 120_000;

/** Half an hour of nothing changing means nothing is happening, whatever the
 *  panel is doing. */
export const QUIET_TO_COLD_MS = 1_800_000;

/** How recently the panel must have asked for data to count as visible. Two
 *  poll intervals' worth, so a single slow render does not drop the tier. */
export const PANEL_VISIBLE_WINDOW_MS = 45_000;

/** And how recently *any* frontend must have asked, for the plugin to believe
 *  somebody has bb open at all. */
export const FRONTEND_WINDOW_MS = 300_000;

export interface TierInput {
  readonly now: number;
  /** Whether any thread linked to a Linear issue is currently running. */
  readonly runningLinkedThread: boolean;
  /** When this plugin last wrote something to Linear. */
  readonly lastMutationAt: number | null;
  /** When a surface last asked for panel data. The rpc call *is* the
   *  visibility signal — no second channel to keep in step, and true by
   *  construction. */
  readonly lastPanelReadAt: number | null;
  /** When any of this plugin's surfaces last asked for anything. */
  readonly lastFrontendReadAt: number | null;
  readonly hasBinding: boolean;
  /** When the mirror last actually changed. */
  readonly lastChangeAt: number | null;
  /** How many ticks in a row have found nothing. Drives the decay. */
  readonly quietTicks: number;
}

export function currentTier(input: TierInput): Tier {
  if (!input.hasBinding) return "cold";

  const mutatedRecently =
    input.lastMutationAt !== null && input.now - input.lastMutationAt < MUTATION_HOT_WINDOW_MS;
  if (input.runningLinkedThread || mutatedRecently) return "hot";

  const frontendHere =
    input.lastFrontendReadAt !== null && input.now - input.lastFrontendReadAt < FRONTEND_WINDOW_MS;
  if (!frontendHere) return "cold";

  // Half an hour with nothing changing is cold even with the panel open: the
  // panel being on a second monitor is not a reason to keep asking.
  const quiet =
    input.lastChangeAt !== null && input.now - input.lastChangeAt > QUIET_TO_COLD_MS;
  if (quiet) return "cold";

  const panelHere =
    input.lastPanelReadAt !== null && input.now - input.lastPanelReadAt < PANEL_VISIBLE_WINDOW_MS;
  return panelHere ? "foreground" : "warm";
}

export interface Cadence {
  readonly tier: Tier;
  /** Milliseconds to wait before the next tick, jitter included. */
  readonly delayMs: number;
  /** The same number before jitter, so a test can assert on the decision
   *  rather than on the noise. */
  readonly baseMs: number;
}

/**
 * Decay, and the rule that makes it safe: **any observed change resets to the
 * floor.**
 *
 * An unchanged tick multiplies the delay toward the tier's ceiling, so a quiet
 * afternoon costs a fraction of a busy one. Without the reset, a poller that
 * has decayed to a minute takes a minute to notice that things started
 * happening again — which is exactly when it matters.
 */
export function nextInterval(
  input: TierInput,
  profile: SyncProfile,
  random: () => number = Math.random,
): Cadence {
  const tier = currentTier(input);
  const intervals = BALANCED[tier];
  const multiplier = PROFILE_MULTIPLIER[profile];

  // Doubling per quiet tick, capped at the ceiling. Two quiet ticks is not a
  // pattern; ten is.
  const decayed = Math.min(
    intervals.ceiling,
    intervals.floor * Math.pow(2, Math.max(0, input.quietTicks)),
  );
  const baseMs = Math.round(decayed * multiplier);

  return { tier, baseMs, delayMs: jitter(baseMs, random) };
}

/**
 * ±10 % on every interval.
 *
 * Two bb hosts signed into one Linear account would otherwise align their
 * polls forever — they start within seconds of each other and share a fixed
 * period — and spend the whole budget in synchronised bursts rather than
 * spread out.
 */
export function jitter(ms: number, random: () => number = Math.random): number {
  const spread = ms * 0.1;
  return Math.max(1_000, Math.round(ms - spread + random() * spread * 2));
}

export function inboxInterval(
  input: { readonly quietTicks: number },
  profile: SyncProfile,
  random: () => number = Math.random,
): number {
  const decayed = Math.min(INBOX.ceiling, INBOX.floor * Math.pow(2, Math.max(0, input.quietTicks)));
  return jitter(Math.round(decayed * PROFILE_MULTIPLIER[profile]), random);
}
