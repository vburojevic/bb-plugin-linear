import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook delivery — opt-in, honestly labelled, and never destroyed by a
 * reload.
 *
 * **Polling is the default and always works.** Webhooks are an escalation for
 * someone who already runs a public HTTPS endpoint, and three verified facts
 * shape the whole design:
 *
 * 1. **Only workspace admins, or OAuth apps with the `admin` scope, can create
 *    or read webhooks.** Engineer #17 at a forty-team organisation simply
 *    cannot. Any design that assumes webhooks are reachable breaks for a large
 *    fraction of the audience before the tunnel question comes up.
 * 2. **`WebhookCreateInput` takes `teamId` — singular — and requires
 *    `resourceTypes`.** There is no `teamIds`, and `WebhookUpdateInput` cannot
 *    change team scope at all. So: one webhook per bound team, ids in kv,
 *    re-scoping is delete-then-create. `allPublicTeams` is never used — it
 *    would haul other teams' data into the mirror and contradict the entire
 *    scoping promise.
 * 3. **A bb connect share link cannot be this URL.** It is session-gated;
 *    Linear's delivery bot carries no session, gets the sign-in page, gets a
 *    non-200, and after the retry budget Linear disables the webhook. The
 *    plugin must never imply bb can provide the URL.
 *
 * Linear retries a failed delivery **at most three times** (after 1 minute, 1
 * hour, and 6 hours) and then gives up, with no replay API. That is why the
 * poller keeps running underneath rather than being switched off.
 */

/** `resourceTypes` is required, and this set is asserted by a test to match
 *  exactly what `classify()` and `apply()` consume: registering for an event
 *  nobody handles is dead traffic, and omitting one is a silent gap. */
export const RESOURCE_TYPES = [
  "Issue",
  "Comment",
  "IssueLabel",
  "Project",
  "Cycle",
  "IssueAttachment",
] as const;

/** Linear recommends rejecting anything outside a minute of local time, to
 *  guard against replay. */
export const TIMESTAMP_WINDOW_MS = 60_000;

export type VerifyResult =
  | { readonly ok: true; readonly body: WebhookBody }
  | { readonly ok: false; readonly reason: VerifyFailure };

export type VerifyFailure =
  | "no-secret"
  | "no-signature"
  | "bad-signature"
  | "malformed"
  | "missing-identity"
  | "stale-timestamp"
  | "future-timestamp"
  | "unknown-organization"
  | "unknown-webhook"
  | "unbound-team";

export interface WebhookBody {
  readonly action: string;
  readonly type: string;
  readonly organizationId?: string;
  readonly webhookId?: string;
  readonly webhookTimestamp: number;
  readonly data?: { readonly id?: string; readonly teamId?: string; readonly team?: { id?: string } };
}

export interface VerifyContext {
  /** The **raw** body text. Never a re-serialised parse: the signature is over
   *  the bytes Linear sent, and `JSON.parse` followed by `JSON.stringify`
   *  reorders keys and drops whitespace. */
  readonly raw: string;
  readonly signature: string | null;
  readonly secret: string | null;
  readonly now: number;
  readonly organizationId: string | null;
  readonly knownWebhookIds: ReadonlySet<string>;
  readonly boundTeamIds: ReadonlySet<string>;
}

/**
 * Failure-first, and in this order.
 *
 * The signature is verified **before any work at all** — before parsing, before
 * a database touch, before a log line that could carry attacker-controlled
 * text. This is the one sanctioned use of `auth: "none"` in the whole plugin,
 * and the handler earns it here or not at all.
 */
export function verifyWebhook(context: VerifyContext): VerifyResult {
  if (context.secret === null || context.secret === "") {
    return { ok: false, reason: "no-secret" };
  }
  if (context.signature === null || context.signature === "") {
    return { ok: false, reason: "no-signature" };
  }

  const expected = createHmac("sha256", context.secret).update(context.raw).digest("hex");
  if (!safeEqual(expected, context.signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(context.raw) as WebhookBody;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof body.webhookTimestamp !== "number" || !Number.isFinite(body.webhookTimestamp)) {
    return { ok: false, reason: "malformed" };
  }

  const selfTest = body.type === "SelfTest";
  if (
    !selfTest &&
    (typeof body.organizationId !== "string" ||
      body.organizationId === "" ||
      typeof body.webhookId !== "string" ||
      body.webhookId === "")
  ) {
    return { ok: false, reason: "missing-identity" };
  }

  const drift = context.now - body.webhookTimestamp;
  if (drift > TIMESTAMP_WINDOW_MS) return { ok: false, reason: "stale-timestamp" };
  if (drift < -TIMESTAMP_WINDOW_MS) return { ok: false, reason: "future-timestamp" };

  if (!selfTest && (context.organizationId === null || body.organizationId !== context.organizationId)) {
    return { ok: false, reason: "unknown-organization" };
  }

  if (!selfTest && !context.knownWebhookIds.has(body.webhookId!)) {
    return { ok: false, reason: "unknown-webhook" };
  }

  const teamId = body.data?.teamId ?? body.data?.team?.id ?? null;
  if (teamId !== null && !context.boundTeamIds.has(teamId)) {
    return { ok: false, reason: "unbound-team" };
  }

  return { ok: true, body };
}

/**
 * Constant-time comparison on equal-length buffers.
 *
 * `timingSafeEqual` **throws** on a length mismatch, which would turn a
 * malformed signature into a 500 and, worse, into a timing signal of its own.
 * The length check comes first and is not itself secret.
 */
function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual.trim(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The dedupe key for a webhook event.
 *
 * Composed from type, entity and timestamp because a webhook payload has no
 * `groupingKey` — and it goes through **the same claim table** as a polled
 * notification. One dedupe mechanism for both paths is what stops webhook mode
 * becoming a second, subtly different pipeline with its own bugs. Linear
 * retries, so duplicates are expected by design rather than exceptional.
 */
export function webhookDeliveryKey(body: WebhookBody): string {
  return `${body.type}:${body.data?.id ?? "?"}:${body.webhookTimestamp}`;
}

/**
 * A signed probe, for the self-test.
 *
 * Registration happens **only after** the plugin POSTs this to the configured
 * URL and it arrives at its own handler. Register on proof, not on hope: a
 * webhook registered against a URL that does not reach bb gets three failed
 * deliveries and is then disabled by Linear, which is a worse state than never
 * having registered.
 */
export function signPayload(secret: string, raw: string): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

/** Parse only enough of an already byte-limited body to choose the secret that
 * must authenticate it. Nothing returned here is trusted until verifyWebhook
 * succeeds. */
export function webhookEnvelope(raw: string): {
  readonly type: string;
  readonly webhookId: string | null;
  readonly nonce: string | null;
} | null {
  try {
    const value = JSON.parse(raw) as {
      type?: unknown;
      webhookId?: unknown;
      data?: { id?: unknown };
    };
    if (typeof value.type !== "string") return null;
    return {
      type: value.type,
      webhookId: typeof value.webhookId === "string" ? value.webhookId : null,
      nonce: typeof value.data?.id === "string" ? value.data.id : null,
    };
  } catch {
    return null;
  }
}

export function selfTestPayload(now: number, nonce: string): string {
  return JSON.stringify({
    action: "selftest",
    type: "SelfTest",
    webhookTimestamp: now,
    data: { id: nonce },
  });
}
