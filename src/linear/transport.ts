import { authHeader, type LinearCredential } from "./credential.js";
import {
  createBudgetTracker,
  parseBudgetHeaders,
  type BudgetSnapshot,
  type BudgetTracker,
} from "./budget.js";
import type { LinearDocument } from "./documents.js";
import {
  DETERMINISTIC_FAILURE_CODES,
  describeError,
  forbidden,
  isLinearError,
  LinearError,
  networkFailure,
  queryFailed,
  rateLimited,
  refused,
  rememberSecret,
  timedOut,
  unauthorized,
  type LinearGraphQLError,
} from "./errors.js";

/**
 * The only `fetch` in this repository, asserted by a test that greps `src/`
 * and requires exactly one hit, in this file.
 *
 * That is not tidiness for its own sake. Every request has to do four things
 * that are easy to do in three places and forget in the fourth: send the right
 * `Authorization` shape for the credential kind, record the rate-limit headers
 * whether it succeeded or failed, classify a rate limit that arrives as an
 * HTTP 400, and redact the key out of anything it throws. One choke point is
 * what makes all four unconditional.
 */

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The write-consent answer, shaped by the policy owner so the refusal
 *  carries its own remedy sentence rather than a generic apology. */
export type MutationVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: LinearError };

export interface TransportSession {
  /** Read fresh on every request, never captured. A key can be replaced while
   *  the plugin is running, and the request after the save must use the new
   *  one without a reload. */
  getCredential(): Promise<LinearCredential | null>;
  /**
   * Consulted before any `kind: "mutation"` document leaves the machine —
   * the single door every write passes through, which is what makes a
   * consent switch structural rather than per-call discipline. Read fresh
   * per request like the credential, so flipping consent takes effect on the
   * next write with no reload. Absent means no policy (this transport is
   * also test infrastructure); the plugin's server always installs one.
   *
   * A verdict that THROWS refuses the write. Fail closed: "the settings read
   * broke, so the write went through" must be unsayable.
   */
  gateMutation?(document: LinearDocument): MutationVerdict | Promise<MutationVerdict>;
  onBudget?(snapshot: BudgetSnapshot): void;
  log?(level: LogLevel, message: string): void;
  /** Aborts for the plugin's lifetime. */
  signal?: AbortSignal;
  now?(): number;
}

export interface TransportOptions {
  readonly endpoint?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly breakerThreshold?: number;
  readonly breakerCooldownMs?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ExecuteOptions {
  /** `user` work bypasses nothing in the transport, but it is what the caller
   *  above uses to decide whether the governor may refuse it, and it is worth
   *  carrying so a log line can say who was waiting. */
  readonly initiator?: "background" | "user";
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly variables?: Record<string, unknown>;
}

export interface BreakerView {
  readonly open: boolean;
  readonly openUntil: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface LinearTransport {
  execute<T>(document: LinearDocument, options?: ExecuteOptions): Promise<T>;
  budget(): BudgetSnapshot | null;
  breaker(): BreakerView;
}

/** Three consecutive deterministic failures, then a 60-second cooldown.
 *
 *  Three rather than one, because a single network blip is not an outage and
 *  refusing the next read would make a flaky wifi connection look like a
 *  broken plugin. Sixty seconds rather than exponential, because the states
 *  that trip it — a revoked key, a rate limit, a dead link — do not resolve
 *  faster than that and do not benefit from a growing wait; what they benefit
 *  from is a *predictable* one the UI can name. */
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;
/** One retry, after a short pause, for a genuinely transient failure. Long
 *  enough to outlast a dropped packet, short enough that a person waiting on a
 *  click does not read it as a hang. */
const DEFAULT_RETRY_DELAY_MS = 400;
/** Linear's slowest legitimate response is well under this. Past it, the
 *  answer is worth less than the lane it is occupying — the transport is
 *  single-flight, so a hung request stalls every other read behind it. */
const DEFAULT_TIMEOUT_MS = 20_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface GraphQLBody {
  data?: unknown;
  errors?: LinearGraphQLError[];
}

/** `extensions.code === "RATELIMITED"` is the only error code Linear
 *  documents, and it is the one that must never be mistaken for a permanent
 *  client error. Everything else is deliberately not switched on. */
function isRateLimitError(errors: readonly LinearGraphQLError[]): boolean {
  return errors.some((error) => {
    const code = error.extensions?.["code"];
    return typeof code === "string" && code.toUpperCase() === "RATELIMITED";
  });
}

export function createTransport(
  session: TransportSession,
  options: TransportOptions = {},
): LinearTransport {
  const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  const breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = () => session.now?.() ?? Date.now();
  const log = (level: LogLevel, message: string) => session.log?.(level, message);

  const budget: BudgetTracker = createBudgetTracker();

  /* ── Single flight, with priority ──────────────────────────────────────── */
  /*
   * One request in the air at a time.
   *
   * Concurrency multiplies burst risk against an hourly request budget and
   * buys nothing at this scale: the panel renders from SQLite and never waits
   * on Linear, so the only latency anyone perceives is a single click's round
   * trip. A queue also makes the budget arithmetic in `budget.ts` describe
   * reality — with four requests in flight, "remaining" is stale by up to four
   * requests exactly when it matters.
   *
   * **But the queue is not FIFO, and that is the whole point.** A person's
   * click must not wait behind a five-page backfill. Discretionary background
   * work yields first; the person's click yields last — the same rule the
   * governor follows, applied to the lane instead of to the cadence.
   *
   * Found live: `bb linear doctor` timed out against the bb CLI's own
   * two-second budget because its request had queued behind the first
   * backfill. Everything looked healthy; the command just never answered.
   */
  const waiting: { run: () => void; user: boolean }[] = [];
  let inFlight = false;

  function pump(): void {
    if (inFlight) return;
    // A user request anywhere in the queue goes next.
    const index = waiting.findIndex((entry) => entry.user);
    const next = index === -1 ? waiting.shift() : waiting.splice(index, 1)[0];
    if (next === undefined) return;
    inFlight = true;
    next.run();
  }

  function enqueue<T>(run: () => Promise<T>, user: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting.push({
        user,
        run: () => {
          run()
            .then(resolve, reject)
            .finally(() => {
              inFlight = false;
              pump();
            });
        },
      });
      pump();
    });
  }

  /* ── Circuit breaker (reads only) ──────────────────────────────────────── */
  let consecutiveFailures = 0;
  let openUntil = 0;
  let probing = false;
  let warned = false;
  let lastError: LinearError | null = null;

  function gateRead(): void {
    if (openUntil === 0) return;
    const at = now();
    if (at >= openUntil) {
      // The first call after the cooldown is the probe. Marking it
      // synchronously here — before anything can await — is what stops two
      // callers in the same tick from both probing.
      if (!probing) {
        probing = true;
        return;
      }
    }
    if (at < openUntil || probing) {
      // One warn per outage, debug thereafter. A log flood is itself a
      // performance failure and `bb plugin logs` rotates at 5 MB, so an
      // outage that lasts an afternoon must not be the reason a diagnostic
      // from this morning is gone.
      log("debug", `Linear reads are paused until the cooldown ends: ${lastErrorText()}`);
      throw (
        lastError ??
        networkFailure("Linear is unreachable and reads are paused for a moment.")
      );
    }
  }

  function lastErrorText(): string {
    return lastError === null ? "unknown failure" : lastError.message;
  }

  function noteSuccess(): void {
    if (openUntil !== 0) {
      log("info", "Linear is responding again.");
    }
    consecutiveFailures = 0;
    openUntil = 0;
    probing = false;
    warned = false;
    lastError = null;
  }

  function noteFailure(error: LinearError): void {
    probing = false;
    if (!DETERMINISTIC_FAILURE_CODES.has(error.code)) {
      // A query or mutation error means the connection is fine and the
      // request was wrong. Counting it toward an outage would open the
      // breaker on a bad issue id and take the panel down with it.
      consecutiveFailures = 0;
      return;
    }
    lastError = error;
    consecutiveFailures += 1;
    if (consecutiveFailures >= breakerThreshold) {
      openUntil = now() + breakerCooldownMs;
      if (!warned) {
        warned = true;
        log(
          "warn",
          `Linear failed ${consecutiveFailures} times in a row (${error.message}). Pausing reads for ${Math.round(breakerCooldownMs / 1000)}s.`,
        );
      }
    }
  }

  /* ── The request ───────────────────────────────────────────────────────── */

  async function once<T>(
    document: LinearDocument,
    options_: ExecuteOptions,
  ): Promise<T> {
    const credential = await session.getCredential();
    if (credential === null) {
      throw unauthorized("No Linear API key is set for this plugin.");
    }
    rememberSecret(
      credential.kind === "pat" ? credential.token : credential.accessToken,
    );

    const signals: AbortSignal[] = [AbortSignal.timeout(options_.timeoutMs ?? timeoutMs)];
    if (options_.signal) signals.push(options_.signal);
    if (session.signal) signals.push(session.signal);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: authHeader(credential),
        },
        body: JSON.stringify({
          query: document.source,
          variables: options_.variables ?? {},
          operationName: document.name,
        }),
        signal,
      });
    } catch (cause) {
      if (session.signal?.aborted) {
        throw networkFailure("The plugin was reloaded while a Linear request was in flight.");
      }
      if (isAbort(cause)) {
        throw timedOut(`Linear did not answer ${document.name} in time.`);
      }
      throw networkFailure(`Couldn't reach Linear: ${describeError(cause)}`, cause);
    }

    // Before anything else, and for every outcome. A 400 carrying
    // `RATELIMITED` is the single most valuable set of headers the plugin ever
    // receives, and a parser that only runs on success never sees it.
    const snapshot = parseBudgetHeaders(response.headers, now());
    if (snapshot !== null) {
      budget.record(snapshot);
      session.onBudget?.(snapshot);
    }

    const text = await response.text();

    if (response.status === 401) {
      throw unauthorized(
        "Linear rejected the API key — it may have been revoked or mistyped.",
      );
    }
    if (response.status === 403) {
      throw forbidden("Linear refused the request: this API key is not allowed to do that.");
    }

    let body: GraphQLBody;
    try {
      body = JSON.parse(text) as GraphQLBody;
    } catch {
      // A proxy error page, a maintenance splash, an empty 502. Transient
      // above 500, a real protocol problem below it — and a protocol problem
      // that repeats is exactly what the breaker is for, so it must not be
      // retried inline first.
      throw response.status >= 500
        ? networkFailure(`Linear returned HTTP ${response.status} and no JSON.`)
        : httpFailure(response.status, "and no JSON");
    }

    const errors = body.errors ?? [];
    if (errors.length > 0) {
      if (isRateLimitError(errors)) {
        // The reset comes from *this* response's headers — the failing one —
        // because that is the only response whose reset time describes the
        // limit that was just hit.
        const resetAt =
          snapshot?.endpoint.resetAt ??
          snapshot?.requests.resetAt ??
          snapshot?.complexity.resetAt ??
          null;
        throw rateLimited("Linear's request budget is used up for now.", resetAt);
      }
      throw queryFailed(errors, response.status);
    }

    if (response.status >= 400) {
      throw response.status >= 500
        ? networkFailure(`Linear returned HTTP ${response.status}.`)
        : httpFailure(response.status, "");
    }

    if (body.data === undefined || body.data === null) {
      throw networkFailure(`Linear answered ${document.name} with no data.`);
    }
    return body.data as T;
  }

  async function execute<T>(
    document: LinearDocument,
    options_: ExecuteOptions = {},
  ): Promise<T> {
    // Both gates run outside the queue so a refusal is instant rather than
    // waiting behind whatever is currently in flight — and a refusal spends
    // nothing: no queue slot, no budget, no breaker state.
    //
    // The breaker gates only reads (a person's write deserves to fail
    // honestly rather than be refused for an outage they did not cause);
    // consent gates only writes (a read refused by a consent switch would
    // make consent look like an outage).
    if (document.kind === "query") gateRead();
    if (document.kind === "mutation" && session.gateMutation !== undefined) {
      let verdict: MutationVerdict;
      try {
        verdict = await session.gateMutation(document);
      } catch (cause) {
        // Fail closed, and say which way it failed: this sentence is about a
        // broken consent CHECK, not about withheld consent.
        throw refused(
          `The write-consent check failed, so nothing was sent to Linear: ${describeError(cause)}`,
        );
      }
      if (!verdict.allowed) throw verdict.refusal;
    }

    return enqueue(async () => {
      let attempt = 0;
      for (;;) {
        try {
          const data = await once<T>(document, options_);
          if (document.kind === "query") noteSuccess();
          return data;
        } catch (error) {
          const linear = isLinearError(error)
            ? error
            : networkFailure(describeError(error), error);
          // Reads retry once on a transient failure. Mutations never do: they
          // are not idempotent unless the caller supplied a client-generated
          // id, and a blind retry of `issueCreate` is a duplicate issue.
          const canRetry =
            document.kind === "query" && linear.retryable && attempt === 0;
          if (canRetry) {
            attempt += 1;
            await sleep(retryDelayMs, session.signal);
            if (session.signal?.aborted) throw linear;
            continue;
          }
          if (document.kind === "query") noteFailure(linear);
          throw linear;
        }
      }
    }, (options_.initiator ?? "user") === "user");
  }

  return {
    execute,
    budget: () => budget.current(),
    breaker: () => ({
      open: openUntil > now(),
      openUntil,
      consecutiveFailures,
      lastError: lastError?.message ?? null,
    }),
  };
}

/** A 4xx that carried no GraphQL errors: the request is wrong in a way
 *  repeating it cannot fix, so it is classified as a connection failure for
 *  the breaker's purposes but never retried. */
function httpFailure(status: number, suffix: string): LinearError {
  const detail = suffix === "" ? "." : ` ${suffix}.`;
  return new LinearError("network", `Linear returned HTTP ${status}${detail}`, {
    retryable: false,
  });
}

function isAbort(value: unknown): boolean {
  return (
    value instanceof Error &&
    (value.name === "AbortError" || value.name === "TimeoutError")
  );
}
