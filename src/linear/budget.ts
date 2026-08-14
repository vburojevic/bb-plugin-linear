/**
 * Rate-limit accounting, and the governor that spends it.
 *
 * Requests are the scarce resource, not complexity: a personal API key gets
 * **2,500 requests per hour** against **3,000,000 complexity points**
 * (verified — see `docs/verified.md`), so a tick that batches four queries
 * into one aliased document costs a quarter as much of the thing that runs
 * out. Everything in this file exists to keep the plugin's *background* work
 * inside a fraction of that budget, and to let a person's click through
 * anyway right up until the moment it would actually fail.
 *
 * Every function here is pure. The mutable part is `createBudgetTracker`,
 * which is a single-value store and nothing more.
 */

/** Anything with a case-insensitive `get`. `Headers` satisfies it; so does a
 *  plain object wrapper in a test, which is why it is not typed as `Headers`. */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface BudgetBucket {
  readonly limit: number | null;
  readonly remaining: number | null;
  /** Epoch milliseconds, or null when Linear did not say. */
  readonly resetAt: number | null;
}

export interface BudgetSnapshot {
  /** Epoch milliseconds the snapshot was taken. */
  readonly at: number;
  readonly requests: BudgetBucket;
  readonly complexity: BudgetBucket;
  /** Some operations carry their own, much lower ceiling — Linear's search
   *  endpoints are documented at 30 requests per minute, independent of the
   *  hourly budget. `name` is the bucket key. */
  readonly endpoint: BudgetBucket & { readonly name: string | null };
  /** What the request that produced this snapshot actually cost. */
  readonly lastComplexity: number | null;
}

/**
 * Read a reset value without inventing one.
 *
 * Linear documents the header *names* but not the encoding of their values,
 * and the three plausible encodings are indistinguishable by name alone. All
 * three are accepted, disambiguated by magnitude: anything past the year 2001
 * in milliseconds is milliseconds, anything past 2001 in seconds is seconds,
 * and a small positive number is a delta. An unparseable value yields `null`,
 * which the rest of the plugin reads as "unknown" — a state it already has to
 * handle — rather than a reset time that is silently 55 years in the past.
 */
export function parseResetAt(raw: string | null, now: number): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    if (numeric >= 1e12) return Math.round(numeric); // epoch milliseconds
    if (numeric >= 1e9) return Math.round(numeric * 1000); // epoch seconds
    return now + Math.round(numeric * 1000); // seconds from now
  }

  // An HTTP-date or ISO-8601 string. `Date.parse` returns NaN rather than
  // throwing, so this cannot become an exception on an unfamiliar format.
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNumber(headers: HeaderReader, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

function readBucket(headers: HeaderReader, prefix: string, now: number): BudgetBucket {
  return {
    limit: readNumber(headers, `${prefix}-Limit`),
    remaining: readNumber(headers, `${prefix}-Remaining`),
    resetAt: parseResetAt(headers.get(`${prefix}-Reset`), now),
  };
}

/**
 * Every response feeds this, success or failure — a 400 carrying `RATELIMITED`
 * is precisely the response whose headers matter most, and a parser that only
 * runs on the happy path never sees it.
 *
 * Returns `null` when nothing recognisable is present. That is a real state,
 * not an error: the governor reads it as *unknown budget* and drops to the
 * conservative cadence rather than assuming headroom it cannot see.
 */
export function parseBudgetHeaders(headers: HeaderReader, now: number): BudgetSnapshot | null {
  const requests = readBucket(headers, "X-RateLimit-Requests", now);
  const complexity = readBucket(headers, "X-RateLimit-Complexity", now);
  const endpointBucket = readBucket(headers, "X-RateLimit-Endpoint-Requests", now);
  const endpointName = headers.get("X-RateLimit-Endpoint-Name");
  const lastComplexity = readNumber(headers, "X-Complexity");

  const sawAnything =
    requests.limit !== null ||
    requests.remaining !== null ||
    complexity.limit !== null ||
    complexity.remaining !== null ||
    endpointBucket.limit !== null ||
    endpointBucket.remaining !== null ||
    endpointName !== null ||
    lastComplexity !== null;
  if (!sawAnything) return null;

  return {
    at: now,
    requests,
    complexity,
    endpoint: { ...endpointBucket, name: endpointName?.trim() || null },
    lastComplexity,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The governor                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export type BudgetPressure = "unknown" | "healthy" | "low" | "critical";

/** Below this fraction remaining, background polling clamps to the Warm
 *  ceiling: enough headroom left for a working day of clicks. */
export const LOW_BUDGET_FRACTION = 0.2;
/** Below this, background polling clamps to Cold. The remaining 5 % of 2,500
 *  is ~125 requests — roughly an hour of ordinary interactive use. */
export const CRITICAL_BUDGET_FRACTION = 0.05;
/** Below this, even a person's click is refused, with the reset time named.
 *  2 % leaves ~50 requests, which is the margin that lets the *next* thing the
 *  user does still work. */
export const USER_FLOOR_FRACTION = 0.02;

function fractionRemaining(bucket: BudgetBucket): number | null {
  if (bucket.limit === null || bucket.remaining === null) return null;
  if (bucket.limit <= 0) return null;
  return Math.max(0, Math.min(1, bucket.remaining / bucket.limit));
}

/**
 * The worst of the three buckets wins.
 *
 * A healthy hourly request budget is no comfort when the complexity budget is
 * nearly gone, and the endpoint bucket — 30 per minute on search — empties in
 * seconds while the other two look fine. Reading only `requests` is how a
 * search-heavy minute turns into a wall of failures the poller cannot explain.
 */
export function budgetPressure(snapshot: BudgetSnapshot | null): BudgetPressure {
  if (snapshot === null) return "unknown";
  const fractions = [
    fractionRemaining(snapshot.requests),
    fractionRemaining(snapshot.complexity),
    fractionRemaining(snapshot.endpoint),
  ].filter((value): value is number => value !== null);
  if (fractions.length === 0) return "unknown";
  const worst = Math.min(...fractions);
  if (worst < CRITICAL_BUDGET_FRACTION) return "critical";
  if (worst < LOW_BUDGET_FRACTION) return "low";
  return "healthy";
}

export interface CadenceCeilings {
  /** The Warm tier's interval, in milliseconds. */
  readonly warm: number;
  /** The Cold tier's interval, in milliseconds. */
  readonly cold: number;
}

/**
 * Clamp a background interval to what the budget can afford.
 *
 * Never *shortens* an interval — `Math.max` throughout — because the tier
 * calculation already decided how urgent this poll is, and the governor's only
 * authority is to slow it down.
 *
 * The `unknown` case clamps to Warm rather than trusting the tier. That is the
 * mitigation for the one thing about rate limiting that could not be verified
 * offline: if a header ever disappears or changes name, the plugin gets slower,
 * not louder.
 */
export function governBackgroundInterval(
  base: number,
  pressure: BudgetPressure,
  ceilings: CadenceCeilings,
): number {
  switch (pressure) {
    case "critical":
      return Math.max(base, ceilings.cold);
    case "low":
    case "unknown":
      return Math.max(base, ceilings.warm);
    case "healthy":
      return base;
  }
}

export type UserRequestVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly resetAt: number | null };

/**
 * Discretionary background work yields first; the person's click yields last.
 *
 * An unknown budget allows the request. Refusing a click because telemetry is
 * missing would turn a header rename at Linear into a plugin that appears
 * broken, and the failure mode of being wrong here is one refused request with
 * a real error message — which the user was going to get anyway.
 */
export function allowUserRequest(snapshot: BudgetSnapshot | null): UserRequestVerdict {
  if (snapshot === null) return { allowed: true };
  const buckets = [snapshot.requests, snapshot.complexity, snapshot.endpoint];
  for (const bucket of buckets) {
    const fraction = fractionRemaining(bucket);
    if (fraction !== null && fraction < USER_FLOOR_FRACTION) {
      return { allowed: false, resetAt: bucket.resetAt };
    }
  }
  return { allowed: true };
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface BudgetTracker {
  record(snapshot: BudgetSnapshot | null): void;
  current(): BudgetSnapshot | null;
  pressure(): BudgetPressure;
}

/**
 * One snapshot, last writer wins.
 *
 * There is deliberately no history: the only questions anyone asks are "how
 * much is left" and "when does it refill", and both are answered by the most
 * recent response. A ring buffer here would be a chart nobody needs, kept warm
 * on every request.
 */
export function createBudgetTracker(initial: BudgetSnapshot | null = null): BudgetTracker {
  let snapshot = initial;
  return {
    record(next) {
      // A response with no headers must not erase a good snapshot: a proxy
      // error page carries no budget information but says nothing about the
      // budget either.
      if (next !== null) snapshot = next;
    },
    current: () => snapshot,
    pressure: () => budgetPressure(snapshot),
  };
}
