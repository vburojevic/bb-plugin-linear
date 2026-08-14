import { describe, expect, it } from "vitest";
import { toMatchQuery } from "../src/store/store.js";
import { createTestStore, issue, member, NOW, state, team } from "./helpers/store.js";

describe("the migration list", () => {
  it("is one statement per entry", () => {
    // `bb.storage.migrate` uses the statement index as the migration id. Two
    // statements in one entry means the second is invisible to the tracker and
    // re-runs — or, worse, silently never runs on an existing install.
    // `createTestStore` prepares each entry individually, and better-sqlite3
    // throws on a multi-statement string.
    expect(() => createTestStore()).not.toThrow();
  });
});

describe("full-text search", () => {
  it("finds an issue written through the store", () => {
    // `issue_fts` is external-content: the index holds no copy of the text and
    // SQLite does not maintain the link for you. Without the three triggers,
    // every search returns zero rows — no error, no empty state, just nothing
    // found, forever.
    const store = createTestStore();
    store.putIssues(
      [issue({ id: "1", identifier: "ENG-1", title: "Fix the flaky login test" })],
      NOW,
    );
    const found = store.queryIssues({
      teamIds: ["team_eng"],
      text: "flaky",
      sort: "updated",
      limit: 10,
    });
    expect(found.map((row) => row.id)).toEqual(["1"]);
  });

  it("keeps the index in step when a row is updated", () => {
    const store = createTestStore();
    store.putIssues([issue({ id: "1", title: "Original title" })], NOW);
    store.putIssues([issue({ id: "1", title: "Replaced heading" })], NOW + 1);

    const stale = store.queryIssues({
      teamIds: ["team_eng"],
      text: "Original",
      sort: "updated",
      limit: 10,
    });
    const fresh = store.queryIssues({
      teamIds: ["team_eng"],
      text: "Replaced",
      sort: "updated",
      limit: 10,
    });
    expect(stale).toEqual([]);
    expect(fresh).toHaveLength(1);
  });

  it("drops the row from the index when the row is deleted", () => {
    const store = createTestStore();
    store.putIssues([issue({ id: "1", title: "Ephemeral" })], NOW);
    store.deleteIssues(["1"]);
    expect(
      store.queryIssues({ teamIds: ["team_eng"], text: "Ephemeral", sort: "updated", limit: 10 }),
    ).toEqual([]);
  });

  it("finds an issue by its identifier, because the tokeniser splits on punctuation", () => {
    const store = createTestStore();
    store.putIssues([issue({ id: "1", identifier: "ENG-123", title: "Something" })], NOW);
    expect(
      store.queryIssues({ teamIds: ["team_eng"], text: "ENG-123", sort: "updated", limit: 10 }),
    ).toHaveLength(1);
  });
});

describe("toMatchQuery", () => {
  it("neutralises FTS5 syntax rather than letting it throw mid-keystroke", () => {
    // FTS5's query language is a real grammar: a stray quote, a bare `*`, an
    // unbalanced paren or a bare `OR` throws rather than matching nothing —
    // and the throw lands while somebody is still typing.
    expect(toMatchQuery('login" OR 1=1')).toBe('"login"* "OR"* "1"* "1"*');
    expect(toMatchQuery("*")).toBe('""');
    expect(toMatchQuery("   ")).toBe('""');
  });

  it("survives every punctuation shape a search box receives", () => {
    const store = createTestStore();
    store.putIssues([issue({ id: "1", title: "Retry backoff" })], NOW);
    for (const text of ['"', "((", "NEAR", "a AND", "*", "^", "-", "ENG-1:"]) {
      expect(() =>
        store.queryIssues({ teamIds: ["team_eng"], text, sort: "updated", limit: 10 }),
      ).not.toThrow();
    }
  });
});

describe("issue scoping", () => {
  it("returns nothing for an empty team list", () => {
    // An unbound project must get nothing, never everything. This is layer 2
    // of the scoping defence and it is what makes the rule hold even if a
    // caller forgets to check.
    const store = createTestStore();
    store.putIssues([issue({ id: "1" })], NOW);
    expect(store.queryIssues({ teamIds: [], sort: "updated", limit: 10 })).toEqual([]);
    expect(store.countIssues({ teamIds: [] })).toBe(0);
  });

  it("never returns another team's issues", () => {
    const store = createTestStore();
    store.putIssues(
      [issue({ id: "1", teamId: "team_eng" }), issue({ id: "2", teamId: "team_des" })],
      NOW,
    );
    const rows = store.queryIssues({ teamIds: ["team_eng"], sort: "updated", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["1"]);
  });

  it("excludes completed and archived work by default", () => {
    const store = createTestStore();
    store.replaceWorkflowStates("team_eng", [
      state("s_open", "team_eng", "started"),
      state("s_done", "team_eng", "completed"),
    ]);
    store.putIssues(
      [
        issue({ id: "1", stateId: "s_open" }),
        issue({ id: "2", stateId: "s_done" }),
        issue({ id: "3", stateId: "s_open", archivedAt: NOW }),
      ],
      NOW,
    );
    expect(
      store.queryIssues({ teamIds: ["team_eng"], sort: "updated", limit: 10 }).map((r) => r.id),
    ).toEqual(["1"]);
    expect(
      store
        .queryIssues({
          teamIds: ["team_eng"],
          includeCompleted: true,
          includeArchived: true,
          sort: "updated",
          limit: 10,
        })
        .map((r) => r.id)
        .sort(),
    ).toEqual(["1", "2", "3"]);
  });

  it("filters on labels through the JSON array", () => {
    const store = createTestStore();
    store.putIssues(
      [
        issue({ id: "1", labelIds: ["l_bug", "l_ui"] }),
        issue({ id: "2", labelIds: ["l_ui"] }),
        issue({ id: "3", labelIds: [] }),
      ],
      NOW,
    );
    expect(
      store
        .queryIssues({ teamIds: ["team_eng"], labelIds: ["l_bug"], sort: "updated", limit: 10 })
        .map((r) => r.id),
    ).toEqual(["1"]);
  });

  it("round-trips a label array that is not valid JSON without crashing a render", () => {
    const store = createTestStore();
    store.putIssues([issue({ id: "1" })], NOW);
    store.db.prepare(`UPDATE issue SET label_ids = 'not json' WHERE id = '1'`).run();
    expect(store.issue("1")?.labelIds).toEqual([]);
  });
});

describe("sorting", () => {
  it("puts None last when sorting by priority, which is what people mean", () => {
    const store = createTestStore();
    store.putIssues(
      [
        issue({ id: "none", priority: 0, updatedAt: NOW }),
        issue({ id: "urgent", priority: 1, updatedAt: NOW }),
        issue({ id: "low", priority: 4, updatedAt: NOW }),
      ],
      NOW,
    );
    expect(
      store.queryIssues({ teamIds: ["team_eng"], sort: "priority", limit: 10 }).map((r) => r.id),
    ).toEqual(["urgent", "low", "none"]);
  });

  it("puts issues with no due date last", () => {
    const store = createTestStore();
    store.putIssues(
      [
        issue({ id: "none", dueDate: null }),
        issue({ id: "later", dueDate: "2026-12-01" }),
        issue({ id: "soon", dueDate: "2026-08-13" }),
      ],
      NOW,
    );
    expect(
      store.queryIssues({ teamIds: ["team_eng"], sort: "due", limit: 10 }).map((r) => r.id),
    ).toEqual(["soon", "later", "none"]);
  });
});

describe("identifiers", () => {
  it("resolves an issue by an identifier it used to have", () => {
    // An issue moved between teams changes identifier. A link written last
    // month must still resolve rather than reporting that the issue does not
    // exist.
    const store = createTestStore();
    store.putIssues([issue({ id: "1", identifier: "DES-45" })], NOW);
    store.putPreviousIdentifiers("1", ["ENG-123"]);
    expect(store.issueByIdentifier("ENG-123")?.id).toBe("1");
    expect(store.issueByIdentifier("eng-123")?.id).toBe("1");
    expect(store.issueByIdentifier("NOPE-1")).toBeNull();
  });
});

describe("bindings", () => {
  it("allows exactly one primary per project, enforced by the database", () => {
    const store = createTestStore();
    store.setBinding("proj_1", "team_eng", "primary", NOW);
    store.setBinding("proj_1", "team_des", "primary", NOW);

    const rows = store.bindingsForProject("proj_1");
    expect(rows.filter((row) => row.role === "primary").map((row) => row.teamId)).toEqual([
      "team_des",
    ]);
    // The incumbent is demoted rather than deleted: the project keeps its
    // ability to write to that team, which is almost always what was meant.
    expect(rows.find((row) => row.teamId === "team_eng")?.role).toBe("write");
  });

  it("keeps one project's binding out of another's", () => {
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG"), team("team_des", "DES")], NOW);
    store.setBinding("proj_1", "team_eng", "primary", NOW);
    store.setBinding("proj_2", "team_des", "primary", NOW);
    expect(store.bindingsForProject("proj_1")).toHaveLength(1);
    expect(store.boundTeamIds().sort()).toEqual(["team_des", "team_eng"]);
  });

  it("stops treating a binding as a sync instruction once its team is gone", () => {
    // A binding whose team was removed with its workspace must not keep the
    // sync loop polling that id over whichever key is left — it would send a
    // departed workspace's team ids to the wrong API and get silently empty
    // answers forever. The binding row itself survives (it is the user's
    // intent, restored when the key comes back); it just stops driving sync.
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG")], NOW);
    store.setBinding("proj_1", "team_eng", "primary", NOW);
    expect(store.boundTeamIds()).toEqual(["team_eng"]);

    store.putWorkspace(
      { id: "ws", slot: "apiKey2", name: "Gone", urlKey: "gone", viewerId: "u", viewerName: "U", gitBranchFormat: null },
      NOW,
    );
    store.putTeams([team("team_eng", "ENG", { workspaceId: "ws" })], NOW);
    store.forgetWorkspace("ws");

    expect(store.boundTeamIds()).toEqual([]);
    expect(store.bindingsForProject("proj_1")).toHaveLength(1);
  });

  it("re-binding the same team changes its role in place", () => {
    const store = createTestStore();
    store.setBinding("proj_1", "team_des", "read", NOW);
    store.setBinding("proj_1", "team_des", "write", NOW);
    expect(store.bindingsForProject("proj_1")).toEqual([
      { projectId: "proj_1", teamId: "team_des", role: "write", boundAt: NOW },
    ]);
  });
});

describe("teams", () => {
  it("reads booleans back as booleans", () => {
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG", { triageEnabled: true, cyclesEnabled: false })], NOW);
    const row = store.team("team_eng");
    expect(row?.triageEnabled).toBe(true);
    expect(row?.cyclesEnabled).toBe(false);
  });

  it("walks the parent graph without hanging on a cycle", () => {
    const store = createTestStore();
    store.putTeams(
      [
        team("a", "A"),
        team("b", "B", { parentId: "a" }),
        team("c", "C", { parentId: "b" }),
        team("d", "D", { parentId: "d" }),
      ],
      NOW,
    );
    expect(store.descendantTeamIds(["a"]).sort()).toEqual(["a", "b", "c"]);
    expect(store.descendantTeamIds(["d"])).toEqual(["d"]);
  });
});

describe("sub-issue progress", () => {
  it("counts children in one query", () => {
    const store = createTestStore();
    store.replaceWorkflowStates("team_eng", [
      state("s_open", "team_eng", "started"),
      state("s_done", "team_eng", "completed"),
    ]);
    store.putIssues(
      [
        issue({ id: "parent" }),
        issue({ id: "c1", parentId: "parent", stateId: "s_done" }),
        issue({ id: "c2", parentId: "parent", stateId: "s_done" }),
        issue({ id: "c3", parentId: "parent", stateId: "s_open" }),
      ],
      NOW,
    );
    expect(store.subIssueProgress(["parent"]).get("parent")).toEqual({ done: 2, total: 3 });
    expect(store.subIssueProgress([]).size).toBe(0);
  });
});

describe("forgetEverything", () => {
  it("leaves an empty schema and no data", () => {
    // Disconnect means it. `bb plugin remove` does not do this — the host
    // deletes settings rows and the secrets directory and leaves data.db in
    // place — so this is the only thing that removes a workspace's issue data
    // from the machine.
    const store = createTestStore();
    store.putTeams([team("team_eng", "ENG")], NOW);
    store.putMembers([member("u1", "Ada", true)]);
    store.putIssues([issue({ id: "1", title: "Findable" })], NOW);
    store.setBinding("proj_1", "team_eng", "primary", NOW);

    store.forgetEverything();

    expect(store.teams()).toEqual([]);
    expect(store.members()).toEqual([]);
    expect(store.bindings()).toEqual([]);
    expect(
      store.queryIssues({ teamIds: ["team_eng"], text: "Findable", sort: "updated", limit: 10 }),
    ).toEqual([]);
    // And the schema still stands, so the plugin keeps working afterwards.
    expect(() => store.putIssues([issue({ id: "2" })], NOW)).not.toThrow();
  });
});
