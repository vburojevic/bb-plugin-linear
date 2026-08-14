import { describe, expect, it } from "vitest";
import { createTestStore, issue, NOW, team } from "./helpers/store.js";

/**
 * Multi-workspace isolation, at the store layer where the audit found the
 * teeth. Two workspaces belonging to one owner (personal + company) share one
 * mirror; nothing here may let one bleed into the other.
 */

function twoWorkspaceStore() {
  const store = createTestStore();
  store.putWorkspace(
    { id: "ws_personal", slot: "apiKey", name: "Personal", urlKey: "personal", viewerId: "u_me", viewerName: "Me", gitBranchFormat: null },
    NOW,
  );
  store.putWorkspace(
    { id: "ws_company", slot: "apiKey2", name: "Acme Corp", urlKey: "acme", viewerId: "u_work", viewerName: "Me at Work", gitBranchFormat: null },
    NOW,
  );
  // Both workspaces have a team keyed ENG — the collision the audit is about.
  store.putTeams([team("team_p_eng", "ENG", { workspaceId: "ws_personal" })], NOW);
  store.putTeams([team("team_c_eng", "ENG", { workspaceId: "ws_company" })], NOW);
  return store;
}

describe("cross-workspace key collision is detectable", () => {
  it("teamsByKey returns BOTH ENG teams, not an arbitrary one", () => {
    const store = twoWorkspaceStore();
    const matches = store.teamsByKey("ENG");
    expect(matches.map((row) => row.id).sort()).toEqual(["team_c_eng", "team_p_eng"]);
    // The singular form still exists for callers that legitimately want "any",
    // but the plural is what write paths use to refuse ambiguity.
    expect(store.teamByKey("ENG")).not.toBeNull();
  });

  it("issuesByIdentifier returns every workspace's ENG-42", () => {
    const store = twoWorkspaceStore();
    store.putIssues([issue({ id: "ip", identifier: "ENG-42", teamId: "team_p_eng", title: "personal 42" })], NOW);
    store.putIssues([issue({ id: "ic", identifier: "ENG-42", teamId: "team_c_eng", title: "company 42" })], NOW);
    const matches = store.issuesByIdentifier("ENG-42");
    expect(matches.map((row) => row.id).sort()).toEqual(["ic", "ip"]);
  });

  it("resolves an identifier that exists in only one workspace unambiguously", () => {
    const store = twoWorkspaceStore();
    store.putIssues([issue({ id: "ip", identifier: "ENG-7", teamId: "team_p_eng", title: "only personal" })], NOW);
    expect(store.issuesByIdentifier("ENG-7").map((r) => r.id)).toEqual(["ip"]);
  });

  it("still resolves an issue that MOVED teams and changed identifier", () => {
    // The regression this exists to prevent: the plural lookup replaced a
    // singular one that had a previous-identifier fallback, so every write
    // path stopped resolving renamed issues — the panel would render an issue
    // fine and then refuse every edit on it.
    const store = twoWorkspaceStore();
    store.putIssues(
      [issue({ id: "im", identifier: "PLAT-7", teamId: "team_p_eng", title: "moved" })],
      NOW,
    );
    store.putPreviousIdentifiers("im", ["ENG-42"]);

    expect(store.issuesByIdentifier("PLAT-7").map((r) => r.id)).toEqual(["im"]);
    expect(store.issuesByIdentifier("ENG-42").map((r) => r.id)).toEqual(["im"]);
  });

  it("prefers a live identifier over someone else's former one", () => {
    // The fallback must never mask a real, current match.
    const store = twoWorkspaceStore();
    store.putIssues(
      [
        issue({ id: "live", identifier: "ENG-42", teamId: "team_p_eng", title: "current" }),
        issue({ id: "old", identifier: "PLAT-9", teamId: "team_p_eng", title: "moved away" }),
      ],
      NOW,
    );
    store.putPreviousIdentifiers("old", ["ENG-42"]);
    expect(store.issuesByIdentifier("ENG-42").map((r) => r.id)).toEqual(["live"]);
  });
});

describe("forgetWorkspace removes everything the workspace owned", () => {
  it("deletes company issues, comments, bindings, thread links and inbox rows — and leaves personal data intact", () => {
    const store = twoWorkspaceStore();

    // Personal side.
    store.putIssues([issue({ id: "ip", identifier: "ENG-1", teamId: "team_p_eng", title: "personal work" })], NOW);
    store.setBinding("proj_personal", "team_p_eng", "primary", NOW);
    store.linkThread({ threadId: "th_p", issueId: "ip", teamId: "team_p_eng", projectId: "proj_personal", createdAt: NOW, origin: "manual" });

    // Company side — the data that must vanish.
    store.putIssues([issue({ id: "ic", identifier: "ENG-1", teamId: "team_c_eng", title: "company work" })], NOW);
    store.putComments([{ id: "cc", issueId: "ic", userId: null, parentId: null, body: "company comment", url: null, createdAt: NOW, updatedAt: NOW, editedAt: null, resolvedAt: null }]);
    store.setBinding("proj_company", "team_c_eng", "primary", NOW);
    store.linkThread({ threadId: "th_c", issueId: "ic", teamId: "team_c_eng", projectId: "proj_company", createdAt: NOW, origin: "manual" });
    store.putInbox([{ key: "n_c", kind: "assigned", issueId: "ic", teamId: "team_c_eng", actorId: null, title: "assigned", body: null, url: null, createdAt: NOW, seenAt: null, dismissedAt: null, linearReadAt: null }]);

    store.forgetWorkspace("ws_company");

    // The company's DATA is gone — the staleness and retention win.
    expect(store.issue("ic")).toBeNull();
    expect(store.comments("ic")).toEqual([]);
    expect(store.team("team_c_eng")).toBeNull();
    expect(store.inbox({ limit: 10 }).some((row) => row.key === "n_c")).toBe(false);
    // And it stops driving sync, which is what the cascade is really for.
    expect(store.boundTeamIds()).not.toContain("team_c_eng");

    // Personal untouched — this is the half that must survive.
    expect(store.issue("ip")).not.toBeNull();
    expect(store.threadLink("th_p")?.issueId).toBe("ip");
    expect(store.boundTeamIds()).toContain("team_p_eng");
    expect(store.team("team_p_eng")).not.toBeNull();
  });

  it("leaves the full-text index consistent — a forgotten issue is unsearchable", () => {
    // `issue_fts` is external-content: it holds no copy of the text and
    // SQLite does not maintain the link. If the DELETE trigger did not fire
    // for the cascade, search would keep returning company rows whose issue
    // record is gone — the worst kind of stale, because the row then fails to
    // open.
    const store = twoWorkspaceStore();
    store.setBinding("proj_company", "team_c_eng", "primary", NOW);
    store.putIssues(
      [issue({ id: "ic", identifier: "ENG-9", teamId: "team_c_eng", title: "confidential acquisition plan" })],
      NOW,
    );
    expect(
      store.queryIssues({ teamIds: ["team_c_eng"], text: "acquisition", sort: "updated", limit: 10 }),
    ).toHaveLength(1);

    store.forgetWorkspace("ws_company");

    // Searched without a team filter, so nothing but the index itself can
    // hide the row.
    expect(
      store.queryIssues({ teamIds: [], text: "acquisition", sort: "updated", limit: 10 }),
    ).toEqual([]);
    expect(
      store.queryIssues({ teamIds: ["team_c_eng"], text: "acquisition", sort: "updated", limit: 10 }),
    ).toEqual([]);
  });

  it("keeps the user's own intent — bindings and thread links survive", () => {
    // This runs from a DETACHED discovery pass whose only evidence is one
    // settings read. If a transient empty read could destroy bindings and
    // thread links, a hiccup would silently cost work nobody can get back —
    // so the cascade takes Linear's data and leaves the user's statements.
    const store = twoWorkspaceStore();
    store.putIssues(
      [issue({ id: "ic", identifier: "ENG-1", teamId: "team_c_eng", title: "x" })],
      NOW,
    );
    store.setBinding("proj_company", "team_c_eng", "primary", NOW);
    store.linkThread({
      threadId: "th_c",
      issueId: "ic",
      teamId: "team_c_eng",
      projectId: "proj_company",
      createdAt: NOW,
      origin: "manual",
    });

    store.forgetWorkspace("ws_company");

    expect(store.bindingsForProject("proj_company")).toHaveLength(1);
    expect(store.threadLink("th_c")).not.toBeNull();
    // …but neither one resurrects the departed workspace as a sync target.
    expect(store.boundTeamIds()).toEqual([]);
  });

  it("returns the forgotten team ids, so their backfill markers can be cleared", () => {
    // Without clearing `backfilled:<teamId>`, pasting the key back leaves
    // every team marked "already synced" and the board comes back
    // permanently empty.
    const store = twoWorkspaceStore();
    expect(store.forgetWorkspace("ws_company")).toEqual(["team_c_eng"]);
  });

  it("sweeps teams with no recorded workspace when the primary key goes", () => {
    // `workspace_id` is deliberately NULL for teams recorded before the
    // mirror knew about multiple workspaces. Those belong to the primary
    // slot, so forgetting the primary workspace must take them — otherwise
    // clearing the first key leaves the entire mirror behind, which is the
    // exact leak this cascade exists to close.
    const store = createTestStore();
    store.putWorkspace(
      {
        id: "ws_p",
        slot: "apiKey",
        name: "Personal",
        urlKey: "p",
        viewerId: "u",
        viewerName: "U",
        gitBranchFormat: null,
      },
      NOW,
    );
    store.putTeams([team("team_legacy", "OLD")], NOW); // workspaceId defaults to null
    store.putIssues(
      [issue({ id: "il", identifier: "OLD-1", teamId: "team_legacy", title: "legacy" })],
      NOW,
    );

    const forgotten = store.forgetWorkspace("ws_p");

    expect(forgotten).toContain("team_legacy");
    expect(store.team("team_legacy")).toBeNull();
    expect(store.issue("il")).toBeNull();
  });
});
