import { describe, expect, it, vi } from "vitest";
import {
  buildIssueUpdateInput,
  clientId,
  postComment,
  updateIssue,
  type MutationDeps,
} from "../src/mutations.js";
import { forbidden, isLinearError } from "../src/linear/errors.js";
import type { LinearClient } from "../src/linear/client.js";
import type { IssueNode } from "../src/linear/types.js";
import { createTestStore, NOW } from "./helpers/store.js";
import { formatEstimate, selectDetail } from "../src/select/detail.js";
import type { CommentRow, WorkflowStateRow } from "../src/store/rows.js";
import { issue as makeIssue, member, state } from "./helpers/store.js";

const ISSUE: IssueNode = {
  id: "i_1",
  identifier: "ENG-42",
  number: 42,
  title: "Fix the flaky login test",
  description: null,
  url: "https://linear.app/acme/issue/ENG-42",
  branchName: "ada/eng-42-fix",
  priority: 1,
  estimate: null,
  dueDate: null,
  sortOrder: 0,
  subIssueSortOrder: null,
  labelIds: ["l_bug"],
  previousIdentifiers: [],
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  triagedAt: null,
  archivedAt: null,
  createdAt: "2026-08-12T09:00:00.000Z",
  updatedAt: "2026-08-12T10:00:00.000Z",
  team: { id: "team_eng" },
  state: { id: "s_progress" },
  assignee: null,
  creator: null,
  project: null,
  projectMilestone: null,
  cycle: null,
  parent: null,
};

function deps(
  overrides: Partial<LinearClient> = {},
): MutationDeps & { refusals: string[]; client: LinearClient } {
  const refusals: string[] = [];
  const client = {
    verify: vi.fn(),
    bootstrap: vi.fn(),
    teamGraph: vi.fn(),
    teamMembers: vi.fn(async () => ({ teams: { nodes: [] } })),
    backfillIssues: vi.fn(),
    tick: vi.fn(),
    notifications: vi.fn(),
    breadth: vi.fn(),
    createIssue: vi.fn(),
    createRelation: vi.fn(),
    linkUrl: vi.fn(),
    archiveIssue: vi.fn(),
    searchIssues: vi.fn(),
    createWebhook: vi.fn(),
    readWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    relations: vi.fn(),
    customViewIssues: vi.fn(),
    branchSearch: vi.fn(),
    teamAutomation: vi.fn(),
    attachmentsForUrl: vi.fn(),
    attachPullRequest: vi.fn(),
    issueDetail: vi.fn(),
    updateIssue: vi.fn(async () => ({ issueUpdate: { success: true, issue: ISSUE } })),
    createComment: vi.fn(async () => ({
      commentCreate: {
        success: true,
        comment: {
          id: "c_1",
          body: "Looks good",
          url: "https://linear.app/acme/issue/ENG-42#comment-c_1",
          createdAt: "2026-08-12T11:00:00.000Z",
          updatedAt: "2026-08-12T11:00:00.000Z",
          editedAt: null,
          resolvedAt: null,
          user: { id: "u_me" },
          parent: null,
          issue: { id: "i_1" },
        },
      },
    })),
    budget: () => null,
    breaker: () => ({ open: false, openUntil: 0, consecutiveFailures: 0, lastError: null }),
    ...overrides,
  } as unknown as LinearClient;

  return {
    // Every issue resolves to the same fake client here; the per-workspace
    // routing is exercised where it lives, against a real store.
    clientFor: () => client,
    store: createTestStore(),
    now: () => NOW,
    onWriteRefused: (what) => {
      refusals.push(what);
    },
    refusals,
    client,
  };
}

describe("buildIssueUpdateInput", () => {
  it("never emits labelIds", () => {
    // `labelIds` replaces the ENTIRE set, so a patch built from a read taken
    // thirty seconds ago silently deletes any label somebody added in
    // between — and the person who lost it has no way to know, because
    // nothing failed.
    const input = buildIssueUpdateInput({
      addLabelIds: ["l_bug"],
      removeLabelIds: ["l_ui"],
    });
    expect(input).toEqual({ addedLabelIds: ["l_bug"], removedLabelIds: ["l_ui"] });
    expect(Object.keys(input)).not.toContain("labelIds");
  });

  it("tells 'not part of this patch' apart from 'clear it'", () => {
    // Unassigning an issue and not touching its assignee are different
    // intentions, and both have to be expressible.
    expect(buildIssueUpdateInput({})).toEqual({});
    expect(buildIssueUpdateInput({ assigneeId: null })).toEqual({ assigneeId: null });
    expect(buildIssueUpdateInput({ assigneeId: "u_1" })).toEqual({ assigneeId: "u_1" });
  });

  it("maps milestone to Linear's own field name", () => {
    expect(buildIssueUpdateInput({ milestoneId: "m_1" })).toEqual({ projectMilestoneId: "m_1" });
  });

  it("drops empty label arrays rather than sending them", () => {
    expect(buildIssueUpdateInput({ addLabelIds: [], removeLabelIds: [] })).toEqual({});
  });
});

describe("updateIssue", () => {
  it("refuses an empty patch instead of spending a request on nothing", async () => {
    const d = deps();
    await expect(updateIssue(d, "i_1", {}, "x")).rejects.toThrow(/Nothing to change/);
    expect(d.client.updateIssue).not.toHaveBeenCalled();
  });

  it("applies the returned entity and records the echo before returning", async () => {
    // Echo suppression happens BEFORE the tick, not after. A tick that starts
    // the instant this resolves must already see both, or the user is
    // notified about the change they just made.
    const d = deps();
    await updateIssue(d, "i_1", { stateId: "s_progress" }, "x");
    expect(d.store.issue("i_1")?.identifier).toBe("ENG-42");
    expect(d.store.isEcho("i_1", Date.parse("2026-08-12T10:00:00.000Z"))).toBe(true);
  });

  it("does not suppress somebody else's later change to the same issue", () => {
    // The echo is keyed on (id, updatedAt), not on id: a different version of
    // the same entity is a different event and gets reported normally.
    const d = deps();
    d.store.recordEcho("i_1", 1000, NOW);
    expect(d.store.isEcho("i_1", 1000)).toBe(true);
    expect(d.store.isEcho("i_1", 2000)).toBe(false);
  });

  it("turns a permissions failure into the read-only sentence, and remembers it", async () => {
    const d = deps({
      updateIssue: vi.fn(async () => {
        throw forbidden("not allowed");
      }),
    });
    const error = await updateIssue(d, "i_1", { priority: 1 }, "ENG-42 wasn't changed").catch(
      (value: unknown) => value,
    );
    expect(isLinearError(error)).toBe(true);
    expect((error as Error).message).toContain("read-only");
    // The only evidence there will ever be: Linear does not expose a key's
    // scopes, so a refusal is discovered and then remembered.
    expect(d.refusals).toEqual(["this API key is read-only"]);
  });

  it("treats success: false with no errors as a failure", async () => {
    const d = deps({
      updateIssue: vi.fn(async () => ({ issueUpdate: { success: false, issue: null } })),
    });
    await expect(updateIssue(d, "i_1", { priority: 1 }, "move it")).rejects.toThrow(/didn't move it/);
  });
});

describe("postComment", () => {
  it("refuses an empty comment", async () => {
    const d = deps();
    await expect(
      postComment(d, { issueId: "i_1", body: "   ", clientId: "c" }),
    ).rejects.toThrow(/needs some text/);
  });

  it("sends a client-generated id, which is what makes a retry idempotent", async () => {
    const d = deps();
    await postComment(d, { issueId: "i_1", body: "Looks good", clientId: "fixed-id" });
    const call = (d.client.createComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      id: string;
      issueId: string;
      body: string;
    };
    expect(call.id).toBe("fixed-id");
    expect(call.body).toBe("Looks good");
  });

  it("writes the comment into the mirror so the pane is right immediately", async () => {
    const d = deps();
    await postComment(d, { issueId: "i_1", body: "Looks good", clientId: clientId() });
    expect(d.store.comments("i_1").map((row) => row.body)).toEqual(["Looks good"]);
  });
});

describe("clientId", () => {
  it("is unique per call", () => {
    expect(clientId()).not.toBe(clientId());
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("formatEstimate", () => {
  it("does not say 'points' on a t-shirt team", () => {
    // Rendering "3 points" on a t-shirt team is wrong in a way that makes the
    // whole panel look like it does not know the workspace.
    expect(formatEstimate(3, "tShirt")).toBe("M");
    expect(formatEstimate(3, "fibonacci")).toBe("3 points");
    expect(formatEstimate(1, "linear")).toBe("1 point");
  });

  it("renders nothing at all when the team does not estimate", () => {
    expect(formatEstimate(3, "notUsed")).toBeNull();
    expect(formatEstimate(null, "fibonacci")).toBeNull();
  });

  it("falls back to the number on a scale value it does not recognise", () => {
    expect(formatEstimate(21, "tShirt")).toBe("21");
  });
});

describe("selectDetail", () => {
  const states: WorkflowStateRow[] = [
    state("s_done", "team_eng", "completed", 1, "Done"),
    state("s_triage", "team_eng", "triage", 1, "Triage"),
    state("s_progress", "team_eng", "started", 2, "In Progress"),
  ];

  function context(overrides: Record<string, unknown> = {}) {
    return {
      issue: { ...makeIssue({ id: "i_1", stateId: "s_progress" }), syncedAt: NOW },
      team: {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        icon: null,
        color: null,
        parentId: null,
        estimationType: "notUsed",
        estimationAllowZero: false,
        estimationExtended: false,
        defaultEstimate: 0,
        cyclesEnabled: false,
        triageEnabled: true,
        activeCycleId: null,
        updatedAt: NOW,
        fetchedAt: NOW,
      },
      states,
      members: new Map([["u_me", member("u_me", "Ada Lovelace", true)]]),
      labels: new Map(),
      priorityLabels: new Map([[0, "No priority"]]),
      comments: [] as CommentRow[],
      commentsTruncated: false,
      subIssues: [],
      projectName: null,
      cycleName: null,
      milestoneName: null,
      ...overrides,
    };
  }

  it("orders the state picker by type then position, which is Linear's order", () => {
    const view = selectDetail(context() as never);
    expect(view.stateOptions.map((option) => option.name)).toEqual([
      "Triage",
      "In Progress",
      "Done",
    ]);
  });

  it("hides the estimate entirely on a team that does not estimate", () => {
    const view = selectDetail(context() as never);
    expect(view.usesEstimates).toBe(false);
    expect(view.properties.find((property) => property.key === "estimate")).toBeUndefined();
  });

  it("renders no property that has no value", () => {
    // A pane full of "Assignee: —" rows is a pane that has to be read past
    // rather than read.
    const view = selectDetail(context() as never);
    expect(view.properties.map((property) => property.key)).toEqual(["priority"]);
  });
});
