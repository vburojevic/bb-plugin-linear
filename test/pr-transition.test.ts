import { describe, expect, it } from "vitest";
import {
  decideTransition,
  matchesTargetBranch,
  noAutomationMessage,
  type AutomationState,
  type PullRequestOutcome,
  type TransitionInput,
} from "../src/automations/pr-transition.js";
import { identifierFromBranch, parseRemote } from "../src/git/remote.js";

const REVIEW: AutomationState = {
  event: "review",
  stateId: "s_review",
  stateName: "In Review",
  targetBranchPattern: null,
  targetBranchIsRegex: false,
};
const MERGE: AutomationState = {
  event: "merge",
  stateId: "s_done",
  stateName: "Done",
  targetBranchPattern: null,
  targetBranchIsRegex: false,
};
const DRAFT: AutomationState = {
  event: "draft",
  stateId: "s_draft",
  stateName: "Drafting",
  targetBranchPattern: null,
  targetBranchIsRegex: false,
};

function pr(
  state: "draft" | "open" | "merged" | "closed",
  baseRefName = "main",
): PullRequestOutcome {
  return { outcome: "available", state, baseRefName, number: 128 };
}

function decide(overrides: Partial<TransitionInput> = {}) {
  return decideTransition({
    pullRequest: pr("open"),
    automationStates: [REVIEW, MERGE, DRAFT],
    issueStateType: "started",
    issueStateId: "s_progress",
    applied: null,
    completedStateId: null,
    ...overrides,
  });
}

/**
 * The exhaustive table the whole automation rests on:
 * {available·open, available·draft, available·merged, available·closed,
 *  absent, unavailable} × {with automation, without} × {issue finished, not} ×
 * {already applied, not}.
 */
describe("decideTransition", () => {
  it("holds on `unavailable` and names it separately from `absent`", () => {
    // "The lookup failed" and "there is no pull request" are different facts
    // and only one is a reason to act. They are named separately so nobody can
    // collapse them later without deleting this test.
    const unavailable = decide({ pullRequest: { outcome: "unavailable" } });
    const absent = decide({ pullRequest: { outcome: "absent" } });

    expect(unavailable.move).toBe(false);
    expect(absent.move).toBe(false);
    expect(unavailable).toMatchObject({ reason: "lookup-unavailable" });
    expect(absent).toMatchObject({ reason: "no-pull-request" });
    expect(unavailable).not.toEqual(absent);
  });

  it("moves an open pull request to the review state", () => {
    expect(decide()).toMatchObject({ move: true, stateId: "s_review", stateName: "In Review" });
  });

  it("moves a merged pull request to the merge state", () => {
    expect(decide({ pullRequest: pr("merged") })).toMatchObject({
      move: true,
      stateId: "s_done",
    });
  });

  it("moves a draft to the draft state, and holds when none is configured", () => {
    expect(decide({ pullRequest: pr("draft") })).toMatchObject({ move: true, stateId: "s_draft" });
    expect(
      decide({ pullRequest: pr("draft"), automationStates: [REVIEW, MERGE] }),
    ).toMatchObject({ move: false, reason: "no-automation" });
  });

  it("holds on closed-not-merged, because guessing either way is worse than silence", () => {
    expect(decide({ pullRequest: pr("closed") })).toMatchObject({
      move: false,
      reason: "closed-not-merged",
    });
  });

  it("never drags a finished issue back", () => {
    for (const type of ["completed", "canceled"]) {
      expect(decide({ issueStateType: type, pullRequest: pr("merged") })).toMatchObject({
        move: false,
        reason: "issue-finished",
      });
    }
  });

  it("holds and says so when the team has configured nothing", () => {
    // The one place a name match would have been tempting. A workspace whose
    // review column is called "Überprüfung" would silently resolve to the
    // lowest-position started state and move In Progress to In Progress with
    // no error to search for.
    const held = decide({ automationStates: [] });
    expect(held).toMatchObject({ move: false, reason: "no-automation" });
    expect(noAutomationMessage({ teamName: "Engineering", identifier: "ENG-42" })).toContain(
      "no git automation configured in Linear",
    );
  });

  it("tells a configured event with no state apart from nothing configured", () => {
    // `GitAutomationState.state` is nullable, and a configured event with no
    // state is a deliberate "do nothing".
    const held = decide({
      automationStates: [{ ...REVIEW, stateId: null, stateName: null }],
    });
    expect(held).toMatchObject({ move: false, reason: "no-state-configured" });
  });

  it("uses the per-binding override only for merge, where type identifies the state", () => {
    // A completed state is identifiable by `type`, not by name, so this
    // fallback is safe in any language — which is exactly why review has no
    // equivalent.
    expect(
      decide({
        pullRequest: pr("merged"),
        automationStates: [],
        completedStateId: "s_done_override",
      }),
    ).toMatchObject({ move: true, stateId: "s_done_override" });

    expect(
      decide({ pullRequest: pr("open"), automationStates: [], completedStateId: "s_done_override" }),
    ).toMatchObject({ move: false, reason: "no-automation" });
  });

  it("applies once and never again, so a manual move is not overruled", () => {
    const applied = decide({ applied: { prState: "open", stateId: "s_review" } });
    expect(applied).toMatchObject({ move: false, reason: "already-applied" });

    // But a *different* pull-request state still transitions.
    const merged = decide({
      pullRequest: pr("merged"),
      applied: { prState: "open", stateId: "s_review" },
    });
    expect(merged).toMatchObject({ move: true, stateId: "s_done" });
  });

  it("does nothing when the issue is already in the target state", () => {
    expect(decide({ issueStateId: "s_review" })).toMatchObject({
      move: false,
      reason: "already-applied",
    });
  });

  it("reads no state NAME anywhere in the decision", async () => {
    // The rule the whole function exists to hold. `stateName` is carried
    // through for the sentence and is never compared.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/automations/pr-transition.ts", import.meta.url), "utf8"),
    );
    const body = source.slice(source.indexOf("export function decideTransition"));
    expect(body).not.toMatch(/stateName\s*===/);
    expect(body).not.toMatch(/\.name\s*===/);
    expect(body).not.toMatch(/toLowerCase\(\)/);
  });
});

describe("matchesTargetBranch", () => {
  it("matches a literal pattern exactly", () => {
    const state = { ...REVIEW, targetBranchPattern: "main", targetBranchIsRegex: false };
    expect(matchesTargetBranch(state, "main")).toBe(true);
    expect(matchesTargetBranch(state, "develop")).toBe(false);
  });

  it("matches a valid regex", () => {
    const state = { ...REVIEW, targetBranchPattern: "^release/", targetBranchIsRegex: true };
    expect(matchesTargetBranch(state, "release/2026-08")).toBe(true);
    expect(matchesTargetBranch(state, "main")).toBe(false);
  });

  it("skips an invalid regex rather than crashing the service", () => {
    // One bad row in one team's Linear settings must not stop the automation
    // for every other team.
    const state = { ...REVIEW, targetBranchPattern: "([unclosed", targetBranchIsRegex: true };
    expect(() => matchesTargetBranch(state, "main")).not.toThrow();
    expect(matchesTargetBranch(state, "main")).toBe(false);
  });

  it("refuses regex character-class escapes instead of misreading them as literals", () => {
    const state = { ...REVIEW, targetBranchPattern: "\\d", targetBranchIsRegex: true };
    expect(matchesTargetBranch(state, "d")).toBe(false);
  });

  it("skips an over-long pattern", () => {
    const state = { ...REVIEW, targetBranchPattern: "a".repeat(300), targetBranchIsRegex: true };
    expect(matchesTargetBranch(state, "a")).toBe(false);
  });

  it("treats an empty pattern as a catch-all", () => {
    expect(matchesTargetBranch({ ...REVIEW, targetBranchPattern: "" }, "anything")).toBe(true);
    expect(matchesTargetBranch({ ...REVIEW, targetBranchPattern: null }, "anything")).toBe(true);
  });

  it("prefers a matching pattern over the catch-all", () => {
    const specific: AutomationState = {
      event: "review",
      stateId: "s_release_review",
      stateName: "Release review",
      targetBranchPattern: "^release/",
      targetBranchIsRegex: true,
    };
    expect(
      decide({ automationStates: [REVIEW, specific], pullRequest: pr("open", "release/2026-08") }),
    ).toMatchObject({ stateId: "s_release_review" });
    expect(
      decide({ automationStates: [REVIEW, specific], pullRequest: pr("open", "main") }),
    ).toMatchObject({ stateId: "s_review" });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("parseRemote", () => {
  it("handles the shapes a naive owner/repo split gets wrong", () => {
    expect(parseRemote("git@github.com:acme/api.git")).toMatchObject({
      host: "github.com",
      owner: "acme",
      repo: "api",
    });

    // GitLab subgroups: three segments, and the project is the last one.
    expect(parseRemote("https://gitlab.com/group/subgroup/project.git")).toMatchObject({
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "project",
    });

    // Azure DevOps puts a literal `_git` in the middle.
    expect(parseRemote("https://dev.azure.com/org/project/_git/repo")).toMatchObject({
      owner: "org/project",
      repo: "repo",
    });

    // A non-default port.
    expect(parseRemote("ssh://git@code.example.com:2222/acme/api.git")).toMatchObject({
      host: "code.example.com",
      owner: "acme",
      repo: "api",
    });

    expect(parseRemote("git://git.example.com/acme/api.git")).toMatchObject({
      host: "git.example.com",
      repo: "api",
    });
  });

  it("strips userinfo, because a remote with a token in it is a token in a log line", () => {
    const parsed = parseRemote("https://user:ghp_secrettoken@github.com/acme/api.git");
    expect(parsed?.webUrl).toBe("https://github.com/acme/api");
    expect(JSON.stringify(parsed)).not.toContain("ghp_secrettoken");
  });

  it("returns null for a local path, which is a supported configuration", () => {
    // A project with no remote works: browsing, comments and status changes
    // are fine, and only branch-derived automation goes quiet.
    // Any absolute path exercises the branch; a `/Users/…`-shaped fixture
    // would add nothing except a string the hygiene check has to forgive.
    expect(parseRemote("/srv/git/api")).toBeNull();
    expect(parseRemote("file:///srv/git/api.git")).toBeNull();
    expect(parseRemote("./api")).toBeNull();
    expect(parseRemote(null)).toBeNull();
    expect(parseRemote("")).toBeNull();
  });
});

describe("identifierFromBranch", () => {
  it("is the fallback, and it finds an identifier anywhere in the name", () => {
    // Linear's own issueVcsBranchSearch is the primary resolver — it
    // understands gitBranchFormat and magic-word suffixes. This runs only when
    // that returns null.
    expect(identifierFromBranch("ada/eng-42-fix-the-flaky-login-test")).toBe("ENG-42");
    expect(identifierFromBranch("bb/ENG-42-thing-thr_abc")).toBe("ENG-42");
    expect(identifierFromBranch("ENG-42")).toBe("ENG-42");
  });

  it("finds nothing in a branch that has no identifier", () => {
    expect(identifierFromBranch("main")).toBeNull();
    expect(identifierFromBranch("feature/redesign")).toBeNull();
  });
});
