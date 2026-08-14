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

    // Company gone, root and branch.
    expect(store.issue("ic")).toBeNull();
    expect(store.comments("ic")).toEqual([]);
    expect(store.threadLink("th_c")).toBeNull();
    expect(store.team("team_c_eng")).toBeNull();
    expect(store.boundTeamIds()).not.toContain("team_c_eng");
    expect(store.inbox({ limit: 10 }).some((row) => row.key === "n_c")).toBe(false);

    // Personal untouched — this is the half that must survive.
    expect(store.issue("ip")).not.toBeNull();
    expect(store.threadLink("th_p")?.issueId).toBe("ip");
    expect(store.boundTeamIds()).toContain("team_p_eng");
    expect(store.team("team_p_eng")).not.toBeNull();
  });

  it("leaves no orphaned binding that would keep the sync loop polling the gone team", () => {
    // The audited failure: a surviving binding row makes boundTeamIds() return
    // a team whose workspace no longer exists, and the sync loop then polls
    // that id over the primary key forever.
    const store = twoWorkspaceStore();
    store.setBinding("proj_company", "team_c_eng", "primary", NOW);
    store.forgetWorkspace("ws_company");
    expect(store.boundTeamIds()).toEqual([]);
    expect(store.bindings()).toEqual([]);
  });
});
