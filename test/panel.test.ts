import { describe, expect, it } from "vitest";
import {
  buildFacets,
  buildPanelView,
  buildThreadCandidates,
  type PanelDeps,
} from "../src/panel.js";
import {
  groupRows,
  initialsOf,
  selectPanelState,
  selectRow,
  selectSecondLine,
  type PanelInput,
  type RowContext,
} from "../src/select/panel.js";
import { estimateLabel, estimateScale } from "../src/select/detail.js";
import { glyphForTone, priorityMark, toneForStateType } from "../src/select/tone.js";
import type { PanelFilters } from "../src/contract.js";
import type { IssueRow, MemberRow, WorkflowStateRow } from "../src/store/rows.js";
import { createTestStore, issue, member, NOW, state, team } from "./helpers/store.js";

const TODAY = "2026-08-12";

const NO_FILTERS: PanelFilters = {
  stateIds: [],
  stateTypes: [],
  assigneeIds: [],
  labelIds: [],
  priorities: [],
  includeCompleted: false,
};

function rowContext(overrides: Partial<RowContext> = {}): RowContext {
  return {
    states: new Map<string, WorkflowStateRow>([
      ["s_progress", state("s_progress", "team_eng", "started", 1, "In Progress")],
      ["s_done", state("s_done", "team_eng", "completed", 2, "Done")],
      ["s_cancel", state("s_cancel", "team_eng", "canceled", 3, "Cancelled")],
    ]),
    members: new Map<string, MemberRow>([
      ["u_me", member("u_me", "Ada Lovelace", true)],
      ["u_kai", member("u_kai", "Kai Rivers")],
    ]),
    priorityLabels: new Map([
      [0, "No priority"],
      [1, "Urgent"],
      [2, "High"],
    ]),
    now: NOW,
    today: TODAY,
    lead: "state",
    ...overrides,
  };
}

function row(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    ...issue({ id: "1", identifier: "ENG-42", title: "Fix the flaky login test" }),
    syncedAt: NOW,
    ...overrides,
  } as IssueRow;
}

/* ────────────────────────────────────────────────────────────────────────── */

describe("tone comes from state.type, never from a state name", () => {
  it("maps the seven documented types", () => {
    for (const type of [
      "triage",
      "backlog",
      "unstarted",
      "started",
      "completed",
      "canceled",
      "duplicate",
    ]) {
      expect(toneForStateType(type)).toBe(type);
    }
  });

  it("survives a type Linear adds later", () => {
    // `WorkflowState.type` is a String, not an enum. An exhaustive switch over
    // five members silently drops issues on triage-enabled teams.
    expect(toneForStateType("shipped")).toBe("unknown");
    expect(toneForStateType(null)).toBe("unknown");
    expect(glyphForTone(toneForStateType("shipped"))).toBe("dot");
  });

  it("gives the three muted states distinct shapes, not just a shared colour", () => {
    // Tone alone would be a colour encoding, and three states share the muted
    // tone. Shape is what carries them apart.
    const shapes = new Set(
      (["backlog", "canceled", "duplicate"] as const).map((tone) => glyphForTone(tone)),
    );
    expect(shapes.size).toBe(3);
  });

  it("marks only Urgent and High", () => {
    expect([0, 1, 2, 3, 4].map(priorityMark)).toEqual([null, "urgent", "high", null, null]);
  });
});

describe("selectRow", () => {
  it("takes the priority label from the workspace, never from a constant", () => {
    const view = selectRow(row({ priority: 1 }), rowContext());
    expect(view.priorityLabel).toBe("Urgent");
    // A workspace that renamed it gets its own word.
    const renamed = selectRow(
      row({ priority: 1 }),
      rowContext({ priorityLabels: new Map([[1, "Dringend"]]) }),
    );
    expect(renamed.priorityLabel).toBe("Dringend");
  });

  it("puts everything the eye gets from shape and colour into the accessible name", () => {
    const view = selectRow(
      row({ stateId: "s_progress", assigneeId: "u_me", priority: 1 }),
      rowContext(),
    );
    expect(view.accessibleName).toContain("ENG-42");
    expect(view.accessibleName).toContain("In Progress");
    expect(view.accessibleName).toContain("Urgent");
    expect(view.accessibleName).toContain("assigned to Ada Lovelace");
  });

  it("strikes through a cancelled issue as well as marking it", () => {
    expect(selectRow(row({ stateId: "s_cancel" }), rowContext()).struckThrough).toBe(true);
    expect(selectRow(row({ stateId: "s_progress" }), rowContext()).struckThrough).toBe(false);
  });

  it("names an unknown state rather than rendering an empty cell", () => {
    const view = selectRow(row({ stateId: "s_missing" }), rowContext());
    expect(view.stateName).toBe("Unknown state");
    expect(view.tone).toBe("unknown");
  });
});

describe("initialsOf", () => {
  it("takes at most two glyphs, grapheme-aware", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("Prince")).toBe("P");
    expect(initialsOf("  ")).toBe("?");
    // A name starting with an astral-plane character must not yield half a
    // surrogate pair.
    expect([...initialsOf("😀 Smiley")]).toHaveLength(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("the second line appears only when it earns it", () => {
  const base = {
    pr: null,
    dueDate: null,
    today: TODAY,
    blockedBy: [],
    subIssues: null,
    cycleName: null,
    showCycle: false,
  };

  it("says nothing when there is nothing to say", () => {
    expect(selectSecondLine(base)).toBeNull();
  });

  it("puts a pull request above everything else", () => {
    // A parent issue whose PR just failed must not be showing a fraction
    // instead: the PR is the only item naming an action someone else is
    // waiting on.
    const line = selectSecondLine({
      ...base,
      pr: { number: 128, attention: "checks_failed" },
      dueDate: "2026-08-10",
      blockedBy: ["ENG-40"],
      subIssues: { done: 3, total: 7 },
    });
    expect(line).toMatchObject({ kind: "pr", text: "#128 checks failed" });
  });

  it("borrows bb's own pull-request vocabulary and says nothing for a settled one", () => {
    // A user running a sibling PR plugin must not meet two vocabularies for
    // one pull request fifteen pixels apart.
    expect(selectSecondLine({ ...base, pr: { number: 1, attention: "merged" } })).toBeNull();
    expect(selectSecondLine({ ...base, pr: { number: 1, attention: "none" } })).toBeNull();
    expect(
      selectSecondLine({ ...base, pr: { number: 1, attention: "review_requested" } })?.text,
    ).toBe("#1 waiting for review");
  });

  it("counts overdue days on the calendar, not on the clock", () => {
    const line = selectSecondLine({ ...base, dueDate: "2026-08-09" });
    expect(line?.kind).toBe("due");
    expect(line?.text).toContain("3 days overdue");
  });

  it("stays quiet about a due date that is not imminent", () => {
    expect(selectSecondLine({ ...base, dueDate: "2026-12-01" })).toBeNull();
  });

  it("names the blockers rather than counting them", () => {
    const line = selectSecondLine({ ...base, blockedBy: ["ENG-40", "ENG-41"] });
    expect(line?.text).toBe("Blocked by ENG-40 and ENG-41");
  });

  it("ranks sub-issue arithmetic below everything actionable", () => {
    expect(selectSecondLine({ ...base, subIssues: { done: 3, total: 7 } })?.text).toBe(
      "3 of 7 done",
    );
    // And says nothing at all when there are no sub-issues.
    expect(selectSecondLine({ ...base, subIssues: { done: 0, total: 0 } })).toBeNull();
  });

  it("shows a cycle only when the view spans cycles", () => {
    expect(selectSecondLine({ ...base, cycleName: "Cycle 12", showCycle: false })).toBeNull();
    expect(selectSecondLine({ ...base, cycleName: "Cycle 12", showCycle: true })?.text).toBe(
      "Cycle 12",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("grouping", () => {
  const context = {
    grouping: "state" as const,
    states: rowContext().states,
    members: rowContext().members,
    projectNames: new Map<string, string>(),
    cycleNames: new Map<string, string>(),
  };

  it("orders state groups by type and then by position, not alphabetically", () => {
    const issues = [
      row({ id: "a", stateId: "s_done" }),
      row({ id: "b", stateId: "s_progress" }),
    ];
    const views = issues.map((i) => selectRow(i, rowContext()));
    const groups = groupRows(issues, views, context);
    expect(groups.map((group) => group.label)).toEqual(["In Progress", "Done"]);
  });

  it("counts post-filter", () => {
    const issues = [row({ id: "a", stateId: "s_progress" }), row({ id: "b", stateId: "s_progress" })];
    const views = issues.map((i) => selectRow(i, rowContext()));
    expect(groupRows(issues, views, context)[0]?.count).toBe(2);
  });

  it("puts the viewer's own work first when grouping by assignee, and unassigned last", () => {
    const issues = [
      row({ id: "a", assigneeId: null }),
      row({ id: "b", assigneeId: "u_kai" }),
      row({ id: "c", assigneeId: "u_me" }),
    ];
    const views = issues.map((i) => selectRow(i, rowContext()));
    const groups = groupRows(issues, views, { ...context, grouping: "assignee" });
    expect(groups.map((group) => group.label)).toEqual([
      "Ada Lovelace",
      "Kai Rivers",
      "Unassigned",
    ]);
  });

  it("collapses to one unlabelled group when grouping is off", () => {
    const issues = [row({ id: "a" })];
    const views = issues.map((i) => selectRow(i, rowContext()));
    const groups = groupRows(issues, views, { ...context, grouping: "none" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("selectPanelState", () => {
  function input(overrides: Partial<PanelInput> = {}): PanelInput {
    return {
      hasCredential: true,
      boundTeams: [{ ...team("team_eng", "ENG"), fetchedAt: NOW, name: "Engineering" }],
      selectedTeam: { ...team("team_eng", "ENG"), fetchedAt: NOW, name: "Engineering" },
      hasEverSynced: true,
      issues: [],
      views: [],
      grouping: {
        grouping: "state",
        states: new Map(),
        members: new Map(),
        projectNames: new Map(),
        cycleNames: new Map(),
      },
      total: 0,
      totalWithoutFilters: 0,
      activeFacets: [],
      notice: null,
      ...overrides,
    };
  }

  it("renders the connect copy and nothing else with no credential", () => {
    // No empty table, no disabled chips, no skeleton.
    expect(selectPanelState(input({ hasCredential: false })).state).toEqual({
      kind: "no-credential",
    });
  });

  it("says there is nothing to show when nothing is bound", () => {
    expect(selectPanelState(input({ boundTeams: [] })).state).toEqual({ kind: "no-binding" });
  });

  it("never says a team has no issues before it has looked", () => {
    // The most important lie at the most fragile moment: a freshly bound,
    // still-empty mirror routed to "Engineering has no open issues" states a
    // fact about a team the plugin has not yet checked.
    const view = selectPanelState(input({ hasEverSynced: false }));
    expect(view.state).toEqual({ kind: "first-sync", teamName: "Engineering" });
  });

  it("tells an empty filter apart from an empty team", () => {
    const filtered = selectPanelState(
      input({ activeFacets: ["assigned to you", "In Progress"], totalWithoutFilters: 214 }),
    );
    expect(filtered.state).toEqual({
      kind: "empty-filter",
      facets: ["assigned to you", "In Progress"],
      totalWithoutFilters: 214,
    });

    const empty = selectPanelState(input());
    expect(empty.state).toEqual({ kind: "empty-team", teamName: "Engineering" });
  });

  it("renders rows once there are any", () => {
    const issues = [row({ id: "a" })];
    const views = issues.map((i) => selectRow(i, rowContext()));
    const view = selectPanelState(input({ issues, views, total: 1 }));
    expect(view.state.kind).toBe("rows");
  });

  it("never lets a failure blank the panel", () => {
    // Failure-first ordering means the notice sits above the list, not inside
    // it. A failed load must not replace rows that are already on screen.
    const issues = [row({ id: "a" })];
    const views = issues.map((i) => selectRow(i, rowContext()));
    const view = selectPanelState(
      input({
        issues,
        views,
        total: 1,
        notice: { tone: "warn", message: "Linear isn't answering." },
      }),
    );
    expect(view.state.kind).toBe("rows");
    expect(view.notice?.message).toContain("isn't answering");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("buildPanelView", () => {
  function deps(overrides: Partial<PanelDeps> = {}): PanelDeps {
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG", { name: "Engineering", triageEnabled: true })], NOW);
    store.replaceWorkflowStates("team_eng", [
      state("s_todo", "team_eng", "unstarted", 1, "Todo"),
      state("s_progress", "team_eng", "started", 2, "In Progress"),
    ]);
    store.putMembers([member("u_me", "Ada Lovelace", true)]);
    store.replacePriorityValues([
      { priority: 0, label: "No priority" },
      { priority: 1, label: "Urgent" },
    ]);
    return {
      store,
      now: () => NOW,
      hasCredential: true,
      boundTeamIds: ["team_eng"],
      backfilledTeamIds: new Set(["team_eng"]),
      notice: null,
      ...overrides,
    };
  }

  const query = {
    team: null,
    grouping: "state" as const,
    sort: "updated" as const,
    search: "",
    filters: NO_FILTERS,
  };

  it("refuses a team id that no project binds, even from a hand-edited deep link", () => {
    const d = deps();
    d.store.putIssues([issue({ id: "1", teamId: "team_secret" })], NOW);
    const view = buildPanelView(d, { ...query, team: "team_secret" });
    expect(view.state.kind).toBe("no-binding");
  });

  it("carries the bb-native fact in the lead column when grouping by state", () => {
    const d = deps();
    d.store.putIssues([issue({ id: "1", stateId: "s_progress" })], NOW);
    const view = buildPanelView(d, query);
    if (view.state.kind !== "rows") throw new Error("expected rows");
    expect(view.state.groups[0]?.rows[0]?.lead).toBe("bb-fact");

    // And the Linear state when the grouping is something else, because then
    // the glyph column varies again.
    const byAssignee = buildPanelView(d, { ...query, grouping: "assignee" });
    if (byAssignee.state.kind !== "rows") throw new Error("expected rows");
    expect(byAssignee.state.groups[0]?.rows[0]?.lead).toBe("state");
  });

  it("names every active facet in the user's own vocabulary", () => {
    const d = deps();
    const view = buildPanelView(d, {
      ...query,
      filters: { ...NO_FILTERS, assigneeIds: ["u_me"], stateIds: ["s_progress"] },
    });
    if (view.state.kind !== "empty-filter") throw new Error("expected empty-filter");
    expect(view.state.facets).toContain("assigned to you");
    expect(view.state.facets).toContain("In Progress");
  });

  it("reports the unfiltered total so the empty state can offer it", () => {
    const d = deps();
    d.store.putIssues(
      [issue({ id: "1", stateId: "s_todo" }), issue({ id: "2", stateId: "s_todo" })],
      NOW,
    );
    const view = buildPanelView(d, { ...query, search: "nothing matches this" });
    if (view.state.kind !== "empty-filter") throw new Error("expected empty-filter");
    expect(view.state.totalWithoutFilters).toBe(2);
  });
});

describe("buildFacets", () => {
  it("offers only the state types the bound teams actually use", () => {
    // A team with triage enabled gets a Triage chip; a team without one does
    // not. A fixed list of five types would show a filter matching nothing on
    // most teams and hide one on the teams that use it.
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG")], NOW);
    store.replaceWorkflowStates("team_eng", [
      state("s_todo", "team_eng", "unstarted", 1, "Todo"),
      state("s_progress", "team_eng", "started", 2, "Building"),
    ]);
    const facets = buildFacets(
      {
        store,
        now: () => NOW,
        hasCredential: true,
        boundTeamIds: ["team_eng"],
        backfilledTeamIds: new Set(),
        notice: null,
      },
      null,
    );
    expect(facets.stateTypes.map((entry) => entry.type).sort()).toEqual([
      "started",
      "unstarted",
    ]);
    expect(facets.stateTypes.some((entry) => entry.type === "triage")).toBe(false);
    // The state list keeps the team's own names.
    expect(facets.states.map((entry) => entry.name)).toEqual(["Todo", "Building"]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("buildThreadCandidates", () => {
  function seeded() {
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG", { name: "Engineering" })], NOW);
    store.replaceWorkflowStates("team_eng", [
      state("s_todo", "team_eng", "unstarted", 1, "Todo"),
      state("s_progress", "team_eng", "started", 2, "In Progress"),
      state("s_done", "team_eng", "completed", 3, "Done"),
    ]);
    store.putMembers([member("u_me", "Ada Lovelace", true), member("u_other", "Somebody")]);
    store.replacePriorityValues([{ priority: 0, label: "No priority" }]);
    return store;
  }

  const deps = (store: ReturnType<typeof seeded>): PanelDeps => ({
    store,
    now: () => NOW,
    hasCredential: true,
    boundTeamIds: ["team_eng"],
    backfilledTeamIds: new Set(["team_eng"]),
    notice: null,
  });

  it("suggests only what is assigned to you", () => {
    // A thread panel offering the whole team's board is a picker, and a picker
    // is the thing this exists instead of.
    const store = seeded();
    store.putIssues(
      [
        issue({ id: "i1", teamId: "team_eng", stateId: "s_todo", assigneeId: "u_me" }),
        issue({ id: "i2", teamId: "team_eng", stateId: "s_todo", assigneeId: "u_other" }),
        issue({ id: "i3", teamId: "team_eng", stateId: "s_todo", assigneeId: null }),
      ],
      NOW,
    );
    const rows = buildThreadCandidates(deps(store), ["team_eng"]);
    expect(rows.map((row) => row.id)).toEqual(["i1"]);
  });

  it("drops anything already finished", () => {
    // "What might this thread be about" never means a closed issue.
    const store = seeded();
    store.putIssues(
      [
        issue({ id: "i1", teamId: "team_eng", stateId: "s_done", assigneeId: "u_me" }),
        issue({ id: "i2", teamId: "team_eng", stateId: "s_progress", assigneeId: "u_me" }),
      ],
      NOW,
    );
    const rows = buildThreadCandidates(deps(store), ["team_eng"]);
    expect(rows.map((row) => row.id)).toEqual(["i2"]);
  });

  it("caps the list, because a suggestion stops being one at fifty", () => {
    const store = seeded();
    store.putIssues(
      Array.from({ length: 20 }, (_, index) =>
        issue({
          id: `i${String(index)}`,
          teamId: "team_eng",
          stateId: "s_todo",
          assigneeId: "u_me",
        }),
      ),
      NOW,
    );
    expect(buildThreadCandidates(deps(store), ["team_eng"], 6)).toHaveLength(6);
  });

  it("answers nothing when the project is bound to nothing", () => {
    const store = seeded();
    store.putIssues(
      [issue({ id: "i1", teamId: "team_eng", stateId: "s_todo", assigneeId: "u_me" })],
      NOW,
    );
    expect(buildThreadCandidates(deps(store), [])).toEqual([]);
  });

  it("answers nothing before a key has verified", () => {
    // No viewer means no "you". Suggesting every unfinished issue instead
    // would be the opposite of a suggestion.
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG")], NOW);
    expect(buildThreadCandidates(deps(store), ["team_eng"])).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

describe("estimateScale", () => {
  it("offers the team's own sequence, not a free number", () => {
    // 7 on a fibonacci team is a value Linear accepts and then renders as
    // something that is not on the board.
    expect(estimateScale("fibonacci", { allowZero: false, extended: false })).toEqual([
      1, 2, 3, 5, 8,
    ]);
    expect(estimateScale("exponential", { allowZero: false, extended: false })).toEqual([
      1, 2, 4, 8, 16,
    ]);
    expect(estimateScale("linear", { allowZero: false, extended: false })).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("extends where the team asked for it", () => {
    expect(estimateScale("fibonacci", { allowZero: false, extended: true })).toEqual([
      1, 2, 3, 5, 8, 13, 21,
    ]);
  });

  it("offers zero only where the team allows it", () => {
    expect(estimateScale("linear", { allowZero: true, extended: false })[0]).toBe(0);
    expect(estimateScale("linear", { allowZero: false, extended: false })[0]).toBe(1);
  });

  it("offers nothing at all when the team does not estimate", () => {
    // Which is most teams. The row is absent rather than empty.
    expect(estimateScale("notUsed", { allowZero: true, extended: true })).toEqual([]);
  });

  it("offers nothing for a scale Linear adds after this release", () => {
    // Same discipline as WorkflowState.type: an unknown member degrades to
    // "no opinion" rather than to a wrong opinion.
    expect(estimateScale("something-new", { allowZero: false, extended: false })).toEqual([]);
  });

  it("names a t-shirt value rather than numbering it", () => {
    // A team on t-shirts never wants to read "5".
    expect(estimateLabel(5, "tShirt")).toBe("L");
    expect(estimateLabel(3, "fibonacci")).toBe("3 points");
    expect(estimateLabel(1, "fibonacci")).toBe("1 point");
    expect(estimateLabel(0, "fibonacci")).toBe("No estimate");
  });
});
