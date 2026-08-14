import { describe, expect, it } from "vitest";
import {
  isWorkingSetEmpty,
  nonEmpty,
  selectWorkingSet,
  type WorkingFacts,
} from "../src/select/working.js";
import { issue, NOW } from "./helpers/store.js";
import type { IssueRow } from "../src/store/rows.js";

const ME = "u_me";

/** State ids that map to the four types these rules care about. Types, never
 *  names: `WorkflowState.type` is a String and a team's column can be called
 *  anything in any language. */
const STATE_TYPES = new Map([
  ["s_backlog", "backlog"],
  ["s_todo", "unstarted"],
  ["s_doing", "started"],
  ["s_done", "completed"],
  ["s_dropped", "canceled"],
  ["s_triage", "triage"],
]);

function facts(overrides: Partial<WorkingFacts> = {}): WorkingFacts {
  return {
    running: new Set(),
    threaded: new Set(),
    branched: new Set(),
    pullRequests: new Map(),
    blockers: new Map(),
    viewerId: ME,
    stateTypes: STATE_TYPES,
    ...overrides,
  };
}

function row(id: string, stateId: string, assigneeId: string | null = ME): IssueRow {
  return { ...issue({ id, stateId, assigneeId }), syncedAt: NOW };
}

function bucket(buckets: ReturnType<typeof selectWorkingSet>, id: string): readonly string[] {
  return buckets.find((entry) => entry.id === id)?.issueIds ?? [];
}

describe("the working set", () => {
  it("puts an issue you started in Linear somewhere, with no thread and no branch", () => {
    // Found live. Somebody moves an issue to In Progress in Linear and has not
    // opened bb yet — the single most common state there is. Requiring a
    // branch meant it landed in no bucket at all, and the panel answered
    // "nothing needs you right now" while the thing you had just started sat
    // invisible.
    const buckets = selectWorkingSet([row("i1", "s_doing")], facts());
    expect(bucket(buckets, "started-no-pr")).toEqual(["i1"]);
    expect(isWorkingSetEmpty(buckets)).toBe(false);
  });

  it("does not claim somebody else's in-progress issue", () => {
    // A team's other members' work is not your working set. Without the
    // assignee check this bucket would fill with the whole team's board.
    const buckets = selectWorkingSet([row("i1", "s_doing", "u_someone")], facts());
    expect(isWorkingSetEmpty(buckets)).toBe(true);
  });

  it("claims work happening on this machine whoever it is assigned to", () => {
    // A branch or a thread is evidence, not a guess: something is genuinely
    // being worked on here.
    const buckets = selectWorkingSet(
      [row("i1", "s_todo", "u_someone")],
      facts({ branched: new Set(["i1"]) }),
    );
    expect(bucket(buckets, "started-no-pr")).toEqual(["i1"]);
  });

  it("gives each issue at most one bucket, first match winning", () => {
    // The whole design. An issue under three headings is a list you have to
    // de-duplicate in your head before it is useful.
    const buckets = selectWorkingSet(
      [row("i1", "s_doing")],
      facts({
        running: new Set(["i1"]),
        threaded: new Set(["i1"]),
        blockers: new Map([["i1", ["ENG-9"]]]),
      }),
    );
    expect(bucket(buckets, "running")).toEqual(["i1"]);
    const total = buckets.reduce((sum, entry) => sum + entry.issueIds.length, 0);
    expect(total).toBe(1);
  });

  it("ranks a pull request waiting on a human above work with no PR at all", () => {
    const buckets = selectWorkingSet(
      [row("i1", "s_doing"), row("i2", "s_doing")],
      facts({
        threaded: new Set(["i1", "i2"]),
        pullRequests: new Map([["i1", { attention: "review_requested" }]]),
      }),
    );
    expect(bucket(buckets, "pr-needs-you")).toEqual(["i1"]);
    expect(bucket(buckets, "started-no-pr")).toEqual(["i2"]);
  });

  it("ignores a pull request that is not asking for anything", () => {
    // A bucket called "PR needs you" containing a merged pull request is a
    // bucket nobody trusts twice.
    const buckets = selectWorkingSet(
      [row("i1", "s_doing")],
      facts({ pullRequests: new Map([["i1", { attention: "merged" }]]) }),
    );
    expect(bucket(buckets, "pr-needs-you")).toEqual([]);
    // It also stops being "no PR", because there is one.
    expect(bucket(buckets, "started-no-pr")).toEqual([]);
  });

  it("never shows a finished issue, whatever else is true of it", () => {
    const buckets = selectWorkingSet(
      [row("i1", "s_done"), row("i2", "s_dropped")],
      facts({ branched: new Set(["i1", "i2"]), blockers: new Map([["i2", ["ENG-9"]]]) }),
    );
    expect(isWorkingSetEmpty(buckets)).toBe(true);
  });

  it("still shows a finished issue whose bb thread is running", () => {
    // The thread is the fact. An issue somebody closed while the agent is
    // still working on it is precisely the thing you need to be told about.
    const buckets = selectWorkingSet([row("i1", "s_done")], facts({ running: new Set(["i1"]) }));
    expect(bucket(buckets, "running")).toEqual(["i1"]);
  });

  it("puts a blocked issue ahead of one you have not picked up", () => {
    const buckets = selectWorkingSet(
      [row("i1", "s_todo"), row("i2", "s_todo")],
      facts({ blockers: new Map([["i1", ["ENG-9"]]]) }),
    );
    expect(bucket(buckets, "blocked")).toEqual(["i1"]);
    expect(bucket(buckets, "assigned-unstarted")).toEqual(["i2"]);
  });

  it("treats a triage issue as unstarted rather than as nothing", () => {
    // `WorkflowState.type` is a String and Linear adds members. An exhaustive
    // switch over five of them drops issues on triage-enabled teams.
    const buckets = selectWorkingSet([row("i1", "s_triage")], facts());
    expect(bucket(buckets, "assigned-unstarted")).toEqual(["i1"]);
  });

  it("survives an issue with no state at all", () => {
    const buckets = selectWorkingSet([row("i1", "s_unknown_to_us")], facts());
    expect(isWorkingSetEmpty(buckets)).toBe(false);
  });

  it("shows nothing when there is no viewer, rather than everything", () => {
    // A key that has not verified yet has no viewer. "Assigned to you" with no
    // "you" must resolve to nobody, not to anybody.
    const buckets = selectWorkingSet(
      [row("i1", "s_doing"), row("i2", "s_todo")],
      facts({ viewerId: null }),
    );
    expect(isWorkingSetEmpty(buckets)).toBe(true);
  });

  it("drops empty buckets from what renders", () => {
    const buckets = selectWorkingSet([row("i1", "s_doing")], facts());
    expect(nonEmpty(buckets).map((entry) => entry.id)).toEqual(["started-no-pr"]);
  });

  it("gives every bucket a hint, because an all-empty set shows all five", () => {
    const buckets = selectWorkingSet([], facts());
    expect(buckets).toHaveLength(5);
    for (const entry of buckets) {
      expect(entry.emptyHint.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});
