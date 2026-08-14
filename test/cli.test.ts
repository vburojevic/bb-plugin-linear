import { describe, expect, it } from "vitest";
import { BOOLEAN_FLAGS, flagBoolean, flagNumber, flagString, parseArgs } from "../src/cli-args.js";
import { capOutput, definitionList, table } from "../src/cli-format.js";
import { createCliRunner, type CliEnvironment } from "../src/cli.js";
import { connectedState } from "../src/select/connection.js";
import type { StatusReport } from "../src/select/status.js";
import type { ViewerResult } from "../src/linear/types.js";
import type { PluginCliContext } from "@bb/plugin-sdk";

const NOW = 1_700_000_000_000;

const VIEWER: ViewerResult = {
  viewer: {
    id: "user_1",
    name: "ada",
    displayName: "Ada Lovelace",
    email: "ada@example.invalid",
    avatarUrl: null,
    organization: { id: "org_1", name: "Acme", urlKey: "acme", gitBranchFormat: null },
  },
};

function environment(overrides: Partial<CliEnvironment> = {}): CliEnvironment {
  const status: StatusReport = {
    connection: connectedState({
      result: VIEWER,
      budget: null,
      writeRefusal: null,
      checkedAt: NOW,
    }),
    now: NOW,
    teamsVisible: 3,
    bindings: null,
    unboundProjects: 0,
    sync: null,
    webhook: null,
    writeRefusal: null,
  };
  return {
    status: async () => status,
    doctor: async () => [{ label: "API key", status: "ok", detail: "set" }],
    budget: async () => ({ snapshot: null, profile: "balanced" }),
    teams: async () => ({ teams: [], bound: new Set<string>() }),
    bind: async () => ({ ok: true, message: "Bound." }),
    unbind: async () => ({ ok: true, message: "Unbound." }),
    sync: async () => 0,
    issue: async () => ({ ok: true, text: "ENG-1 — An issue" }),
    move: async () => ({ ok: true, message: "ENG-1 → Done" }),
    assign: async () => ({ ok: true, message: "ENG-1 assigned to Ada Lovelace." }),
    comment: async () => ({ ok: true, message: "Commented on ENG-1." }),
    create: async () => ({ ok: true, message: "Created ENG-2 — A new issue" }),
    set: async () => ({ ok: true, message: "ENG-1: changed priority." }),
    issues: async () => ({
      ok: true,
      rows: [["ENG-1", "In Progress", "An issue", "Ada Lovelace"]],
      message: null,
    }),
    attach: async () => ({ ok: true, message: "Attached to ENG-1." }),
    archive: async () => ({ ok: true, message: "Archived ENG-1." }),
    refresh: async () => ({ ok: true, text: "Acme · 3 teams visible." }),
    forget: async () => ({ ok: true, text: "Local copy removed." }),
    webhook: async () => ({ ok: true, text: "Not configured — the plugin polls." }),
    inbox: async () => ({ ok: true, text: "Nothing is waiting for you in Linear." }),
    start: async () => ({ ok: true, message: "Started a thread on ENG-1." }),
    link: async () => ({ ok: true, message: "Linked this thread to ENG-1." }),
    now: () => NOW,
    ...overrides,
  };
}

const CTX: PluginCliContext = { cwd: undefined, threadId: undefined, projectId: undefined };

describe("parseArgs", () => {
  it("knows argv excludes the command name", () => {
    // `bb linear issues --state started` arrives as
    // ["issues", "--state", "started"]. Forgetting that is how a subcommand
    // table silently never matches.
    const args = parseArgs(["issues", "--state", "started"]);
    expect(args.positional).toEqual(["issues"]);
    expect(flagString(args, "state")).toBe("started");
  });

  it("tells a boolean flag from a value flag", () => {
    const args = parseArgs(["issues", "--json", "ENG-1"]);
    expect(flagBoolean(args, "json")).toBe(true);
    expect(args.positional).toEqual(["issues", "ENG-1"]);
    expect(BOOLEAN_FLAGS.has("json")).toBe(true);
  });

  it("accepts --flag=value", () => {
    expect(flagString(parseArgs(["x", "--limit=30"]), "limit")).toBe("30");
  });

  it("treats a value flag at the end of argv as a boolean rather than eating nothing", () => {
    expect(flagBoolean(parseArgs(["x", "--state"]), "state")).toBe(true);
  });

  it("passes free text after -- through untouched", () => {
    const args = parseArgs(["comment", "ENG-1", "--", "looks", "--good", "to", "me"]);
    expect(args.rest.join(" ")).toBe("looks --good to me");
  });

  it("turns a nonsense --limit into no limit rather than NaN", () => {
    // NaN would flow into a SQL LIMIT and produce an error nobody can map back
    // to what they typed.
    expect(flagNumber(parseArgs(["x", "--limit", "abc"]), "limit")).toBeUndefined();
    expect(flagNumber(parseArgs(["x", "--limit", "-4"]), "limit")).toBeUndefined();
    expect(flagNumber(parseArgs(["x", "--limit", "30"]), "limit")).toBe(30);
  });
});

describe("output shaping", () => {
  it("drops a column whose every cell is empty", () => {
    // The table version of "a row says nothing when it has nothing to say".
    expect(table([["a", "", "c"], ["b", "", "d"]])).toBe("a  c\nb  d");
  });

  it("drops a definition row with no value", () => {
    expect(definitionList([["Key", "set"], ["Sync", ""]])).toBe("  Key  set");
  });

  it("caps output well under the host's atomic rejection limit", () => {
    // The host rejects an oversize result atomically — it never clips — so
    // the user would get nothing at all.
    const huge = `${"x".repeat(400_000)}\n`;
    const capped = capOutput(huge);
    expect(capped.length).toBeLessThan(400_000);
    expect(capped).toContain("output truncated");
  });
});

describe("bb linear", () => {
  it("refuses a set with no fields rather than spending a request on nothing", async () => {
    const result = await createCliRunner(
      environment({
        set: async () => ({ ok: false, message: "Nothing to change. Try --priority…" }),
      }),
    )(["set", "ENG-1"], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Nothing to change");
  });

  it("passes every set flag through as given", async () => {
    // The parsing and the name matching live server-side, where the team's own
    // projects, cycles and labels are. The runner's job is only to hand them
    // over intact.
    let seen: Record<string, unknown> = {};
    await createCliRunner(
      environment({
        set: async (args) => {
          seen = args as unknown as Record<string, unknown>;
          return { ok: true, message: "ok" };
        },
      }),
    )(
      ["set", "ENG-1", "--priority", "1", "--due", "2026-09-01", "--label", "bug"],
      CTX,
    );
    expect(seen["priority"]).toBe("1");
    expect(seen["due"]).toBe("2026-09-01");
    expect(seen["addLabel"]).toBe("bug");
  });

  it("needs a title to create an issue", async () => {
    const result = await createCliRunner(environment())(["create"], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb linear create");
  });

  it("takes the whole rest of the line as the title", async () => {
    // Quoting a title is the thing everyone forgets, and an issue called just
    // "Fix" is worse than no issue.
    let seen = "";
    await createCliRunner(
      environment({
        create: async (args) => {
          seen = args.title;
          return { ok: true, message: "ok" };
        },
      }),
    )(["create", "Fix", "the", "flaky", "test"], CTX);
    expect(seen).toBe("Fix the flaky test");
  });

  it("drops a priority outside Linear's scale rather than clamping it", async () => {
    // Clamping would silently mark something Urgent.
    let seen: number | undefined = 9;
    await createCliRunner(
      environment({
        create: async (args) => {
          seen = args.priority;
          return { ok: true, message: "ok" };
        },
      }),
    )(["create", "Something", "--priority", "9"], CTX);
    expect(seen).toBeUndefined();
  });

  it("scopes to the project it was run from, not just to --project", async () => {
    // Found live: every project-scoped command fell through to "the only
    // project", which does not exist in a bb with fifteen of them. The symptom
    // was `bb linear issues` reporting no binding from inside a bound project.
    let seen: string | undefined = "unset";
    await createCliRunner(
      environment({
        issues: async (args) => {
          seen = args.projectId;
          return { ok: true, rows: [], message: null };
        },
      }),
    )(["issues"], { ...CTX, projectId: "proj_from_cwd" });
    expect(seen).toBe("proj_from_cwd");
  });

  it("lets --project override the project it was run from", async () => {
    let seen: string | undefined = "unset";
    await createCliRunner(
      environment({
        issues: async (args) => {
          seen = args.projectId;
          return { ok: true, rows: [], message: null };
        },
      }),
    )(["issues", "--project", "proj_explicit"], { ...CTX, projectId: "proj_from_cwd" });
    expect(seen).toBe("proj_explicit");
  });

  it("lists issues as columns, so --json is data rather than rendered text", async () => {
    const result = await createCliRunner(environment())(["issues", "--json"], CTX);
    const parsed = JSON.parse(result.stdout ?? "{}") as { issues: string[][] };
    expect(parsed.issues[0]?.[0]).toBe("ENG-1");
  });

  it("refuses to archive without --yes, and says what it would archive", async () => {
    // Destructive-shaped commands confirm. A plugin command has no tty it can
    // trust, so the confirmation is a flag rather than a prompt.
    const result = await createCliRunner(
      environment({
        archive: async ({ confirmed }) =>
          confirmed
            ? { ok: true, message: "Archived ENG-1." }
            : { ok: false, message: "This archives ENG-1 — An issue. Run it again with --yes." },
      }),
    )(["archive", "ENG-1"], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
  });

  it("archives when told twice", async () => {
    const result = await createCliRunner(environment())(["archive", "ENG-1", "--yes"], CTX);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Archived ENG-1");
  });

  it("needs both an issue and a url to attach", async () => {
    const result = await createCliRunner(environment())(["attach", "ENG-1"], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb linear attach");
  });

  it("refreshes the workspace, which is a different question from the key working", async () => {
    // Replacing the API key points the plugin at a different workspace. "Check
    // again" answers whether the key works; only this answers what it can see.
    const result = await createCliRunner(
      environment({ refresh: async () => ({ ok: true, text: "Acme · 7 teams visible.\n" }) }),
    )(["refresh"], CTX);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("7 teams visible");
  });

  it("says refresh is pointless when there is no connection", async () => {
    const result = await createCliRunner(
      environment({ refresh: async () => ({ ok: false, text: "Not connected.\n" }) }),
    )(["refresh"], CTX);
    expect(result.exitCode).not.toBe(0);
  });

  it("prints usage with no arguments", async () => {
    const result = await createCliRunner(environment())([], CTX);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bb linear status");
  });

  it("fails on an unknown command instead of doing something surprising", async () => {
    const result = await createCliRunner(environment())(["frobnicate"], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command");
  });

  it("answers status", async () => {
    const result = await createCliRunner(environment())(["status"], CTX);
    expect(result.stdout).toContain("Linear · connected");
    expect(result.stdout).toContain("Acme (acme)");
  });

  it("emits report data rather than rendered text under --json", async () => {
    // A machine consumer wants `teamsVisible: 3`, not "3 teams visible" — the
    // moment a JSON field carries formatted text, somebody downstream parses
    // it back and the locale bug returns.
    const result = await createCliRunner(environment())(["status", "--json"], CTX);
    const parsed = JSON.parse(result.stdout ?? "{}") as { teamsVisible: number };
    expect(parsed.teamsVisible).toBe(3);
  });

  it("says the budget is unknown rather than implying there is none", async () => {
    const result = await createCliRunner(environment())(["budget"], CTX);
    expect(result.stdout).toContain("has not reported a budget yet");
  });

  it("routes every failure through one redacted place", async () => {
    const runner = createCliRunner(
      environment({
        status: () => {
          throw new Error("Authorization: lin_api_leakedInAnError");
        },
      }),
    );
    const result = await runner(["status"], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("leakedInAnError");
  });
});
