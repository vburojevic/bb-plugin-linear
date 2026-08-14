import { describe, expect, it } from "vitest";
import type { Accounts, AccountIdentity, AccountTeam } from "../src/accounts.js";
import { runCli } from "../src/cli.js";
import { unauthorized } from "../src/linear/errors.js";
import type { KeySlot } from "../src/settings.js";

/**
 * The CLI is a pure function over an Accounts interface, so these tests hand
 * it a hand-rolled fake and assert on sentences. No fake host, no network —
 * `test/setup.ts` makes sure of the second part.
 */

const ada: AccountIdentity = {
  userId: "user_1",
  userName: "ada",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  orgId: "org_1",
  orgName: "Analytical Engines",
  orgUrlKey: "analytical-engines",
  gitBranchFormat: null,
};

function fakeAccounts(overrides: Partial<Accounts> = {}): Accounts {
  const teams: AccountTeam[] = [{ id: "team_1", key: "ENG", name: "Engineering" }];
  return {
    configuredSlots: () => Promise.resolve([1 as KeySlot]),
    transport: () =>
      ({
        budget: () => null,
        breaker: () => ({
          open: false,
          openUntil: 0,
          consecutiveFailures: 0,
          lastError: null,
        }),
        execute: () => Promise.reject(new Error("not under test")),
      }) as unknown as ReturnType<Accounts["transport"]>,
    identity: () => Promise.resolve(ada),
    teams: () => Promise.resolve(teams),
    createIssue: () =>
      Promise.resolve({
        id: "issue_1",
        identifier: "ENG-1",
        title: "First",
        url: "https://linear.app/analytical-engines/issue/ENG-1/first",
        branchName: "ada/eng-1-first",
      }),
    ...overrides,
  };
}

describe("bb linear doctor", () => {
  it("says how to configure when no key is set, and fails", async () => {
    const result = await runCli(["doctor"], {
      accounts: fakeAccounts({ configuredSlots: () => Promise.resolve([]) }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb plugin config linear set apiKey");
  });

  it("names the person and the workspace when the key works", async () => {
    const result = await runCli(["doctor"], { accounts: fakeAccounts() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "connected as Ada Lovelace (ada@example.com) in Analytical Engines (analytical-engines)",
    );
    expect(result.stdout).toContain("not built yet (M2)");
  });

  it("reports a failing slot in a sentence and exits nonzero", async () => {
    const result = await runCli(["doctor"], {
      accounts: fakeAccounts({
        identity: () => Promise.reject(unauthorized("Linear rejected the API key.")),
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Slot 1: Linear rejected the API key.");
  });
});

describe("bb linear create", () => {
  it("creates in the one matching team and prints identifier, url and branch", async () => {
    const result = await runCli(
      ["create", "--team", "eng", "--title", "First"],
      { accounts: fakeAccounts() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ENG-1  First");
    expect(result.stdout).toContain("branch: ada/eng-1-first");
  });

  it("refuses ambiguity across accounts, naming both sides", async () => {
    const accounts = fakeAccounts({
      configuredSlots: () => Promise.resolve([1, 2] as KeySlot[]),
      teams: () =>
        Promise.resolve([{ id: "team_1", key: "ENG", name: "Engineering" }]),
    });
    const result = await runCli(["create", "--team", "eng", "--title", "X"], {
      accounts,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("matches more than one team");
    expect(result.stderr).toContain("--account 1");
    expect(result.stderr).toContain("--account 2");
  });

  it("demands a team and a title", async () => {
    const result = await runCli(["create"], { accounts: fakeAccounts() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});
