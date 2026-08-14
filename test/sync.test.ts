import { describe, expect, it, vi } from "vitest";
import {
  BALANCED,
  currentTier,
  inboxInterval,
  jitter,
  nextInterval,
  type TierInput,
} from "../src/sync/tiers.js";
import { advanceWatermark, sinceFor, WATERMARK_OVERLAP_MS } from "../src/sync/watermark.js";
import { planTick, shardTeams } from "../src/sync/tick.js";
import { runTick } from "../src/sync/service.js";
import { TICK } from "../src/linear/documents.js";
import type { LinearClient } from "../src/linear/client.js";
import type { IssueNode, TickResult } from "../src/linear/types.js";
import { createTestStore, issue, NOW } from "./helpers/store.js";
import { timedOut } from "../src/linear/errors.js";

const NEVER_RANDOM = () => 0.5;

function tier(overrides: Partial<TierInput> = {}): TierInput {
  return {
    now: NOW,
    runningLinkedThread: false,
    lastMutationAt: null,
    lastPanelReadAt: null,
    lastFrontendReadAt: null,
    hasBinding: true,
    lastChangeAt: NOW,
    quietTicks: 0,
    ...overrides,
  };
}

describe("currentTier", () => {
  it("is cold with no binding, whatever else is happening", () => {
    // Scope is the binding, not the workspace: nothing bound means nothing to
    // poll.
    expect(currentTier(tier({ hasBinding: false, runningLinkedThread: true }))).toBe("cold");
  });

  it("is hot while a linked thread is running", () => {
    expect(currentTier(tier({ runningLinkedThread: true }))).toBe("hot");
  });

  it("stays hot for two minutes after a local write", () => {
    // Long enough to catch the server-side automations a write can trigger,
    // short enough not to pin the tier to a click somebody walked away from.
    expect(currentTier(tier({ lastMutationAt: NOW - 60_000 }))).toBe("hot");
    expect(currentTier(tier({ lastMutationAt: NOW - 200_000 }))).not.toBe("hot");
  });

  it("is cold when no frontend has asked for anything in five minutes", () => {
    expect(currentTier(tier({ lastFrontendReadAt: NOW - 600_000 }))).toBe("cold");
  });

  it("is foreground while the panel is reading and warm when it stops", () => {
    expect(
      currentTier(tier({ lastFrontendReadAt: NOW, lastPanelReadAt: NOW - 5_000 })),
    ).toBe("foreground");
    expect(
      currentTier(tier({ lastFrontendReadAt: NOW, lastPanelReadAt: NOW - 120_000 })),
    ).toBe("warm");
  });

  it("goes cold after half an hour of nothing changing, even with the panel open", () => {
    // A panel on a second monitor is not a reason to keep asking.
    expect(
      currentTier(
        tier({ lastFrontendReadAt: NOW, lastPanelReadAt: NOW, lastChangeAt: NOW - 2_000_000 }),
      ),
    ).toBe("cold");
  });
});

describe("nextInterval", () => {
  it("polls a running thread's issue every ten seconds on balanced", () => {
    const cadence = nextInterval(tier({ runningLinkedThread: true }), "balanced", NEVER_RANDOM);
    expect(cadence.tier).toBe("hot");
    expect(cadence.baseMs).toBe(10_000);
  });

  it("halves on responsive and doubles on frugal", () => {
    const hot = tier({ runningLinkedThread: true });
    expect(nextInterval(hot, "responsive", NEVER_RANDOM).baseMs).toBe(5_000);
    expect(nextInterval(hot, "frugal", NEVER_RANDOM).baseMs).toBe(20_000);
  });

  it("decays a quiet foreground toward its ceiling and no further", () => {
    const base = tier({ lastFrontendReadAt: NOW, lastPanelReadAt: NOW });
    expect(nextInterval({ ...base, quietTicks: 0 }, "balanced", NEVER_RANDOM).baseMs).toBe(20_000);
    expect(nextInterval({ ...base, quietTicks: 1 }, "balanced", NEVER_RANDOM).baseMs).toBe(40_000);
    expect(nextInterval({ ...base, quietTicks: 9 }, "balanced", NEVER_RANDOM).baseMs).toBe(
      BALANCED.foreground.ceiling,
    );
  });

  it("resets to the floor when something changes", () => {
    // Without this, a poller that has decayed to a minute takes a minute to
    // notice that things started happening again — which is when it matters.
    const base = tier({ lastFrontendReadAt: NOW, lastPanelReadAt: NOW });
    expect(nextInterval({ ...base, quietTicks: 0 }, "balanced", NEVER_RANDOM).baseMs).toBe(
      BALANCED.foreground.floor,
    );
  });
});

describe("jitter", () => {
  it("spreads ±10 % so two hosts on one account never align", () => {
    expect(jitter(10_000, () => 0)).toBe(9_000);
    expect(jitter(10_000, () => 1)).toBe(11_000);
    expect(jitter(10_000, () => 0.5)).toBe(10_000);
  });

  it("never produces a busy-loop interval", () => {
    expect(jitter(100, () => 0)).toBeGreaterThanOrEqual(1_000);
  });
});

describe("inboxInterval", () => {
  it("runs on its own clock, independent of the tiers", () => {
    expect(inboxInterval({ quietTicks: 0 }, "balanced", NEVER_RANDOM)).toBe(30_000);
    expect(inboxInterval({ quietTicks: 10 }, "balanced", NEVER_RANDOM)).toBe(300_000);
  });
});

describe("advanceWatermark", () => {
  it("checkpoints to the newest updatedAt minus the overlap", () => {
    // A completed walk has read everything newer than the cursor, so the
    // newest is the honest checkpoint. The overlap re-reads a moment of it,
    // which is free because every write is an upsert by id.
    expect(advanceWatermark(1000, { newestUpdatedAt: 500_000, complete: true })).toBe(
      500_000 - WATERMARK_OVERLAP_MS,
    );
  });

  it("makes progress across ticks instead of pinning", () => {
    // The bug this replaced: checkpointing to the OLDEST row meant the next
    // query returned the same rows, whose oldest was the same value, so the
    // cursor never advanced again while the matching set grew without bound.
    // Two ticks over a stable window must converge, not oscillate.
    const first = advanceWatermark(0, { newestUpdatedAt: 500_000, complete: true });
    const second = advanceWatermark(first, { newestUpdatedAt: 500_000, complete: true });
    expect(first).toBe(500_000 - WATERMARK_OVERLAP_MS);
    expect(second).toBe(first);

    // And a later change moves it forward rather than being stranded behind
    // an old row that never changes again.
    expect(advanceWatermark(second, { newestUpdatedAt: 900_000, complete: true })).toBe(
      900_000 - WATERMARK_OVERLAP_MS,
    );
  });

  it("never moves on an incomplete walk", () => {
    expect(advanceWatermark(1000, { newestUpdatedAt: 500_000, complete: false })).toBe(1000);
  });

  it("never moves backwards", () => {
    // A watermark that moves backwards re-reads the same window forever.
    expect(advanceWatermark(900_000, { newestUpdatedAt: 500_000, complete: true })).toBe(900_000);
  });

  it("does not move on an empty page", () => {
    expect(advanceWatermark(1000, { newestUpdatedAt: null, complete: true })).toBe(1000);
  });

  it("treats zero as 'never synced' rather than as 1970", () => {
    expect(sinceFor(0)).toBeNull();
    expect(sinceFor(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("shardTeams", () => {
  it("returns everything when there is nothing to split", () => {
    expect(shardTeams(["a", "b"], 1, 0)).toEqual(["a", "b"]);
  });

  it("rotates deterministically so no team is starved by luck", () => {
    const teams = ["a", "b", "c", "d"];
    const first = shardTeams(teams, 2, 0);
    const second = shardTeams(teams, 2, 1);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["c", "d"]);
    // And every team is covered across one full rotation.
    expect([...first, ...second].sort()).toEqual(teams);
    // Repeatable.
    expect(shardTeams(teams, 2, 2)).toEqual(first);
  });
});

describe("planTick", () => {
  it("stays under this plugin's own complexity budget", () => {
    // 8,000 rather than Linear's 10,000: the document is built from a live
    // team list, so a tick that fits today must still fit when somebody binds
    // another team.
    const plan = planTick({
      teamIds: ["a", "b", "c"],
      issuesSince: "2026-08-12T00:00:00.000Z",
      commentsSince: "2026-08-12T00:00:00.000Z",
      tickNumber: 0,
    });
    expect(plan.estimatedComplexity).toBeLessThan(8_000);
    expect(plan.shardCount).toBe(1);
    expect(plan.teamIds).toEqual(["a", "b", "c"]);
  });

  it("carries every variable the document declares", () => {
    const plan = planTick({
      teamIds: ["a"],
      issuesSince: "S1",
      commentsSince: "S2",
      tickNumber: 0,
    });
    for (const name of ["teamIds", "issuesSince", "commentsSince", "issues", "comments"]) {
      expect(Object.keys(plan.variables)).toContain(name);
    }
    // Comments carry their own cursor, because whether commenting bumps
    // Issue.updatedAt is not documented and Automation 3 depends on seeing
    // them.
    expect(plan.variables["issuesSince"]).not.toBe(plan.variables["commentsSince"]);
  });
});

describe("the tick document", () => {
  it("asks for archived rows", () => {
    // `includeArchived` defaults to false, so archiving is indistinguishable
    // from deletion to a delta poller: the row silently stops appearing and
    // the mirror keeps a ghost forever.
    expect(TICK.source).toContain("includeArchived: true");
  });

  it("scopes both lanes to the bound teams", () => {
    const teamFilters = TICK.source.match(/team: \{ id: \{ in: \$teamIds \} \}/g) ?? [];
    expect(teamFilters.length).toBe(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

function issueNode(overrides: Partial<IssueNode> & { id: string }): IssueNode {
  return {
    identifier: `ENG-${overrides.id}`,
    number: 1,
    title: "An issue",
    description: null,
    url: "",
    branchName: "",
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
    team: { id: "team_eng" },
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

function tickClient(result: TickResult | Error): LinearClient {
  return {
    tick: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as LinearClient;
}

const EMPTY_PAGE = { nodes: [], pageInfo: { hasNextPage: false } };

describe("runTick", () => {
  it("does nothing at all with no bound teams", async () => {
    const client = tickClient({ issues: EMPTY_PAGE, comments: EMPTY_PAGE });
    const outcome = await runTick(
      { client, store: createTestStore(), now: () => NOW },
      { teamIds: [], issuesWatermark: 1, commentsWatermark: 1, tickNumber: 0 },
    );
    expect(outcome.applied).toBe(false);
    expect(client.tick).not.toHaveBeenCalled();
  });

  it("writes issues and advances the watermark", async () => {
    const store = createTestStore();
    const client = tickClient({
      issues: {
        nodes: [issueNode({ id: "i_1", updatedAt: "2026-08-12T12:00:00.000Z" })],
        pageInfo: { hasNextPage: false },
      },
      comments: EMPTY_PAGE,
    });
    const outcome = await runTick(
      { client, store, now: () => NOW },
      { teamIds: ["team_eng"], issuesWatermark: 1, commentsWatermark: 1, tickNumber: 0 },
    );
    expect(outcome.changed).toBe(true);
    expect(store.issue("i_1")).not.toBeNull();
    expect(outcome.issuesWatermark).toBe(
      Date.parse("2026-08-12T12:00:00.000Z") - WATERMARK_OVERLAP_MS,
    );
  });

  it("discards a partial tick rather than committing a hollow snapshot", async () => {
    // Writing half a page as truth, with the watermark advanced past what was
    // never read, is how a panel ends up confidently wrong with no error
    // anywhere.
    const store = createTestStore();
    const client = tickClient(new TypeError("socket hang up"));
    const outcome = await runTick(
      { client, store, now: () => NOW },
      { teamIds: ["team_eng"], issuesWatermark: 5, commentsWatermark: 5, tickNumber: 0 },
    );
    expect(outcome.applied).toBe(false);
    expect(outcome.issuesWatermark).toBeNull();
    expect(store.countIssues({ teamIds: ["team_eng"], includeCompleted: true })).toBe(0);
  });

  it("rethrows a Linear error so the governor and breaker can see it", async () => {
    const client = tickClient(timedOut("too slow"));
    await expect(
      runTick(
        { client, store: createTestStore(), now: () => NOW },
        { teamIds: ["team_eng"], issuesWatermark: 5, commentsWatermark: 5, tickNumber: 0 },
      ),
    ).rejects.toThrow();
  });

  it("drops a comment whose issue is not in the mirror", async () => {
    // An orphaned comment is a row the detail pane can never show.
    const store = createTestStore();
    const client = tickClient({
      issues: EMPTY_PAGE,
      comments: {
        nodes: [
          {
            id: "c_1",
            body: "About something outside the backfill window",
            url: "",
            createdAt: "2026-08-12T10:00:00.000Z",
            updatedAt: "2026-08-12T10:00:00.000Z",
            editedAt: null,
            resolvedAt: null,
            user: null,
            parent: null,
            issue: { id: "i_unknown" },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const outcome = await runTick(
      { client, store, now: () => NOW },
      { teamIds: ["team_eng"], issuesWatermark: 1, commentsWatermark: 1, tickNumber: 0 },
    );
    expect(outcome.commentsWritten).toBe(0);
  });

  it("keeps a comment whose issue is in the mirror", async () => {
    const store = createTestStore();
    store.putIssues([issue({ id: "i_1" })], NOW);
    const client = tickClient({
      issues: EMPTY_PAGE,
      comments: {
        nodes: [
          {
            id: "c_1",
            body: "Looks good",
            url: "",
            createdAt: "2026-08-12T10:00:00.000Z",
            updatedAt: "2026-08-12T10:00:00.000Z",
            editedAt: null,
            resolvedAt: null,
            user: null,
            parent: null,
            issue: { id: "i_1" },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const outcome = await runTick(
      { client, store, now: () => NOW },
      { teamIds: ["team_eng"], issuesWatermark: 1, commentsWatermark: 1, tickNumber: 0 },
    );
    expect(outcome.commentsWritten).toBe(1);
    expect(store.comments("i_1")).toHaveLength(1);
  });

  it("does not advance a watermark past an incomplete page", async () => {
    const store = createTestStore();
    const client = tickClient({
      issues: {
        nodes: [issueNode({ id: "i_1", updatedAt: "2026-08-12T12:00:00.000Z" })],
        pageInfo: { hasNextPage: true, endCursor: "c1" },
      },
      comments: EMPTY_PAGE,
    });
    const outcome = await runTick(
      { client, store, now: () => NOW },
      { teamIds: ["team_eng"], issuesWatermark: 5, commentsWatermark: 5, tickNumber: 0 },
    );
    // The rows are written — they are real — but the cursor stays where it
    // was, so the next tick re-reads rather than skipping the tail.
    expect(store.issue("i_1")).not.toBeNull();
    expect(outcome.issuesWatermark).toBe(5);
  });
});
