import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCUMENTS, type LinearDocument } from "../src/linear/documents.js";
import { isLinearError } from "../src/linear/errors.js";
import { createTransport, type MutationVerdict } from "../src/linear/transport.js";
import { SETTING_DESCRIPTORS } from "../src/settings.js";
import { toolsFor } from "../src/tools.js";
import {
  effectiveAgentWrites,
  mutationVerdict,
  WRITE_CONSENT_REMEDY,
  writesAllowed,
} from "../src/write-gate.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

/**
 * Write consent, proven three ways:
 *
 *   1. **The pure gate**, walked across the ENTIRE document registry — every
 *      mutation the plugin can ever send is refused without consent and
 *      allowed with it, including mutations added after this test was
 *      written, because the walk is registry-driven rather than a list.
 *   2. **The transport**, where the gate is enforced: a refused mutation
 *      never reaches fetch, spends no budget, trips no breaker, wedges no
 *      queue — and a consent check that throws refuses rather than allows.
 *   3. **The wiring**, pinned: the server installs the gate on every client
 *      session, and the default is off.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. The pure gate, across the whole registry                                */
/* ────────────────────────────────────────────────────────────────────────── */

const MUTATIONS = DOCUMENTS.filter((document) => document.kind === "mutation");
const QUERIES = DOCUMENTS.filter((document) => document.kind === "query");

describe("the registry walk cannot pass vacuously", () => {
  it("has real mutations to gate", () => {
    // If the registry ever ended up empty here, every per-document test
    // below would silently vanish and the suite would still be green.
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(8);
  });

  it("has real queries to leave alone", () => {
    expect(QUERIES.length).toBeGreaterThanOrEqual(10);
  });
});

describe("every mutation in the registry", () => {
  for (const document of MUTATIONS) {
    describe(document.name, () => {
      it("is refused without consent", () => {
        const verdict = mutationVerdict(document, false);
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
          expect(isLinearError(verdict.refusal)).toBe(true);
          expect(verdict.refusal.code).toBe("refused");
          expect(verdict.refusal.message).toBe(WRITE_CONSENT_REMEDY);
          // A refusal must never be retried into a different answer.
          expect(verdict.refusal.retryable).toBe(false);
        }
      });

      it("is allowed with consent", () => {
        expect(mutationVerdict(document, true)).toEqual({ allowed: true });
      });
    });
  }
});

describe("every query in the registry", () => {
  for (const document of QUERIES) {
    it(`${document.name} is allowed in BOTH consent states`, () => {
      // A gate that could refuse a read would make consent look like an
      // outage. Reads are untouched, always.
      expect(mutationVerdict(document, false)).toEqual({ allowed: true });
      expect(mutationVerdict(document, true)).toEqual({ allowed: true });
    });
  }
});

describe("writesAllowed", () => {
  it("is true only for an explicit true", () => {
    expect(writesAllowed({ allowWrites: true })).toBe(true);
  });

  it("is false for false", () => {
    expect(writesAllowed({ allowWrites: false })).toBe(false);
  });

  it("reads absence as no consent", () => {
    // An older install, an unparseable settings row — absence of an answer
    // is not a yes.
    expect(writesAllowed({ allowWrites: undefined as unknown as boolean })).toBe(false);
  });
});

describe("the remedy sentence", () => {
  it("names the exact command", () => {
    expect(WRITE_CONSENT_REMEDY).toContain("bb plugin config linear set allowWrites true");
  });

  it("names the setting as the settings form labels it", () => {
    expect(WRITE_CONSENT_REMEDY).toContain(SETTING_DESCRIPTORS.allowWrites.label);
  });

  it("says reads still work, because they do", () => {
    expect(WRITE_CONSENT_REMEDY.toLowerCase()).toContain("reads work");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. The transport enforces it                                               */
/* ────────────────────────────────────────────────────────────────────────── */

const QUERY: LinearDocument = {
  name: "Probe",
  kind: "query",
  source: "query Probe { viewer { id } }",
};
const MUTATION: LinearDocument = {
  name: "Write",
  kind: "mutation",
  source: 'mutation Write { issueUpdate(id: "x", input: {}) { success } }',
};

function transportWith(
  responses: Parameters<typeof fakeFetch>[0],
  gateMutation?: (document: LinearDocument) => MutationVerdict | Promise<MutationVerdict>,
) {
  const fake = fakeFetch(responses);
  const transport = createTransport(
    {
      getCredential: async () => ({ kind: "pat", token: "lin_api_TESTKEY0123456789" }),
      ...(gateMutation === undefined ? {} : { gateMutation }),
      now: () => 1_700_000_000_000,
    },
    { fetchImpl: fake.fetch, sleep: async () => {}, retryDelayMs: 0 },
  );
  return { transport, fake };
}

const OK_BODY = { body: { data: { ok: true } } };

describe("transport: a refused mutation", () => {
  it("never reaches the network", async () => {
    const { transport, fake } = transportWith([OK_BODY], (document) =>
      mutationVerdict(document, false),
    );
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({
      code: "refused",
      message: WRITE_CONSENT_REMEDY,
    });
    expect(fake.requests.length).toBe(0);
  });

  it("spends no budget and trips no breaker", async () => {
    const { transport } = transportWith([OK_BODY], (document) =>
      mutationVerdict(document, false),
    );
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({ code: "refused" });
    // No response was ever received, so there is nothing to know about the
    // budget — and a refusal is the plugin's own answer, not an outage.
    expect(transport.budget()).toBeNull();
    expect(transport.breaker().open).toBe(false);
    expect(transport.breaker().consecutiveFailures).toBe(0);
  });

  it("does not wedge the queue for the reads behind it", async () => {
    const { transport, fake } = transportWith([OK_BODY], (document) =>
      mutationVerdict(document, false),
    );
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({ code: "refused" });
    await expect(transport.execute<{ ok: boolean }>(QUERY)).resolves.toEqual({ ok: true });
    expect(fake.requests.length).toBe(1);
  });

  it("refuses every mutation shape in the registry at the transport too", async () => {
    // Belt over braces: the pure walk above proves the verdict; this proves
    // the transport asks for it, per real document.
    for (const document of MUTATIONS) {
      const { transport, fake } = transportWith([OK_BODY], (candidate) =>
        mutationVerdict(candidate, false),
      );
      await expect(transport.execute(document)).rejects.toMatchObject({ code: "refused" });
      expect(fake.requests.length).toBe(0);
    }
  });
});

describe("transport: consent flows", () => {
  it("sends a mutation once consent says yes", async () => {
    const { transport, fake } = transportWith([OK_BODY], (document) =>
      mutationVerdict(document, true),
    );
    await expect(transport.execute<{ ok: boolean }>(MUTATION)).resolves.toEqual({ ok: true });
    expect(fake.requests.length).toBe(1);
  });

  it("reads consent fresh per request, so a flip needs no reload", async () => {
    let consent = false;
    const { transport, fake } = transportWith([OK_BODY, OK_BODY], (document) =>
      mutationVerdict(document, consent),
    );
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({ code: "refused" });
    consent = true;
    await expect(transport.execute<{ ok: boolean }>(MUTATION)).resolves.toEqual({ ok: true });
    expect(fake.requests.length).toBe(1);
  });

  it("honours an async gate", async () => {
    const { transport, fake } = transportWith([OK_BODY], async (document) => {
      await Promise.resolve();
      return mutationVerdict(document, false);
    });
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({ code: "refused" });
    expect(fake.requests.length).toBe(0);
  });

  it("hands the gate the actual document, so policy could ever narrow by name", async () => {
    const seen: string[] = [];
    const { transport } = transportWith([OK_BODY], (document) => {
      seen.push(document.name);
      return mutationVerdict(document, true);
    });
    await transport.execute(MUTATION);
    expect(seen).toEqual(["Write"]);
  });

  it("never consults the gate for a query", async () => {
    let asked = 0;
    const { transport } = transportWith([OK_BODY], (document) => {
      asked += 1;
      return mutationVerdict(document, false);
    });
    await expect(transport.execute<{ ok: boolean }>(QUERY)).resolves.toEqual({ ok: true });
    expect(asked).toBe(0);
  });

  it("sends when no gate is installed, because policy belongs to the session", async () => {
    // The transport is also test infrastructure; the plugin's server always
    // installs the gate, and the wiring pin below proves that.
    const { transport, fake } = transportWith([OK_BODY]);
    await expect(transport.execute<{ ok: boolean }>(MUTATION)).resolves.toEqual({ ok: true });
    expect(fake.requests.length).toBe(1);
  });
});

describe("transport: the gate fails closed", () => {
  it("a throwing gate refuses the write", async () => {
    const { transport, fake } = transportWith([OK_BODY], () => {
      throw new Error("settings table on fire");
    });
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({ code: "refused" });
    expect(fake.requests.length).toBe(0);
  });

  it("a rejecting async gate refuses the write", async () => {
    const { transport, fake } = transportWith([OK_BODY], async () => {
      return Promise.reject(new Error("kv unreachable"));
    });
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({ code: "refused" });
    expect(fake.requests.length).toBe(0);
  });

  it("says the CHECK failed, not that consent was withheld", async () => {
    // The two refusals deserve different sentences: one asks the user to
    // flip a switch, the other reports a bug.
    const { transport } = transportWith([OK_BODY], () => {
      throw new Error("settings table on fire");
    });
    await expect(transport.execute(MUTATION)).rejects.toMatchObject({
      message: expect.stringContaining("write-consent check failed"),
    });
  });

  it("a throwing gate is not counted toward the read breaker", async () => {
    const { transport } = transportWith([OK_BODY, OK_BODY, OK_BODY, OK_BODY], () => {
      throw new Error("boom");
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(transport.execute(MUTATION)).rejects.toMatchObject({ code: "refused" });
    }
    expect(transport.breaker().open).toBe(false);
    await expect(transport.execute<{ ok: boolean }>(QUERY)).resolves.toEqual({ ok: true });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 3. The wiring is pinned                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe("the switch itself", () => {
  it("ships allowWrites as a boolean defaulting to on", () => {
    // Revised at the owner's direction from opt-in consent to a one-flip
    // read-only switch: writes work out of the box, and turning the switch
    // off puts every guarantee in this file into effect.
    expect(SETTING_DESCRIPTORS.allowWrites.type).toBe("boolean");
    expect(SETTING_DESCRIPTORS.allowWrites.default).toBe(true);
  });

  it("explains itself in the settings form", () => {
    expect(SETTING_DESCRIPTORS.allowWrites.label).toBe("Allow changes to Linear");
    expect(SETTING_DESCRIPTORS.allowWrites.description).toContain("read-only");
  });
});

describe("the server installs the gate on every client session", () => {
  // Source-level pin, in the spirit of the predecessor's "no updateSettings"
  // grep: the structural guarantee holds only while the one client factory
  // call site wires the gate, so a refactor that drops it fails here.
  const serverSource = readFileSync(
    fileURLToPath(new URL("../server.ts", import.meta.url)),
    "utf8",
  );

  it("wires gateMutation into the client factory", () => {
    expect(serverSource).toContain("gateMutation: async (document) =>");
    expect(serverSource).toContain("mutationVerdict(document, writesAllowed(await settings.get()))");
  });

  it("clamps agent tools through the master switch", () => {
    expect(serverSource).toContain("effectiveAgentWrites(");
  });

  it("short-circuits both automations on consent", () => {
    const guards = serverSource.match(/if \(!writesAllowed\(values\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* 4. What agents are offered                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe("effectiveAgentWrites", () => {
  it("clamps every configuration to off without consent", () => {
    expect(effectiveAgentWrites(false, "off")).toBe("off");
    expect(effectiveAgentWrites(false, "comment")).toBe("off");
    expect(effectiveAgentWrites(false, "full")).toBe("off");
  });

  it("passes the configuration through with consent", () => {
    expect(effectiveAgentWrites(true, "off")).toBe("off");
    expect(effectiveAgentWrites(true, "comment")).toBe("comment");
    expect(effectiveAgentWrites(true, "full")).toBe("full");
  });
});

describe("the tool sets agents actually see", () => {
  const WRITE_NAMES = [
    "linear_comment",
    "linear_issue_update",
    "linear_issue_create",
    "linear_issue_relate",
    "linear_issue_attach",
    "linear_thread_start",
  ];

  it("offers no Linear-writing tool without consent, whatever agentWrites says", () => {
    for (const configured of ["off", "comment", "full"] as const) {
      const offered = toolsFor(effectiveAgentWrites(false, configured));
      for (const name of WRITE_NAMES) {
        expect(offered, `${name} offered under agentWrites=${configured}`).not.toContain(name);
      }
      // Withheld is not blinded: reads stay, and so does the local-only
      // binding pair — linear_thread_bind writes bb's table, never Linear.
      expect(offered).toContain("linear_issue_get");
      expect(offered).toContain("linear_search");
      expect(offered).toContain("linear_thread_issue");
      expect(offered).toContain("linear_thread_bind");
    }
  });

  it("offers the configured set with consent", () => {
    expect(toolsFor(effectiveAgentWrites(true, "off"))).not.toContain("linear_comment");
    expect(toolsFor(effectiveAgentWrites(true, "comment"))).toContain("linear_comment");
    expect(toolsFor(effectiveAgentWrites(true, "comment"))).not.toContain("linear_issue_update");
    for (const name of WRITE_NAMES) {
      expect(toolsFor(effectiveAgentWrites(true, "full"))).toContain(name);
    }
  });
});
