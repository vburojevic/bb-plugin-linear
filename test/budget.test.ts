import { describe, expect, it } from "vitest";
import {
  allowUserRequest,
  budgetPressure,
  governBackgroundInterval,
  parseBudgetHeaders,
  parseResetAt,
  type BudgetSnapshot,
} from "../src/linear/budget.js";

const NOW = 1_700_000_000_000;

function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

function snapshot(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    at: NOW,
    requests: { limit: 2500, remaining: 2000, resetAt: NOW + 60_000 },
    complexity: { limit: 3_000_000, remaining: 2_900_000, resetAt: NOW + 60_000 },
    endpoint: { limit: null, remaining: null, resetAt: null, name: null },
    lastComplexity: 12,
    ...overrides,
  };
}

describe("parseResetAt", () => {
  it("accepts all three plausible encodings, because Linear documents none of them", () => {
    expect(parseResetAt("1780000000000", NOW)).toBe(1_780_000_000_000); // epoch ms
    expect(parseResetAt("1780000000", NOW)).toBe(1_780_000_000_000); // epoch seconds
    expect(parseResetAt("42", NOW)).toBe(NOW + 42_000); // seconds from now
  });

  it("accepts a date string", () => {
    expect(parseResetAt("2026-08-12T10:00:00.000Z", NOW)).toBe(
      Date.parse("2026-08-12T10:00:00.000Z"),
    );
  });

  it("answers null rather than inventing a reset time", () => {
    // A reset silently 55 years in the past is worse than no reset: the UI
    // would render "resets 01:00" and the governor would think it had already
    // refilled.
    expect(parseResetAt("later", NOW)).toBeNull();
    expect(parseResetAt("", NOW)).toBeNull();
    expect(parseResetAt(null, NOW)).toBeNull();
    expect(parseResetAt("-5", NOW)).toBeNull();
  });
});

describe("parseBudgetHeaders", () => {
  it("reads Linear's real header spellings", () => {
    const parsed = parseBudgetHeaders(
      headers({
        "X-Complexity": "37",
        "X-RateLimit-Requests-Limit": "2500",
        "X-RateLimit-Requests-Remaining": "2381",
        "X-RateLimit-Requests-Reset": "1780000000",
        "X-RateLimit-Complexity-Limit": "3000000",
        "X-RateLimit-Complexity-Remaining": "2999000",
        "X-RateLimit-Endpoint-Requests-Limit": "30",
        "X-RateLimit-Endpoint-Requests-Remaining": "29",
        "X-RateLimit-Endpoint-Name": "searchIssues",
      }),
      NOW,
    );
    expect(parsed?.requests).toEqual({
      limit: 2500,
      remaining: 2381,
      resetAt: 1_780_000_000_000,
    });
    expect(parsed?.endpoint.name).toBe("searchIssues");
    expect(parsed?.lastComplexity).toBe(37);
  });

  it("returns null for a response that carried none, and never throws on an unfamiliar set", () => {
    // The stated mitigation for the one rate-limiting fact that could not be
    // verified offline: a missing header means "unknown budget", which the
    // governor reads as the conservative cadence.
    expect(parseBudgetHeaders(headers({}), NOW)).toBeNull();
    expect(parseBudgetHeaders(headers({ "X-Some-Future-Header": "yes" }), NOW)).toBeNull();
    expect(() => parseBudgetHeaders(headers({ "X-RateLimit-Requests-Limit": "" }), NOW)).not.toThrow();
  });
});

describe("budgetPressure", () => {
  it("is unknown when nothing is known", () => {
    expect(budgetPressure(null)).toBe("unknown");
  });

  it("takes the worst of the three buckets", () => {
    // A healthy hourly request budget is no comfort when the 30-per-minute
    // search bucket is empty.
    const value = budgetPressure(
      snapshot({ endpoint: { limit: 30, remaining: 1, resetAt: null, name: "searchIssues" } }),
    );
    expect(value).toBe("critical");
  });

  it("crosses at 20% and 5%", () => {
    expect(budgetPressure(snapshot())).toBe("healthy");
    expect(
      budgetPressure(snapshot({ requests: { limit: 2500, remaining: 475, resetAt: null } })),
    ).toBe("low");
    expect(
      budgetPressure(snapshot({ requests: { limit: 2500, remaining: 100, resetAt: null } })),
    ).toBe("critical");
  });
});

describe("governBackgroundInterval", () => {
  const ceilings = { warm: 120_000, cold: 600_000 };

  it("only ever slows down", () => {
    // The tier calculation already decided how urgent this poll is; the
    // governor's only authority is to make it rarer.
    expect(governBackgroundInterval(10_000, "healthy", ceilings)).toBe(10_000);
    expect(governBackgroundInterval(900_000, "low", ceilings)).toBe(900_000);
  });

  it("clamps an unknown budget to Warm rather than assuming headroom", () => {
    expect(governBackgroundInterval(10_000, "unknown", ceilings)).toBe(120_000);
  });

  it("clamps to Warm at low and Cold at critical", () => {
    expect(governBackgroundInterval(10_000, "low", ceilings)).toBe(120_000);
    expect(governBackgroundInterval(10_000, "critical", ceilings)).toBe(600_000);
  });
});

describe("allowUserRequest", () => {
  it("lets a click through at 19% and at 4%", () => {
    // Discretionary background work yields first; the person's click yields
    // last.
    expect(
      allowUserRequest(snapshot({ requests: { limit: 2500, remaining: 475, resetAt: null } }))
        .allowed,
    ).toBe(true);
    expect(
      allowUserRequest(snapshot({ requests: { limit: 2500, remaining: 100, resetAt: null } }))
        .allowed,
    ).toBe(true);
  });

  it("refuses below 2% and names the reset", () => {
    const verdict = allowUserRequest(
      snapshot({ requests: { limit: 2500, remaining: 10, resetAt: NOW + 300_000 } }),
    );
    expect(verdict).toEqual({ allowed: false, resetAt: NOW + 300_000 });
  });

  it("allows the request when the budget is unknown", () => {
    // Refusing a click because telemetry is missing would turn a header rename
    // at Linear into a plugin that appears broken.
    expect(allowUserRequest(null).allowed).toBe(true);
  });
});
