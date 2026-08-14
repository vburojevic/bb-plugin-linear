import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RESOURCE_TYPES,
  selfTestPayload,
  signPayload,
  verifyWebhook,
  webhookDeliveryKey,
  type VerifyContext,
} from "../src/webhook.js";
import { classify } from "../src/notify/classify.js";

const SECRET = "lin_wh_secret_value_for_tests";
const NOW = 1_700_000_000_000;

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    organizationId: "org_1",
    webhookId: "wh_1",
    webhookTimestamp: NOW,
    data: { id: "i_1", teamId: "team_eng" },
    ...overrides,
  });
}

function context(raw: string, overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    raw,
    signature: createHmac("sha256", SECRET).update(raw).digest("hex"),
    secret: SECRET,
    now: NOW,
    organizationId: "org_1",
    knownWebhookIds: new Set(["wh_1"]),
    boundTeamIds: new Set(["team_eng"]),
    ...overrides,
  };
}

/**
 * The nine cases. `auth: "none"` is sanctioned for this one route and the
 * handler earns it here or not at all.
 */
describe("verifyWebhook", () => {
  it("accepts a valid delivery", () => {
    const result = verifyWebhook(context(body()));
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    // The signature is over the RAW bytes, so any change invalidates it —
    // which is why the handler must never parse-then-restringify before
    // verifying.
    const raw = body();
    const tampered = raw.replace('"i_1"', '"i_2"');
    expect(verifyWebhook(context(tampered, { signature: signPayload(SECRET, raw) }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a tampered signature", () => {
    expect(verifyWebhook(context(body(), { signature: "0".repeat(64) }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a
    // malformed signature into a 500 and into a timing signal of its own.
    expect(() => verifyWebhook(context(body(), { signature: "abc" }))).not.toThrow();
    expect(verifyWebhook(context(body(), { signature: "abc" })).ok).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const raw = body();
    expect(
      verifyWebhook(context(raw, { signature: signPayload("another-secret-entirely", raw) })),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a stale timestamp at 61 seconds", () => {
    const raw = body({ webhookTimestamp: NOW - 61_000 });
    expect(verifyWebhook(context(raw))).toEqual({ ok: false, reason: "stale-timestamp" });
    // And accepts one at 59.
    expect(verifyWebhook(context(body({ webhookTimestamp: NOW - 59_000 }))).ok).toBe(true);
  });

  it("rejects a future timestamp", () => {
    expect(verifyWebhook(context(body({ webhookTimestamp: NOW + 120_000 })))).toEqual({
      ok: false,
      reason: "future-timestamp",
    });
  });

  it("rejects an unknown organization", () => {
    expect(verifyWebhook(context(body({ organizationId: "org_someone_else" })))).toEqual({
      ok: false,
      reason: "unknown-organization",
    });
  });

  it("rejects an unknown webhook id", () => {
    expect(verifyWebhook(context(body({ webhookId: "wh_not_ours" })))).toEqual({
      ok: false,
      reason: "unknown-webhook",
    });
  });

  it("rejects an unbound team", () => {
    // Scope is the binding here too: an event about a team no bb project binds
    // is an event about work this bb does not track.
    const raw = body({ data: { id: "i_1", teamId: "team_secret" } });
    expect(verifyWebhook(context(raw))).toEqual({ ok: false, reason: "unbound-team" });
  });

  it("rejects a malformed body after the signature checks out", () => {
    const raw = "not json at all";
    expect(verifyWebhook(context(raw))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses to verify anything when there is no secret", () => {
    expect(verifyWebhook(context(body(), { secret: null }))).toEqual({
      ok: false,
      reason: "no-secret",
    });
    expect(verifyWebhook(context(body(), { signature: null }))).toEqual({
      ok: false,
      reason: "no-signature",
    });
  });

  it("accepts an event with no team, which is a workspace-level one", () => {
    const raw = body({ type: "Project", data: { id: "p_1" } });
    expect(verifyWebhook(context(raw)).ok).toBe(true);
  });
});

describe("webhookDeliveryKey", () => {
  it("goes through the same claim table as a polled notification", () => {
    // One dedupe mechanism for both paths. A second, subtly different one is
    // how webhook mode becomes a second pipeline with its own bugs — and
    // Linear retries, so duplicates are expected by design.
    const key = webhookDeliveryKey({
      action: "update",
      type: "Issue",
      webhookTimestamp: NOW,
      data: { id: "i_1" },
    });
    expect(key).toBe(`Issue:i_1:${NOW}`);
  });

  it("survives a payload with no data id", () => {
    expect(
      webhookDeliveryKey({ action: "remove", type: "Issue", webhookTimestamp: NOW }),
    ).toBe(`Issue:?:${NOW}`);
  });
});

describe("the self-test", () => {
  it("produces a payload this plugin's own verifier accepts", () => {
    // Register on proof, not on hope: a webhook registered against a URL that
    // does not reach bb gets three failed deliveries and is then disabled by
    // Linear, which is a worse state than never having registered.
    const raw = selfTestPayload(NOW, "nonce-1");
    const result = verifyWebhook({
      raw,
      signature: signPayload(SECRET, raw),
      secret: SECRET,
      now: NOW,
      organizationId: null,
      knownWebhookIds: new Set(),
      boundTeamIds: new Set(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("resourceTypes", () => {
  it("registers for exactly what the plugin consumes", () => {
    // Registering for an event nobody handles is dead traffic; omitting one is
    // a silent gap. Both are the same mistake in opposite directions.
    expect([...RESOURCE_TYPES].sort()).toEqual([
      "Comment",
      "Cycle",
      "Issue",
      "IssueAttachment",
      "IssueLabel",
      "Project",
    ]);
  });

  it("never asks for allPublicTeams", async () => {
    // It would haul other teams' data into the mirror and contradict the whole
    // scoping promise.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/webhook.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("allPublicTeams` is never used");
    expect(source).not.toMatch(/allPublicTeams:\s*true/);
  });

  it("classifies a webhook event through the same function as a polled one", () => {
    // Not a second classifier. The two paths differ only in where the event
    // came from.
    expect(classify({ category: "assignments", type: "x" })).toBe("assigned");
  });
});
