import { describe, expect, it } from "vitest";
import {
  authHeader,
  credentialFingerprint,
  patFromSetting,
  type LinearCredential,
} from "../src/linear/credential.js";
import { isLinearError } from "../src/linear/errors.js";
import { createTransport } from "../src/linear/transport.js";
import type { LinearDocument } from "../src/linear/documents.js";
import { budgetHeaders, fakeFetch } from "./helpers/fake-fetch.js";

const QUERY: LinearDocument = {
  name: "Probe",
  kind: "query",
  source: "query Probe { viewer { id } }",
};
const MUTATION: LinearDocument = {
  name: "Write",
  kind: "mutation",
  source: "mutation Write { issueUpdate(id: \"x\", input: {}) { success } }",
};

function transportWith(
  responses: Parameters<typeof fakeFetch>[0],
  credential: LinearCredential | null = { kind: "pat", token: "lin_api_TESTKEY0123456789" },
) {
  const fake = fakeFetch(responses);
  const logs: string[] = [];
  const transport = createTransport(
    {
      getCredential: async () => credential,
      log: (level, message) => logs.push(`${level}: ${message}`),
      now: () => 1_700_000_000_000,
    },
    { fetchImpl: fake.fetch, sleep: async () => {}, retryDelayMs: 0 },
  );
  return { transport, fake, logs };
}

describe("authHeader", () => {
  it("sends a personal API key bare and an OAuth token with Bearer", () => {
    // The single most common Linear integration mistake, and the two shapes
    // are indistinguishable in a 401.
    expect(authHeader({ kind: "pat", token: "lin_api_abc" })).toBe("lin_api_abc");
    expect(
      authHeader({
        kind: "oauth",
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: 0,
      }),
    ).toBe("Bearer tok");
  });

  it("puts the right header on the wire", async () => {
    const { transport, fake } = transportWith([{ body: { data: { viewer: { id: "1" } } } }]);
    await transport.execute(QUERY);
    expect(fake.requests[0]!.headers["authorization"]).toBe("lin_api_TESTKEY0123456789");
  });
});

describe("patFromSetting", () => {
  it("trims, because readSecret does not", () => {
    // The host's readSecret is a raw readFile, so a key pasted with a trailing
    // newline persists with one and every request 401s.
    expect(patFromSetting("lin_api_abc\n")).toEqual({ kind: "pat", token: "lin_api_abc" });
    expect(patFromSetting("  ")).toBeNull();
    expect(patFromSetting(undefined)).toBeNull();
  });
});

describe("credentialFingerprint", () => {
  it("is stable and does not contain the key", () => {
    const credential: LinearCredential = { kind: "pat", token: "lin_api_secretvalue" };
    const print = credentialFingerprint(credential);
    expect(print).toBe(credentialFingerprint(credential));
    expect(print).not.toContain("secretvalue");
    expect(print).not.toBe(
      credentialFingerprint({ kind: "pat", token: "lin_api_othervalue" }),
    );
  });
});

describe("error classification", () => {
  it("reads a rate limit out of an HTTP 400 with RATELIMITED, not a 429", async () => {
    // Linear signals rate limiting as HTTP 400 with extensions.code, and there
    // is no Retry-After. Generic retry middleware misses this twice.
    const { transport } = transportWith([
      {
        status: 400,
        headers: budgetHeaders({ "X-RateLimit-Requests-Remaining": "0" }),
        body: { errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] },
      },
    ]);
    const error = await transport.execute(QUERY).catch((value: unknown) => value);
    expect(isLinearError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("rate_limited");
    // The reset comes from the failing response's own headers.
    expect((error as { resetAt: number | null }).resetAt).toBe(1_780_000_000_000);
  });

  it("never retries a 401", async () => {
    const { transport, fake } = transportWith([
      { status: 401, body: { errors: [{ message: "nope" }] } },
      { body: { data: { viewer: { id: "1" } } } },
    ]);
    const error = await transport.execute(QUERY).catch((value: unknown) => value);
    expect((error as { code: string }).code).toBe("unauthorized");
    expect(fake.requests).toHaveLength(1);
  });

  it("treats a 200 carrying errors as a query error and does not retry it", async () => {
    const { transport, fake } = transportWith([
      { body: { errors: [{ message: "Field 'gitBranchName' doesn't exist" }] } },
      { body: { data: {} } },
    ]);
    const error = await transport.execute(QUERY).catch((value: unknown) => value);
    expect((error as { code: string }).code).toBe("query");
    expect((error as { retryable: boolean }).retryable).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  it("retries a 5xx that still carried GraphQL errors, exactly once", async () => {
    const { transport, fake } = transportWith([
      { status: 502, body: { errors: [{ message: "upstream" }] } },
      { body: { data: { viewer: { id: "1" } } } },
    ]);
    await expect(transport.execute(QUERY)).resolves.toEqual({ viewer: { id: "1" } });
    expect(fake.requests).toHaveLength(2);
  });

  it("does not retry a mutation, ever", async () => {
    const { transport, fake } = transportWith([
      { throws: Object.assign(new Error("socket hang up"), { name: "TypeError" }) },
      { body: { data: { issueUpdate: { success: true } } } },
    ]);
    await expect(transport.execute(MUTATION)).rejects.toThrow();
    // A blind retry of issueCreate is a duplicate issue.
    expect(fake.requests).toHaveLength(1);
  });

  it("classifies a non-JSON body by status", async () => {
    const { transport } = transportWith([
      { status: 503, text: "<html>maintenance</html>" },
    ]);
    const error = await transport.execute(QUERY).catch((value: unknown) => value);
    expect((error as { code: string }).code).toBe("network");
  });

  it("refuses to run at all without a credential", async () => {
    const { transport, fake } = transportWith([{ body: { data: {} } }], null);
    const error = await transport.execute(QUERY).catch((value: unknown) => value);
    expect((error as { code: string }).code).toBe("unauthorized");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("budget accounting", () => {
  it("records headers from a failure as well as a success", async () => {
    const { transport } = transportWith([
      {
        status: 400,
        headers: budgetHeaders({ "X-RateLimit-Requests-Remaining": "3" }),
        body: { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] },
      },
    ]);
    await transport.execute(QUERY).catch(() => undefined);
    // The 400 carrying RATELIMITED is the single most valuable set of headers
    // the plugin ever receives; a parser that only runs on success never sees
    // it.
    expect(transport.budget()?.requests.remaining).toBe(3);
  });
});

describe("the read circuit breaker", () => {
  const offline = { throws: Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }) };

  it("opens after three consecutive deterministic failures and refuses instantly", async () => {
    const { transport, fake, logs } = transportWith([offline]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await transport.execute(QUERY).catch(() => undefined);
    }
    const before = fake.requests.length;

    await transport.execute(QUERY).catch(() => undefined);
    expect(fake.requests.length).toBe(before); // refused without a request
    expect(transport.breaker().open).toBe(true);

    // One warn per outage, debug thereafter — a log flood is itself a
    // performance failure and `bb plugin logs` rotates at 5 MB.
    expect(logs.filter((line) => line.startsWith("warn:"))).toHaveLength(1);
  });

  it("leaves mutations ungated, because a person is asking", async () => {
    const { transport, fake } = transportWith([offline]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await transport.execute(QUERY).catch(() => undefined);
    }
    const before = fake.requests.length;
    await transport.execute(MUTATION).catch(() => undefined);
    expect(fake.requests.length).toBeGreaterThan(before);
  });

  it("does not count a query error toward an outage", async () => {
    // A bad issue id must not be able to take the panel down.
    const { transport } = transportWith([{ body: { errors: [{ message: "bad id" }] } }]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await transport.execute(QUERY).catch(() => undefined);
    }
    expect(transport.breaker().open).toBe(false);
  });
});

describe("single flight", () => {
  it("keeps exactly one request in the air", async () => {
    let inFlight = 0;
    let peak = 0;
    const transport = createTransport(
      {
        getCredential: async () => ({ kind: "pat", token: "lin_api_TESTKEY0123456789" }),
      },
      {
        fetchImpl: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return {
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ data: { ok: true } }),
          };
        },
      },
    );

    await Promise.all([
      transport.execute(QUERY),
      transport.execute(QUERY),
      transport.execute(QUERY),
    ]);
    expect(peak).toBe(1);
  });

  it("lets a person's click jump ahead of queued background work", async () => {
    // Found live: `bb linear doctor` timed out against the bb CLI's own
    // two-second budget because its request had queued behind the first
    // backfill. Everything looked healthy; the command just never answered.
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let call = 0;
    const transport = createTransport(
      { getCredential: async () => ({ kind: "pat", token: "lin_api_TESTKEY0123456789" }) },
      {
        fetchImpl: async (_url, init) => {
          const name = (JSON.parse(init.body) as { operationName: string }).operationName;
          call += 1;
          if (call === 1) await gate;
          order.push(name);
          return {
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ data: { ok: true } }),
          };
        },
      },
    );

    // One background request occupies the lane, then two more queue behind it,
    // and a user request arrives last.
    const first = transport.execute({ ...QUERY, name: "First" }, { initiator: "background" });
    const bg1 = transport.execute({ ...QUERY, name: "Background1" }, { initiator: "background" });
    const bg2 = transport.execute({ ...QUERY, name: "Background2" }, { initiator: "background" });
    const user = transport.execute({ ...QUERY, name: "UserClick" }, { initiator: "user" });

    release();
    await Promise.all([first, bg1, bg2, user]);

    expect(order[0]).toBe("First");
    // The click goes next, ahead of both queued background requests.
    expect(order[1]).toBe("UserClick");
    expect(order.slice(2).sort()).toEqual(["Background1", "Background2"]);
  });

  it("does not let one failure poison the lane", async () => {
    const { transport } = transportWith([
      { status: 401, body: { errors: [{ message: "no" }] } },
      { body: { data: { viewer: { id: "1" } } } },
    ]);
    await transport.execute(QUERY).catch(() => undefined);
    await expect(transport.execute(QUERY)).resolves.toEqual({ viewer: { id: "1" } });
  });
});
