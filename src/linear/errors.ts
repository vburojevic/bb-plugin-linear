/**
 * Error classification and redaction.
 *
 * Two jobs live here because they are the same job: an error is the most
 * likely thing to carry a secret into a log line, a tool result or a toast,
 * and it is also the thing whose *kind* decides whether the plugin retries,
 * backs off, re-authenticates or gives up. Getting the kind wrong is how a
 * poller tight-loops against a rate limit; getting the redaction wrong is how
 * an API key ends up in `bb plugin logs`.
 */

/**
 * The classifications the rest of the plugin switches on. Deliberately small:
 * every branch of every decision in this codebase is reachable from one of
 * these, and adding a member means adding a real behavioural difference, not a
 * finer shade of "something went wrong".
 */
export type LinearErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "budget"
  | "network"
  | "timeout"
  | "query"
  | "mutation"
  | "not_found"
  | "refused";

/** Codes whose repetition means the far end is genuinely unavailable rather
 *  than the request being wrong. Three in a row opens the read breaker. */
export const DETERMINISTIC_FAILURE_CODES: ReadonlySet<LinearErrorCode> = new Set([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "network",
]);

export interface LinearGraphQLError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly extensions?: Record<string, unknown>;
}

export interface LinearErrorOptions {
  readonly retryable?: boolean;
  readonly cause?: unknown;
  /** Epoch milliseconds at which the exhausted budget refills. */
  readonly resetAt?: number | null;
  readonly errors?: readonly LinearGraphQLError[];
}

export class LinearError extends Error {
  readonly code: LinearErrorCode;
  readonly retryable: boolean;
  readonly resetAt: number | null;
  readonly errors: readonly LinearGraphQLError[];

  constructor(code: LinearErrorCode, message: string, options: LinearErrorOptions = {}) {
    // Redacted at construction, not at the log call. An error object travels:
    // it is rethrown, wrapped, stringified into an rpc envelope and shown in a
    // toast, and only one of those places is easy to remember to guard.
    super(redact(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LinearError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.resetAt = options.resetAt ?? null;
    // The retained array gets the same treatment as the summary: a GraphQL
    // validation error can echo the variables it rejected — including a
    // webhook signing secret sent as one — and this enumerable property is
    // exactly what a host that serializes error objects would carry out.
    this.errors = (options.errors ?? []).map((entry) => ({
      ...entry,
      message: redact(entry.message),
    }));
  }
}

export function isLinearError(value: unknown): value is LinearError {
  return value instanceof LinearError;
}

/** HTTP 401. Never retried — a second identical request cannot succeed, and
 *  retrying an auth failure is how a revoked key burns an hourly budget. */
export function unauthorized(message: string, cause?: unknown): LinearError {
  return new LinearError("unauthorized", message, { retryable: false, cause });
}

export function forbidden(message: string, cause?: unknown): LinearError {
  return new LinearError("forbidden", message, { retryable: false, cause });
}

/**
 * Linear signals a rate limit as **HTTP 400 with
 * `extensions.code === "RATELIMITED"`, and no `Retry-After`** — verified
 * against the published rate-limiting documentation. Generic retry middleware
 * gets this wrong twice over: it misses the case because it watches for 429,
 * then classifies the 400 as a permanent client error and gives up on a
 * condition that clears by itself.
 */
export function rateLimited(message: string, resetAt: number | null): LinearError {
  return new LinearError("rate_limited", message, { retryable: false, resetAt });
}

/** The plugin's own governor refusing to spend the last of the budget on
 *  background work. Distinct from `rate_limited`: Linear has not refused
 *  anything, so the sentence shown to a user is different. */
export function budgetExhausted(message: string, resetAt: number | null): LinearError {
  return new LinearError("budget", message, { retryable: false, resetAt });
}

export function networkFailure(message: string, cause?: unknown): LinearError {
  return new LinearError("network", message, { retryable: true, cause });
}

export function timedOut(message: string): LinearError {
  return new LinearError("timeout", message, { retryable: true });
}

/**
 * A 200 carrying `errors`.
 *
 * `retryable` is derived from the transport status, which is a *shape* fact,
 * rather than from `extensions.code` — Linear documents exactly one code
 * (`RATELIMITED`, handled above), so a switch over the others would be a
 * switch over strings nobody has promised to keep. A GraphQL error under a 5xx
 * is a server-side blip worth one retry; the same error under a 2xx or 4xx
 * means the request itself is wrong, and repeating it spends budget to receive
 * the identical answer.
 */
export function queryFailed(
  errors: readonly LinearGraphQLError[],
  httpStatus: number,
): LinearError {
  const summary = summarizeGraphQLErrors(errors);
  return new LinearError("query", summary, {
    retryable: httpStatus >= 500,
    errors,
  });
}

/**
 * A mutation that returned a payload rather than an error, but whose payload
 * says it did not happen.
 *
 * `success: false` **with no `errors` array** is a real Linear response and
 * the classic silent failure: HTTP 200, no GraphQL errors, nothing written. A
 * client that only inspects `body.errors` reports success and the issue never
 * moves.
 */
export function mutationFailed(message: string): LinearError {
  return new LinearError("mutation", message, { retryable: false });
}

export function notFound(message: string): LinearError {
  return new LinearError("not_found", message, { retryable: false });
}

/** A refusal the plugin authored — a cross-team write, a read-only key, an
 *  unbound project. Never a transport outcome, and never retried. */
export function refused(message: string): LinearError {
  return new LinearError("refused", message, { retryable: false });
}

function summarizeGraphQLErrors(errors: readonly LinearGraphQLError[]): string {
  if (errors.length === 0) return "Linear rejected the request.";
  const first = errors[0]?.message ?? "Linear rejected the request.";
  return errors.length === 1 ? first : `${first} (and ${errors.length - 1} more)`;
}

/**
 * Turn anything a `catch` can receive into one redacted sentence.
 *
 * Used at every boundary that renders or logs a failure, so that a stray
 * `throw "string"` or a `TypeError` from a JSON shape assumption is as safe as
 * a `LinearError`.
 */
export function describeError(value: unknown): string {
  if (isLinearError(value)) return value.message;
  if (value instanceof Error) return redact(value.message || value.name);
  if (typeof value === "string") return redact(value);
  return "Something went wrong.";
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Redaction                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Live secrets, registered by the transport each time it reads one.
 *
 * A module-level set is the right shape here even though module state that
 * outlives a plugin load is usually a bug: a stale entry can only cause
 * *over*-redaction, which is the safe direction, and `forgetSecrets()` runs
 * from the dispose hook anyway. The alternative — threading a redactor through
 * every function that might one day build a string — makes the guarantee
 * opt-in, and an opt-in redactor is one someone forgets exactly once.
 */
const liveSecrets = new Set<string>();

/**
 * Minimum length for a remembered secret. A short or empty value would match
 * everywhere and turn every log line into `[redacted]`, which destroys the
 * diagnostics the log exists for — and something that short is not a Linear
 * key anyway.
 */
const MIN_SECRET_LENGTH = 12;

export function rememberSecret(value: string | null | undefined): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  liveSecrets.add(trimmed);
}

export function forgetSecrets(): void {
  liveSecrets.clear();
}

const LINEAR_KEY_PATTERN = /lin_(?:api|oauth)_[A-Za-z0-9_-]+/g;
/**
 * The value runs to the end of the line, not to the next space.
 *
 * `Authorization: Bearer <token>` is two whitespace-separated tokens, so a
 * `\S+` here redacts the word "Bearer" and leaves the credential standing —
 * which looks convincingly redacted in a log and is not.
 */
const AUTHORIZATION_PATTERN = /((?:authorization|linear-signature)\s*[:=]\s*)([^\r\n]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;

/**
 * Applied to every string that reaches `bb.log`, a tool result, an rpc error
 * or the UI.
 *
 * Three passes, in this order and for three different threat models: the exact
 * live key (catches a key that does not match Linear's public prefix, such as
 * one from a self-hosted proxy), the documented key shapes (catches a key that
 * was never registered — someone else's, pasted into a query variable), and
 * header-shaped text (catches a key that arrived inside a serialised request
 * dump, where it appears after `Authorization:` in a form the other two passes
 * cannot recognise).
 */
export function redact(text: string): string {
  if (text === "") return text;
  let output = text;
  // Longest first: a shorter secret that happens to be a prefix of a longer
  // one must not leave the longer one's tail exposed.
  const secrets = [...liveSecrets].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (output.includes(secret)) {
      output = output.split(secret).join("[redacted]");
    }
  }
  output = output.replace(LINEAR_KEY_PATTERN, "lin_[redacted]");
  output = output.replace(AUTHORIZATION_PATTERN, "$1[redacted]");
  output = output.replace(BEARER_PATTERN, "Bearer [redacted]");
  return output;
}
