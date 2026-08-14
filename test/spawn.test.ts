import { describe, expect, it } from "vitest";
import {
  buildSpawnRequest,
  startedStateFor,
  type SpawnIssue,
  type SpawnPreconditions,
} from "../src/automations/spawn.js";
import { state } from "./helpers/store.js";

const ISSUE: SpawnIssue = {
  id: "i_1",
  identifier: "ENG-42",
  title: "Fix the flaky login test",
  description: "The test fails about one run in six.\n\n- [ ] Reproduce it\n- [ ] Fix it",
  url: "https://linear.app/acme/issue/ENG-42",
  branchName: "ada/eng-42-fix-the-flaky-login-test",
  priorityLabel: "Urgent",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "Ada Lovelace",
  dueDate: null,
  labels: ["bug"],
  comments: [{ author: "Kai Rivers", body: "Happens on CI too." }],
  subIssues: [{ identifier: "ENG-43", title: "Reproduce", done: true }],
  parent: null,
};

const READY: SpawnPreconditions = {
  branchExists: true,
  branchListComplete: true,
  treeClean: true,
  hostId: "host_1",
  workspacePath: "/repo",
};

function plan(mode: "title" | "exact", preconditions: Partial<SpawnPreconditions> = {}) {
  return buildSpawnRequest({
    issue: ISSUE,
    projectId: "proj_1",
    mode,
    preconditions: { ...READY, ...preconditions },
  });
}

describe("buildSpawnRequest", () => {
  it("never sets parentThreadId", () => {
    // A hidden child thread reports its turns and blockers to its parent as a
    // user message, so a plugin-spawned thread with a parent injects its own
    // progress into somebody else's conversation.
    const request = plan("title").request as unknown as Record<string, unknown>;
    expect(request["parentThreadId"]).toBeUndefined();
    expect(Object.keys(request)).not.toContain("parentThreadId");
  });

  it("puts the identifier first in the title so bb's derived slug carries it", () => {
    // Linear's branch autolink matches on the identifier appearing in the
    // branch name, and bb derives that name from the thread title.
    expect(plan("title").request.title).toBe("ENG-42 Fix the flaky login test");
  });

  it("truncates a long title so the derived slug stays useful", () => {
    const long = { ...ISSUE, title: "x".repeat(200) };
    const built = buildSpawnRequest({
      issue: long,
      projectId: "p",
      mode: "title",
      preconditions: READY,
    });
    expect(built.request.title.length).toBeLessThan(100);
    expect(built.request.title.startsWith("ENG-42 ")).toBe(true);
  });

  it("splits the prompt into a human half and an agent-only half", () => {
    const [visible, agentOnly] = plan("title").request.input;
    expect(visible?.visibility).toBeUndefined();
    expect(agentOnly?.visibility).toBe("agent-only");

    // The visible part is a sentence somebody can read three days later.
    expect(visible?.text).toContain("ENG-42 — Fix the flaky login test");
    expect(visible?.text).toContain("https://linear.app/acme/issue/ENG-42");
    // And it does not duplicate the body.
    expect(visible?.text).not.toContain("one run in six");

    // The agent-only part carries the body, the criteria and the comments.
    expect(agentOnly?.text).toContain("one run in six");
    expect(agentOnly?.text).toContain("[ ] Reproduce it");
    expect(agentOnly?.text).toContain("Kai Rivers: Happens on CI too.");
    expect(agentOnly?.text).toContain("call linear_team_context");
  });

  it("uses the project default environment in title mode", () => {
    expect(plan("title").request.environment).toEqual({ type: "project-default" });
    expect(plan("title").note).toBeNull();
  });

  it("checks out the exact branch only when it exists and the tree is clean", () => {
    const built = plan("exact");
    expect(built.mode).toBe("exact");
    expect(built.request.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "unmanaged",
        path: "/repo",
        branch: { kind: "existing", name: "ada/eng-42-fix-the-flaky-login-test" },
      },
    });
  });

  it("falls back and says so when the branch does not exist", () => {
    // `{ kind: "existing" }` throws `checkout_missing_branch` when the branch
    // is absent, and the plugin deliberately does not create it.
    const built = plan("exact", { branchExists: false });
    expect(built.mode).toBe("title");
    expect(built.note).toContain("doesn't exist yet");
  });

  it("falls back when the branch list was truncated, rather than guessing", () => {
    // A branch absent from a TRUNCATED list is not a branch that does not
    // exist. Guessing would silently downgrade exact mode on any repository
    // with a lot of branches.
    const built = plan("exact", { branchExists: false, branchListComplete: false });
    expect(built.mode).toBe("title");
    expect(built.note).toContain("couldn't confirm");
  });

  it("falls back on a dirty tree", () => {
    const built = plan("exact", { treeClean: false });
    expect(built.mode).toBe("title");
    expect(built.note).toContain("uncommitted changes");
  });

  it("falls back when there is no host to check out on", () => {
    const built = plan("exact", { hostId: null });
    expect(built.mode).toBe("title");
    expect(built.note).toContain("no host");
  });
});

describe("startedStateFor", () => {
  it("takes the lowest-position started state, never a name match", () => {
    // A workspace with "Building", "In Progress" and "Doing" has three started
    // states, and a workspace with "Überprüfung" has none any English match
    // would find.
    const states = [
      state("s_doing", "t", "started", 3, "Doing"),
      state("s_build", "t", "started", 1, "Building"),
      state("s_todo", "t", "unstarted", 0, "Todo"),
    ];
    expect(startedStateFor(states)?.name).toBe("Building");
  });

  it("answers null when a team has no started state at all", () => {
    expect(startedStateFor([state("s_todo", "t", "unstarted", 0)])).toBeNull();
  });
});
