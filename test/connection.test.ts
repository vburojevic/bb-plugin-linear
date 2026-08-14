import { describe, expect, it } from "vitest";
import {
  classifyVerificationFailure,
  connectedState,
  describeConnection,
} from "../src/select/connection.js";
import {
  budgetExhausted,
  networkFailure,
  queryFailed,
  rateLimited,
  unauthorized,
} from "../src/linear/errors.js";
import { renderDoctor, renderStatus, type StatusReport } from "../src/select/status.js";
import type { ViewerResult } from "../src/linear/types.js";

const VIEWER: ViewerResult = {
  viewer: {
    id: "user_1",
    name: "ada",
    displayName: "Ada Lovelace",
    email: "ada@example.invalid",
    avatarUrl: null,
    organization: {
      id: "org_1",
      name: "Acme",
      urlKey: "acme",
      gitBranchFormat: null,
    },
  },
};

const NOW = 1_700_000_000_000;

describe("connectedState", () => {
  it("names the workspace, because a user with two accounts pastes the wrong key once", () => {
    const state = connectedState({
      result: VIEWER,
      budget: null,
      writeRefusal: null,
      checkedAt: NOW,
    });
    expect(state).toMatchObject({
      kind: "connected",
      viewer: { displayName: "Ada Lovelace" },
      workspace: { name: "Acme", urlKey: "acme" },
    });
  });

  it("carries no email and no key material to the frontend", () => {
    const state = connectedState({
      result: VIEWER,
      budget: null,
      writeRefusal: null,
      checkedAt: NOW,
    });
    expect(JSON.stringify(state)).not.toContain("example.invalid");
  });
});

describe("classifyVerificationFailure", () => {
  it("tells an invalid key from a revoked one by whether it ever worked", () => {
    // Linear answers 401 for both. Without the stored fact, the plugin would
    // tell someone who has been working all week that their key "may be
    // mistyped", sending them to check a field that is fine.
    const fresh = classifyVerificationFailure({
      error: unauthorized("nope"),
      hasVerifiedBefore: false,
    });
    const known = classifyVerificationFailure({
      error: unauthorized("nope"),
      hasVerifiedBefore: true,
    });
    expect(fresh.kind).toBe("invalid-key");
    expect(known.kind).toBe("revoked");
    expect(fresh).not.toEqual(known);
  });

  it("separates a network failure from a rejected key", () => {
    const state = classifyVerificationFailure({
      error: networkFailure("ECONNREFUSED"),
      hasVerifiedBefore: true,
    });
    expect(state.kind).toBe("unreachable");
  });

  it("carries the reset time through a rate limit", () => {
    const state = classifyVerificationFailure({
      error: rateLimited("used up", NOW + 300_000),
      hasVerifiedBefore: true,
    });
    expect(state).toMatchObject({ kind: "rate-limited", resetAt: NOW + 300_000 });
    expect(
      classifyVerificationFailure({
        error: budgetExhausted("held back", NOW),
        hasVerifiedBefore: true,
      }).kind,
    ).toBe("rate-limited");
  });

  it("does not pretend a query error is an auth problem", () => {
    const state = classifyVerificationFailure({
      error: queryFailed([{ message: "Cannot query field 'gitBranchName'" }], 200),
      hasVerifiedBefore: true,
    });
    expect(state.kind).toBe("error");
  });

  it("handles a non-Linear throw", () => {
    const state = classifyVerificationFailure({
      error: new TypeError("undefined is not a function"),
      hasVerifiedBefore: false,
    });
    expect(state).toEqual({ kind: "error", message: "undefined is not a function" });
  });
});

describe("describeConnection", () => {
  it("has a sentence for every state", () => {
    const states = [
      { kind: "no-credential" },
      connectedState({ result: VIEWER, budget: null, writeRefusal: null, checkedAt: NOW }),
      { kind: "invalid-key", message: "x" },
      { kind: "revoked", message: "x" },
      { kind: "unreachable", message: "x" },
      { kind: "rate-limited", message: "x", resetAt: null },
      { kind: "error", message: "x" },
    ] as const;
    for (const state of states) {
      expect(describeConnection(state).length).toBeGreaterThan(0);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

function report(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    connection: connectedState({
      result: VIEWER,
      budget: null,
      writeRefusal: null,
      checkedAt: NOW,
    }),
    now: NOW,
    teamsVisible: null,
    bindings: null,
    unboundProjects: 0,
    sync: null,
    webhook: null,
    writeRefusal: null,
    ...overrides,
  };
}

describe("renderStatus", () => {
  it("says nothing about a milestone that has nothing to say", () => {
    // A `Sync  not implemented` line would describe the plugin's construction
    // rather than the user's workspace.
    const text = renderStatus(report());
    expect(text).toContain("Workspace");
    expect(text).not.toContain("Sync");
    expect(text).not.toContain("Bindings");
    expect(text).not.toContain("Webhook");
  });

  it("never claims a key's permissions before a write has been refused", () => {
    // Key scopes are not introspectable: there is no `apiKeys` or
    // `viewerScopes` root field anywhere in the SDL.
    expect(renderStatus(report())).not.toContain("Write");
    const refused = renderStatus(
      report({ writeRefusal: { at: NOW, what: "this key is read-only" } }),
    );
    expect(refused).toContain("this key is read-only");
  });

  it("never prints a team denominator", () => {
    // `teams` returns "All teams whose issues the user can access", so a
    // team-restricted key cannot see the teams it is restricted away from and
    // the denominator is unknowable.
    const text = renderStatus(report({ teamsVisible: 3 }));
    expect(text).toContain("3 teams visible");
    expect(text).not.toMatch(/\bof\s+\d+\s+teams/);
  });

  it("tells an unconfigured plugin what to do", () => {
    const text = renderStatus(report({ connection: { kind: "no-credential" } }));
    expect(text).toContain("bb plugin config linear set apiKey");
    // Never a navigation breadcrumb: bb shows plugin management under
    // Extensions only when that collection is enabled, and under
    // Settings → Plugins otherwise.
    expect(text).not.toContain("Extensions");
  });
});

describe("renderDoctor", () => {
  it("puts failures first, because that is why anyone ran it", () => {
    const text = renderDoctor([
      { label: "API key", status: "ok", detail: "set" },
      { label: "Linear", status: "fail", detail: "rejected", fix: "Save a new key." },
      { label: "Budget", status: "warn", detail: "low" },
    ]);
    expect(text.indexOf("Linear")).toBeLessThan(text.indexOf("Budget"));
    expect(text.indexOf("Budget")).toBeLessThan(text.indexOf("API key"));
    expect(text).toContain("1 problem to fix");
  });

  it("attaches a fix only where there is something to do", () => {
    const text = renderDoctor([
      { label: "API key", status: "ok", detail: "set", fix: "should never appear" },
    ]);
    expect(text).not.toContain("should never appear");
    expect(text).toContain("everything this can check is working");
  });
});
