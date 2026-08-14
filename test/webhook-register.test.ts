import { describe, expect, it } from "vitest";
import {
  checkWebhookUrl,
  describeDemotion,
  isPrivateHost,
  newSigningSecret,
  planRegistration,
  runSelfTest,
  webhookHealth,
} from "../src/webhook-register.js";
import { selfTestPayload, signPayload, verifyWebhook } from "../src/webhook.js";

const NOW = 1_700_000_000_000;
const nothing = async (): Promise<void> => {};

describe("checkWebhookUrl", () => {
  it("refuses http, because Linear only ever delivers to https", () => {
    // The failure this prevents is the quiet one: the webhook registers, looks
    // healthy in every UI, and is never called.
    const verdict = checkWebhookUrl("http://example.test/hook");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.why).toContain("https://");
  });

  it("refuses credentials in the URL", () => {
    expect(checkWebhookUrl("https://user:pw@example.test/hook").ok).toBe(false);
  });

  it("accepts a plain https URL and normalises it", () => {
    const verdict = checkWebhookUrl("  https://hooks.example.test/linear  ");
    expect(verdict).toEqual({ ok: true, url: "https://hooks.example.test/linear" });
  });

  it("does not guess at share-link shapes", () => {
    // Pattern-matching someone else's deployment would be wrong for everyone
    // it was not written for. The self-test catches an unreachable URL a second
    // later, honestly, by not reaching it.
    expect(checkWebhookUrl("https://anything.example.test/x").ok).toBe(true);
  });
});

describe("runSelfTest", () => {
  it("signs the probe so the plugin's own verifier accepts it", async () => {
    // The probe must exercise the real verification path. A probe that took a
    // shortcut could pass while a real delivery failed, which is precisely the
    // outcome the self-test exists to rule out.
    const secret = newSigningSecret();
    let seen: { body: string; signature: string } | null = null;

    const result = await runSelfTest({
      url: "https://hooks.example.test/linear",
      secret,
      nonce: "abc123",
      now: NOW,
      post: async (_url, init) => {
        seen = { body: init.body, signature: init.headers["linear-signature"]! };
        return { status: 200 };
      },
      arrived: () => true,
      sleep: nothing,
    });

    expect(result).toEqual({ ok: true });
    const captured = seen as unknown as { body: string; signature: string };
    const verified = verifyWebhook({
      raw: captured.body,
      signature: captured.signature,
      secret,
      now: NOW,
      organizationId: "org-1",
      knownWebhookIds: new Set(),
      boundTeamIds: new Set(),
    });
    expect(verified.ok).toBe(true);
  });

  it("explains a 401 as a session gate rather than a generic failure", async () => {
    const result = await runSelfTest({
      url: "https://share.example.test/x",
      secret: "s",
      nonce: "n",
      now: NOW,
      post: async () => ({ status: 401 }),
      arrived: () => true,
      sleep: nothing,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("no session");
  });

  it("fails when the URL answers 200 but the probe never arrives", async () => {
    // A reverse proxy that swallows the body and answers 200 itself is not a
    // working webhook endpoint, and the status code alone cannot tell.
    const result = await runSelfTest({
      url: "https://hooks.example.test/linear",
      secret: "s",
      nonce: "n",
      now: NOW,
      post: async () => ({ status: 200 }),
      arrived: () => false,
      sleep: nothing,
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("never reached this plugin");
  });

  it("reports a connection failure as one, not as a crash", async () => {
    const result = await runSelfTest({
      url: "https://nothing.example.test/",
      secret: "s",
      nonce: "n",
      now: NOW,
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
      arrived: () => true,
      sleep: nothing,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain("ECONNREFUSED");
  });

  it("produces a payload with a timestamp inside the replay window", () => {
    const raw = selfTestPayload(NOW, "n");
    const verified = verifyWebhook({
      raw,
      signature: signPayload("s", raw),
      secret: "s",
      now: NOW + 59_000,
      organizationId: null,
      knownWebhookIds: new Set(),
      boundTeamIds: new Set(),
    });
    expect(verified.ok).toBe(true);
  });
});

describe("webhookHealth", () => {
  const iso = (at: number): string => new Date(at).toISOString();

  it("says nothing at all when deliveries are arriving", () => {
    expect(webhookHealth({ enabled: true, failures: [], lastDeliveryAt: NOW, now: NOW })).toEqual({
      state: "healthy",
    });
  });

  it("treats a failure older than the last delivery as history", () => {
    // Linear keeps failures around. One from last Tuesday, followed by a
    // delivery that arrived, is not a symptom of anything.
    expect(
      webhookHealth({
        enabled: true,
        failures: [{ createdAt: iso(NOW - 3_600_000), httpStatus: 502 }],
        lastDeliveryAt: NOW - 60_000,
        now: NOW,
      }),
    ).toEqual({ state: "healthy" });
  });

  it("reports a failure newer than the last delivery", () => {
    const health = webhookHealth({
      enabled: true,
      failures: [{ createdAt: iso(NOW - 60_000), httpStatus: 502 }],
      lastDeliveryAt: NOW - 3_600_000,
      now: NOW,
    });
    expect(health).toEqual({ state: "failing", httpStatus: 502, at: NOW - 60_000 });
  });

  it("ignores a failure past the horizon Linear stops retrying in", () => {
    expect(
      webhookHealth({
        enabled: true,
        failures: [{ createdAt: iso(NOW - 30 * 3_600_000), httpStatus: 500 }],
        lastDeliveryAt: null,
        now: NOW,
      }),
    ).toEqual({ state: "healthy" });
  });

  it("calls a disabled webhook disabled, whatever the failures say", () => {
    // This is the state Linear leaves a webhook in after three failed
    // deliveries, and it tells nobody.
    expect(
      webhookHealth({ enabled: false, failures: [], lastDeliveryAt: NOW, now: NOW }),
    ).toEqual({ state: "disabled" });
  });

  it("survives an unparseable failure timestamp", () => {
    expect(
      webhookHealth({
        enabled: true,
        failures: [{ createdAt: "not a date", httpStatus: null }],
        lastDeliveryAt: null,
        now: NOW,
      }),
    ).toEqual({ state: "healthy" });
  });
});

describe("describeDemotion", () => {
  it("says nothing when healthy", () => {
    expect(describeDemotion({ state: "healthy" }, "ENG")).toBeNull();
  });

  it("frames demotion as a latency change, because the poller never stopped", () => {
    const message = describeDemotion({ state: "disabled" }, "ENG");
    expect(message).toContain("ENG");
    expect(message).toContain("nothing is lost");
  });
});

describe("planRegistration", () => {
  it("creates one webhook per bound team", () => {
    // WebhookCreateInput.teamId is singular and WebhookUpdateInput cannot
    // change team scope at all.
    const plan = planRegistration(["t1", "t2"], new Map(), "https://h.example.test/");
    expect(plan.create).toEqual(["t1", "t2"]);
    expect(plan.deleteIds).toEqual([]);
  });

  it("replaces a webhook whose URL changed, because scope cannot be updated", () => {
    const plan = planRegistration(
      ["t1"],
      new Map([["t1", { id: "w1", url: "https://old.example.test/" }]]),
      "https://new.example.test/",
    );
    expect(plan.create).toEqual(["t1"]);
    expect(plan.deleteIds).toEqual([{ id: "w1", teamId: "t1" }]);
  });

  it("leaves an unchanged registration alone", () => {
    const plan = planRegistration(
      ["t1"],
      new Map([["t1", { id: "w1", url: "https://h.example.test/" }]]),
      "https://h.example.test/",
    );
    expect(plan).toEqual({ create: [], deleteIds: [], keep: ["t1"] });
  });

  it("deletes the webhook for a team that is no longer bound", () => {
    // Otherwise unbinding a team would keep pulling its data in, which is the
    // one promise the scoping model cannot break.
    const plan = planRegistration(
      ["t1"],
      new Map([
        ["t1", { id: "w1", url: "https://h.example.test/" }],
        ["t2", { id: "w2", url: "https://h.example.test/" }],
      ]),
      "https://h.example.test/",
    );
    expect(plan.deleteIds).toEqual([{ id: "w2", teamId: "t2" }]);
    expect(plan.create).toEqual([]);
  });
});

describe("isPrivateHost — the self-test SSRF guard", () => {
  it("blocks loopback, private, and link-local targets", () => {
    for (const host of [
      "localhost", "app.localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3",
      "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", // cloud metadata
      "::1", "fd00::1", "fe80::1",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows genuine public endpoints", () => {
    for (const host of ["example.com", "hooks.acme.io", "8.8.8.8", "172.32.0.1", "192.169.0.1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe("checkWebhookUrl refuses private targets", () => {
  it("rejects a loopback URL before any request is made", () => {
    const verdict = checkWebhookUrl("https://127.0.0.1/hook");
    expect(verdict.ok).toBe(false);
  });

  it("rejects the cloud metadata address", () => {
    const verdict = checkWebhookUrl("https://169.254.169.254/latest/meta-data/");
    expect(verdict.ok).toBe(false);
  });

  it("still accepts a normal public https URL", () => {
    expect(checkWebhookUrl("https://hooks.example.com/linear").ok).toBe(true);
  });
})

describe("isPrivateHost — bypasses and false positives", () => {
  it("blocks IPv4-mapped IPv6 spellings of loopback and metadata", () => {
    // WHATWG URL normalises ::ffff:127.0.0.1 to its hex form, so the guard
    // has to understand both spellings or the block is one syntax away.
    for (const host of [
      "::ffff:127.0.0.1", "::ffff:7f00:1",
      "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
      "::",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("blocks a trailing-dot localhost and CGNAT space", () => {
    expect(isPrivateHost("localhost.")).toBe(true);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("100.127.255.255")).toBe(true);
  });

  it("does NOT refuse ordinary hostnames that merely start with fc/fd/fe80", () => {
    // The IPv6 unique-local prefixes were being tested against every
    // hostname, so real public endpoints were refused as "private
    // addresses" — a wrong answer with a nonsense explanation.
    for (const host of ["fcbarcelona.com", "fdny.gov", "fe80.example.com", "fc-hooks.acme.io"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
    expect(checkWebhookUrl("https://fcbarcelona.com/hook").ok).toBe(true);
  });

  it("still blocks genuine IPv6 private literals", () => {
    for (const host of ["::1", "fd00::1", "fe80::1", "fc00::1"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });
})
