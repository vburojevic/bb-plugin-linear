import { describe, expect, it, vi } from "vitest";
import { applyBootstrap, applyIssues, applyTeamGraph, toIssueInput } from "../src/sync/apply.js";
import { backfillTeams, BACKFILL_PAGE_LIMIT, discoverWorkspace } from "../src/sync/backfill.js";
import type { LinearClient } from "../src/linear/client.js";
import type { BootstrapResult, IssueNode, TeamGraphResult } from "../src/linear/types.js";
import { createTestStore, NOW, team } from "./helpers/store.js";

function bootstrapPage(teams: number, hasNextPage = false, cursor = "c1"): BootstrapResult {
  return {
    viewer: {
      id: "u_me",
      name: "ada",
      displayName: "Ada Lovelace",
      email: "ada@example.invalid",
      avatarUrl: null,
      organization: {
        id: "org_1",
        name: "Acme",
        urlKey: "acme",
        gitBranchFormat: null,
        projectStatuses: [
          { id: "ps_1", name: "In Progress", type: "started", position: 1, color: "#000" },
        ],
      },
    },
    issuePriorityValues: [
      { priority: 0, label: "No priority" },
      { priority: 1, label: "Urgent" },
    ],
    teams: {
      nodes: Array.from({ length: teams }, (_, index) => ({
        id: `t_${index}`,
        key: `T${index}`,
        name: `Team ${index}`,
        icon: null,
        color: null,
        parent: null,
        issueEstimationType: "notUsed",
        issueEstimationAllowZero: false,
        issueEstimationExtended: false,
        defaultIssueEstimate: 0,
        cyclesEnabled: false,
        triageEnabled: false,
        activeCycle: null,
        updatedAt: "2026-08-12T10:00:00.000Z",
      })),
      pageInfo: { hasNextPage, endCursor: cursor },
    },
  };
}

function issueNode(overrides: Partial<IssueNode> & { id: string }): IssueNode {
  return {
    identifier: `ENG-${overrides.id}`,
    number: 1,
    title: "An issue",
    description: null,
    url: "https://linear.app/acme/issue/ENG-1",
    branchName: "ada/eng-1-an-issue",
    priority: 0,
    estimate: null,
    dueDate: null,
    sortOrder: 0,
    subIssueSortOrder: null,
    labelIds: [],
    previousIdentifiers: [],
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    triagedAt: null,
    archivedAt: null,
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
    team: { id: "t_0" },
    state: { id: "s_1" },
    assignee: null,
    creator: null,
    project: null,
    projectMilestone: null,
    cycle: null,
    parent: null,
    ...overrides,
  };
}

function fakeClient(overrides: Partial<LinearClient> = {}): LinearClient {
  return {
    verify: vi.fn(),
    bootstrap: vi.fn(async () => bootstrapPage(1)),
    teamMembers: vi.fn(async () => ({ teams: { nodes: [] } })),
    teamGraph: vi.fn(
      async (): Promise<TeamGraphResult> => ({
        workflowStates: {
          nodes: [
            {
              id: "s_1",
              name: "In Progress",
              type: "started",
              color: "#000",
              position: 1,
              description: null,
              team: { id: "t_0" },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        issueLabels: {
          nodes: [
            {
              id: "l_1",
              name: "bug",
              color: "#f00",
              isGroup: false,
              updatedAt: "2026-08-12T10:00:00.000Z",
              parent: null,
              team: null,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        users: {
          nodes: [
            {
              id: "u_me",
              name: "ada",
              displayName: "Ada Lovelace",
              email: "ada@example.invalid",
              avatarUrl: null,
              active: true,
              app: false,
              isMe: true,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    ),
    backfillIssues: vi.fn(async () => ({
      issues: { nodes: [issueNode({ id: "1" })], pageInfo: { hasNextPage: false } },
    })),
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
    updateIssue: vi.fn(),
    createComment: vi.fn(),
    budget: () => null,
    breaker: () => ({ open: false, openUntil: 0, consecutiveFailures: 0, lastError: null }),
    ...overrides,
  };
}

describe("applyBootstrap", () => {
  it("parses every timestamp exactly once, into epoch milliseconds", () => {
    const store = createTestStore();
    applyBootstrap(store, bootstrapPage(1), NOW, "apiKey");
    expect(store.team("t_0")?.updatedAt).toBe(Date.parse("2026-08-12T10:00:00.000Z"));
  });

  it("records the viewer as a member flagged is_me", () => {
    // That is what lets "assigned to you" be a plain query rather than a
    // special case threaded through every filter.
    const store = createTestStore();
    applyBootstrap(store, bootstrapPage(1), NOW, "apiKey");
    expect(store.viewer()?.displayName).toBe("Ada Lovelace");
  });

  it("keeps the workspace's own priority vocabulary", () => {
    const store = createTestStore();
    applyBootstrap(store, bootstrapPage(1), NOW, "apiKey");
    expect(store.priorityValues()).toEqual([
      { priority: 0, label: "No priority" },
      { priority: 1, label: "Urgent" },
    ]);
  });
});

describe("applyTeamGraph", () => {
  it("keeps a workspace-level label, which is what team === null means", () => {
    const store = createTestStore();
    const client = fakeClient();
    return client.teamGraph(["t_0"]).then((graph) => {
      applyTeamGraph(store, graph, ["t_0"], NOW);
      expect(store.labels(["t_0"]).map((label) => label.name)).toEqual(["bug"]);
      expect(store.labels([]).map((label) => label.name)).toEqual(["bug"]);
    });
  });

  it("does not erase a team's states when its page came back empty", () => {
    // A team with no states in the response is a truncated page or a partial
    // failure, not a team with no states. Replacing with an empty list would
    // wipe a working state picker.
    const store = createTestStore();
    store.replaceWorkflowStates("t_0", [
      { id: "s_old", teamId: "t_0", name: "Todo", type: "unstarted", color: null, position: 1, description: null },
    ]);
    applyTeamGraph(
      store,
      {
        workflowStates: { nodes: [], pageInfo: { hasNextPage: false } },
        issueLabels: { nodes: [], pageInfo: { hasNextPage: false } },
        users: { nodes: [], pageInfo: { hasNextPage: false } },
      },
      ["t_0"],
      NOW,
    );
    expect(store.workflowStates("t_0")).toHaveLength(1);
  });
});

describe("toIssueInput", () => {
  it("keeps a TimelessDate as a string", () => {
    // Converting a due date to epoch picks a timezone on the user's behalf and
    // is wrong by exactly one day for half the planet.
    const row = toIssueInput(issueNode({ id: "1", dueDate: "2026-08-15" }));
    expect(row.dueDate).toBe("2026-08-15");
  });

  it("flattens every relation to an id", () => {
    const row = toIssueInput(
      issueNode({ id: "1", assignee: { id: "u_1" }, project: { id: "p_1" }, parent: null }),
    );
    expect(row.assigneeId).toBe("u_1");
    expect(row.projectId).toBe("p_1");
    expect(row.parentId).toBeNull();
  });
});

describe("applyIssues", () => {
  it("checkpoints to the OLDEST updatedAt in the page, never the newest", () => {
    // Checkpointing to the newest means a crash mid-walk skips everything the
    // walk had not reached. The oldest re-reads a page instead of losing one,
    // and re-reading is free because every write is an upsert by id.
    const store = createTestStore();
    const result = applyIssues(
      store,
      [
        issueNode({ id: "new", updatedAt: "2026-08-12T12:00:00.000Z" }),
        issueNode({ id: "old", updatedAt: "2026-08-12T08:00:00.000Z" }),
      ],
      NOW,
    );
    expect(result.written).toBe(2);
    expect(result.oldestUpdatedAt).toBe(Date.parse("2026-08-12T08:00:00.000Z"));
    // The newest is what the watermark checkpoints to on a complete walk.
    expect(result.newestUpdatedAt).toBe(Date.parse("2026-08-12T12:00:00.000Z"));
  });

  it("is idempotent, so a deliberate watermark overlap costs nothing", () => {
    const store = createTestStore();
    const page = [issueNode({ id: "1" })];
    applyIssues(store, page, NOW);
    applyIssues(store, page, NOW + 1000);
    expect(store.countIssues({ teamIds: ["t_0"], includeCompleted: true })).toBe(1);
  });

  it("records previous identifiers so an old link still resolves", () => {
    const store = createTestStore();
    applyIssues(
      store,
      [issueNode({ id: "1", identifier: "DES-45", previousIdentifiers: ["ENG-123"] })],
      NOW,
    );
    expect(store.issueByIdentifier("ENG-123")?.id).toBe("1");
  });

  it("answers null for an empty page rather than moving the watermark", () => {
    const store = createTestStore();
    expect(applyIssues(store, [], NOW)).toEqual({
      written: 0,
      oldestUpdatedAt: null,
      newestUpdatedAt: null,
    });
  });
});

describe("discoverWorkspace", () => {
  it("follows the team cursor", () => {
    const store = createTestStore();
    let call = 0;
    const client = fakeClient({
      bootstrap: vi.fn(async () => {
        call += 1;
        return call === 1 ? bootstrapPage(2, true, "c1") : bootstrapPage(1, false, null as never);
      }),
    });
    return discoverWorkspace({ client, slot: "apiKey", store, now: () => NOW }).then(() => {
      expect(client.bootstrap).toHaveBeenCalledTimes(2);
    });
  });

  it("stops rather than spinning when the cursor does not advance", () => {
    // A cursor that fails to move — a server-side bug, a filter interaction —
    // would otherwise loop against the request budget until the hour ran out.
    const store = createTestStore();
    const client = fakeClient({
      bootstrap: vi.fn(async () => bootstrapPage(1, true, "same")),
    });
    return discoverWorkspace({ client, slot: "apiKey", store, now: () => NOW }).then(() => {
      expect((client.bootstrap as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(
        20,
      );
    });
  });
});

describe("backfillTeams", () => {
  it("does nothing at all with no bound teams", async () => {
    const store = createTestStore();
    const client = fakeClient();
    const report = await backfillTeams({ client, slot: "apiKey", store, now: () => NOW }, []);
    expect(report).toEqual({
      teams: 0,
      issues: 0,
      removed: 0,
      truncated: false,
      moreAvailable: false,
    });
    expect(client.teamGraph).not.toHaveBeenCalled();
  });

  it("stops at the page cap and says the rest is still coming", async () => {
    // Fetching five years of closed issues to fill a sidebar spends a
    // stranger's whole hourly budget on their first afternoon.
    const store = createTestStore();
    let page = 0;
    const client = fakeClient({
      backfillIssues: vi.fn(async () => {
        page += 1;
        return {
          issues: {
            nodes: [issueNode({ id: `i${page}` })],
            pageInfo: { hasNextPage: true, endCursor: `c${page}` },
          },
        };
      }),
    });
    const messages: string[] = [];
    const report = await backfillTeams(
      { client, slot: "apiKey", store, now: () => NOW, log: (_level, message) => messages.push(message) },
      ["t_0"],
    );
    expect(client.backfillIssues).toHaveBeenCalledTimes(BACKFILL_PAGE_LIMIT);
    expect(report.truncated).toBe(true);
    expect(messages.join(" ")).toContain("The rest arrive as they are updated");
  });

  it("says so when a picker will be missing entries", async () => {
    const store = createTestStore();
    const messages: string[] = [];
    const client = fakeClient({
      teamGraph: vi.fn(async () => ({
        workflowStates: { nodes: [], pageInfo: { hasNextPage: false } },
        issueLabels: { nodes: [], pageInfo: { hasNextPage: true } },
        users: { nodes: [], pageInfo: { hasNextPage: true } },
      })),
    });
    await backfillTeams(
      { client, slot: "apiKey", store, now: () => NOW, log: (_level, message) => messages.push(message) },
      ["t_0"],
    );
    // A truncated page is stated rather than swallowed: a picker quietly
    // missing entries looks like a bug in the picker.
    expect(messages.join(" ")).toContain("more labels than one page holds");
    expect(messages.join(" ")).toContain("more members than one page holds");
  });

  it("stops when the plugin is disposed mid-walk", async () => {
    const store = createTestStore();
    const controller = new AbortController();
    const client = fakeClient({
      backfillIssues: vi.fn(async () => {
        controller.abort();
        return {
          issues: {
            nodes: [issueNode({ id: "1" })],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        };
      }),
    });
    await backfillTeams({ client, slot: "apiKey", store, now: () => NOW, signal: controller.signal }, ["t_0"]);
    expect(client.backfillIssues).toHaveBeenCalledTimes(1);
  });
});

describe("the deletion sweep", () => {
  // Without it the mirror is upsert-only: an issue deleted in Linear stays in
  // the panel, in search, and in every agent tool result forever, and the
  // reader acts on a card that does not exist.

  function storeWithTwoOpenIssues() {
    const store = createTestStore();
    store.putTeams([team("t_0", "ENG")], NOW);
    store.putIssues(
      [
        toIssueInput(issueNode({ id: "kept" })),
        toIssueInput(issueNode({ id: "gone" })),
      ],
      NOW,
    );
    return store;
  }

  it("deletes only the issues Linear says are gone", async () => {
    const store = storeWithTwoOpenIssues();
    const client = fakeClient({
      // The walk sees "kept" and completes; "gone" is therefore a candidate.
      backfillIssues: vi.fn(async () => ({
        issues: { nodes: [issueNode({ id: "kept" })], pageInfo: { hasNextPage: false } },
      })),
      // Linear confirms it no longer has it.
      issuesExist: vi.fn(async () => ({ issues: { nodes: [] } })),
    });

    const report = await backfillTeams({ client, slot: "apiKey", store, now: () => NOW }, ["t_0"]);

    expect(report.removed).toBe(1);
    expect(store.issue("gone")).toBeNull();
    expect(store.issue("kept")).not.toBeNull();
  });

  it("keeps an issue that merely CLOSED since the last walk", async () => {
    // The walk reads open issues only, so a closed issue is missing from it —
    // and deleting on absence alone would destroy real work. The probe is
    // what tells the two apart.
    const store = storeWithTwoOpenIssues();
    const client = fakeClient({
      backfillIssues: vi.fn(async () => ({
        issues: { nodes: [issueNode({ id: "kept" })], pageInfo: { hasNextPage: false } },
      })),
      issuesExist: vi.fn(async () => ({ issues: { nodes: [{ id: "gone" }] } })),
    });

    const report = await backfillTeams({ client, slot: "apiKey", store, now: () => NOW }, ["t_0"]);

    expect(report.removed).toBe(0);
    expect(store.issue("gone")).not.toBeNull();
  });

  it("never sweeps after a truncated walk", async () => {
    // A walk that hit the page cap did not read every open issue, so "not
    // seen" would mostly mean "not reached" — sweeping would delete live work.
    const store = storeWithTwoOpenIssues();
    const issuesExist = vi.fn(async () => ({ issues: { nodes: [] } }));
    const client = fakeClient({
      backfillIssues: vi.fn(async () => ({
        issues: {
          nodes: [issueNode({ id: "kept" })],
          pageInfo: { hasNextPage: true, endCursor: `c${String(Math.random())}` },
        },
      })),
      issuesExist,
    });

    const report = await backfillTeams({ client, slot: "apiKey", store, now: () => NOW }, ["t_0"]);

    expect(report.truncated).toBe(true);
    expect(issuesExist).not.toHaveBeenCalled();
    expect(store.issue("gone")).not.toBeNull();
  });

  it("deletes nothing when the probe itself fails", async () => {
    // "We could not ask" must never become "it is gone" — that would turn a
    // rate limit into data loss.
    const store = storeWithTwoOpenIssues();
    const client = fakeClient({
      backfillIssues: vi.fn(async () => ({
        issues: { nodes: [issueNode({ id: "kept" })], pageInfo: { hasNextPage: false } },
      })),
      issuesExist: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });

    const report = await backfillTeams({ client, slot: "apiKey", store, now: () => NOW }, ["t_0"]);

    expect(report.removed).toBe(0);
    expect(store.issue("gone")).not.toBeNull();
  });
})
