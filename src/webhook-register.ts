import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { describeError } from "./linear/errors.js";
import { selfTestPayload, signPayload } from "./webhook.js";

/**
 * Turning webhooks on, keeping them honest, and turning them off again.
 *
 * The whole flow is built around one rule: **register on proof, not on hope.**
 * A webhook registered against a URL that does not actually reach this bb gets
 * three failed deliveries — after 1 minute, 1 hour and 6 hours — and is then
 * disabled by Linear, with no replay API and no notification. That is strictly
 * worse than never having registered, because the user believes they are on
 * webhooks and is silently on nothing. So the plugin POSTs itself a signed
 * probe first and only calls `webhookCreate` if the probe comes back through
 * its own handler.
 *
 * This module is the second and last place in the plugin that opens a socket.
 * It does **not** go through the Linear transport, and that is deliberate: this
 * request goes to the *user's own URL*, carries no Linear credential, must not
 * consume the Linear rate-limit budget, and must not be able to trip the
 * Linear read breaker. Routing it through the transport would make all four
 * wrong at once.
 */

export type PostLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

/**
 * The second and last socket in the plugin, and the reason `test/hygiene`
 * names two modules instead of one.
 *
 * Ten seconds is generous for a request that travels to the public internet
 * and back to this same machine, and finite because a URL that hangs is the
 * most common way a misconfigured reverse proxy fails — an unbounded wait
 * there would hang the `enable` command rather than answer it.
 */
const defaultPost: PostLike = async (url, init) => {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily === 0
    ? await dnsLookup(hostname, { all: true, verbatim: true })
    : [{ address: hostname, family: literalFamily }];
  if (addresses.length === 0 || addresses.some((entry) => isPrivateHost(entry.address))) {
    throw new Error("Webhook hostname resolved to a private, local, or unavailable address.");
  }
  const selected = addresses[0]!;

  return await new Promise<{ status: number }>((resolve, reject) => {
    const request = httpsRequest(parsed, {
      method: init.method,
      headers: init.headers,
      signal: init.signal ?? AbortSignal.timeout(10_000),
      // Pin the address checked above. Re-resolving here would reopen the DNS
      // rebinding window; https.request itself never follows redirects.
      lookup: ((_hostname: string, _options: unknown, callback: Function) => {
        callback(null, selected.address, selected.family);
      }) as never,
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve({ status });
    });
    request.on("error", reject);
    request.end(init.body);
  });
};

/* ────────────────────────────────────────────────────────────────────────── */
/* The URL                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export type UrlVerdict = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly why: string };

/**
 * Checked before anything else, because every later failure mode is more
 * expensive to explain than this one.
 *
 * A bb connect share link is *not* rejected by pattern here even though it can
 * never work — guessing at share-link shapes would be wrong for someone else's
 * deployment, and the self-test catches it honestly a second later: Linear's
 * delivery bot carries no session, so a session-gated URL answers the probe
 * with a sign-in page rather than a 200.
 */
export function checkWebhookUrl(raw: string): UrlVerdict {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, why: "No URL is set." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, why: `${trimmed} is not a URL.` };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      why: "Linear only delivers to https:// — an http:// endpoint is never called, and the webhook would look registered while receiving nothing.",
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, why: "A URL with credentials in it would be stored and sent in the clear. Put the secret in the path or drop it." };
  }
  if (isPrivateHost(parsed.hostname)) {
    // The self-test POSTs to this URL from the machine running bb, so a
    // private/loopback/link-local target turns the webhook enable command into
    // an internal-network probe. Linear itself only delivers to public
    // endpoints, so nothing legitimate is lost by refusing these — and the
    // cloud metadata endpoint (169.254.169.254) is exactly the address this
    // blocks.
    return {
      ok: false,
      why: `${parsed.hostname} is a private or loopback address; Linear only delivers to public endpoints, so a webhook there would never receive anything.`,
    };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Private, loopback, link-local and unique-local ranges — the addresses a
 * webhook target must never be, because Linear cannot reach them and a
 * self-test to them is an SSRF primitive. Hostnames are lower-cased; a bare
 * `localhost` and the common private forms are covered without a DNS lookup
 * Literal checks happen here; the self-test also resolves and pins the public
 * address immediately before opening its TLS connection.
 */
export function isPrivateHost(hostname: string): boolean {
  // A trailing dot is a fully-qualified name and resolves identically, so it
  // must not be a way around the name checks.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // IPv6 only when it actually IS an IPv6 literal. Testing these prefixes
  // against any hostname refuses `fcbarcelona.com` and `fdny.gov` as "private
  // addresses" — a wrong refusal with a nonsense explanation.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true; // unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // link-local
    if (/^fe[c-f][0-9a-f]:/.test(host)) return true; // deprecated site-local
    if (/^ff[0-9a-f]{2}:/.test(host)) return true; // multicast
    if (/^100:0*:0*:0*:/.test(host)) return true; // discard-only 100::/64
    if (/^2001:db8:/.test(host)) return true; // documentation, not globally routable
    // An IPv4-mapped or -compatible address is the mapped address: the
    // ::ffff:127.0.0.1 spelling of loopback must not read as public.
    const mapped = host.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped !== null) return isPrivateHost(mapped[1]!);
    const hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex !== null) {
      // WHATWG URL normalises ::ffff:127.0.0.1 to its hex form, so the same
      // address arrives spelled ::ffff:7f00:1.
      const high = Number.parseInt(hex[1]!, 16);
      const low = Number.parseInt(hex[2]!, 16);
      return isPrivateHost(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      );
    }
    return false;
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 === null) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark networks
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** 32 bytes, hex. Generated locally and *supplied* to Linear rather than
 *  generated by it, so the value is on disk before the first delivery can
 *  arrive — a webhook whose secret we learn only from the create response has
 *  a window where a real delivery cannot be verified. */
export function newSigningSecret(): string {
  return randomBytes(32).toString("hex");
}

export function newNonce(): string {
  return randomBytes(12).toString("hex");
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The self-test                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export type SelfTestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: string };

export interface SelfTestOptions {
  readonly url: string;
  readonly secret: string;
  readonly nonce: string;
  readonly now: number;
  /** Injected only so a test can answer without a socket. The default is the
   *  real one, so the shipped path is the tested path minus one substitution. */
  readonly post?: PostLike;
  /** Has the nonce arrived at the plugin's own handler yet? Polled, because
   *  the handler answers 200 and processes asynchronously by design. */
  readonly arrived: (nonce: string) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

/**
 * POST a signed probe to the configured URL and wait for it to come back
 * through this plugin's own `/webhook` route.
 *
 * Signed with the *same* secret and the *same* header name Linear uses, so the
 * probe exercises the real verification path rather than a parallel one that
 * could pass while the real one fails.
 */
export async function runSelfTest(options: SelfTestOptions): Promise<SelfTestResult> {
  const raw = selfTestPayload(options.now, options.nonce);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const post = options.post ?? defaultPost;

  let status: number;
  try {
    const response = await post(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signPayload(options.secret, raw),
        "linear-event": "SelfTest",
      },
      body: raw,
    });
    status = response.status;
  } catch (error) {
    return {
      ok: false,
      why: `Nothing answered at that URL (${describeError(error)}). Linear would get the same result and disable the webhook after three tries.`,
    };
  }

  if (status !== 200) {
    return {
      ok: false,
      why:
        status === 401 || status === 403
          ? `That URL answered ${status} — something in front of bb is asking for a session. Linear's delivery bot has no session, so it would get the same page.`
          : `That URL answered ${status}, not 200. Linear treats anything but a 2xx as a failed delivery.`,
    };
  }

  // The route returns 200 and processes asynchronously, so arrival is polled
  // rather than assumed from the status code — a proxy that swallows the body
  // and answers 200 itself would otherwise pass.
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
    if (options.arrived(options.nonce)) return { ok: true };
    await options.sleep(100);
  }

  return {
    ok: false,
    why: "That URL answered 200, but the request never reached this plugin. Something in front of bb is absorbing it.",
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Health                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export interface WebhookHealthInput {
  readonly enabled: boolean;
  readonly failures: readonly { readonly createdAt: string; readonly httpStatus: number | null }[];
  /** When a signed delivery last actually arrived here. A failure older than
   *  this one is history, not a symptom. */
  readonly lastDeliveryAt: number | null;
  readonly now: number;
}

export type WebhookHealth =
  | { readonly state: "healthy" }
  | { readonly state: "failing"; readonly httpStatus: number | null; readonly at: number }
  | { readonly state: "disabled" };

/** Linear stops retrying after three attempts spread over roughly six hours,
 *  so a failure older than that has either been superseded by a success or is
 *  never coming back. */
const FAILURE_HORIZON_MS = 7 * 60 * 60 * 1000;

/**
 * A healthy webhook produces nothing — no row, no toast, no log line. The
 * plugin only ever speaks up to say deliveries have stopped, because a status
 * indicator that is green 99.9% of the time is a status indicator nobody
 * reads on the day it turns red.
 */
export function webhookHealth(input: WebhookHealthInput): WebhookHealth {
  if (!input.enabled) return { state: "disabled" };

  let worst: { at: number; httpStatus: number | null } | null = null;
  for (const failure of input.failures) {
    const at = Date.parse(failure.createdAt);
    if (!Number.isFinite(at)) continue;
    if (input.now - at > FAILURE_HORIZON_MS) continue;
    if (input.lastDeliveryAt !== null && at <= input.lastDeliveryAt) continue;
    if (worst === null || at > worst.at) worst = { at, httpStatus: failure.httpStatus };
  }

  if (worst === null) return { state: "healthy" };
  return { state: "failing", httpStatus: worst.httpStatus, at: worst.at };
}

/** What the user is told, once, when a webhook stops delivering. The poller
 *  has been running underneath the whole time, so this is a latency
 *  regression rather than an outage — and it says so. */
export function describeDemotion(health: WebhookHealth, teamKey: string): string | null {
  switch (health.state) {
    case "healthy":
      return null;
    case "disabled":
      return `Linear disabled the ${teamKey} webhook after repeated failed deliveries. Back to polling — nothing is lost, updates just arrive on the sync interval instead of instantly.`;
    case "failing":
      return `The ${teamKey} webhook is failing${health.httpStatus === null ? "" : ` (HTTP ${String(health.httpStatus)})`}. Back to polling — nothing is lost, updates just arrive on the sync interval instead of instantly.`;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Planning                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RegistrationPlan {
  readonly create: readonly string[];
  /** Carries the team id as well as the webhook id: with several workspaces
   *  configured, deleting a webhook takes the key that created it, and only
   *  the team says which key that is. */
  readonly deleteIds: readonly { readonly id: string; readonly teamId: string }[];
  readonly keep: readonly string[];
}

/**
 * One webhook per bound team, because `WebhookCreateInput.teamId` is singular
 * and `WebhookUpdateInput` cannot change team scope at all — so re-scoping is
 * delete-then-create, and a URL change is a full replacement.
 *
 * `allPublicTeams` is never used. It would haul other teams' data into the
 * mirror and contradict the entire scoping promise.
 */
export function planRegistration(
  boundTeamIds: readonly string[],
  existing: ReadonlyMap<string, { readonly id: string; readonly url: string }>,
  url: string,
): RegistrationPlan {
  const bound = new Set(boundTeamIds);
  const create: string[] = [];
  const deleteIds: { id: string; teamId: string }[] = [];
  const keep: string[] = [];

  for (const teamId of bound) {
    const record = existing.get(teamId);
    if (record === undefined) create.push(teamId);
    else if (record.url !== url) {
      deleteIds.push({ id: record.id, teamId });
      create.push(teamId);
    } else keep.push(teamId);
  }

  for (const [teamId, record] of existing) {
    if (!bound.has(teamId)) deleteIds.push({ id: record.id, teamId });
  }

  return { create, deleteIds, keep };
}
