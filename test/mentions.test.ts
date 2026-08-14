import { describe, expect, it } from "vitest";
import type { PluginMentionProviderRegistration } from "@bb/plugin-sdk";
import { registerMentionProviders } from "../src/mentions.js";
import { toolsFor, UNBOUND_INSTRUCTION } from "../src/tools.js";
import { teamContextText } from "../src/tools-format.js";
import type { BindingRow } from "../src/store/rows.js";
import { createTestStore, issue, member, NOW, state, team } from "./helpers/store.js";

const BINDINGS: BindingRow[] = [
  { projectId: "p1", teamId: "team_eng", role: "primary", boundAt: NOW },
];

function harness(bindings: readonly BindingRow[] = BINDINGS) {
  const store = createTestStore();
  store.putTeams([team("team_eng", "ENG", { name: "Engineering" })], NOW);
  store.replaceWorkflowStates("team_eng", [
    state("s_progress", "team_eng", "started", 1, "In Progress"),
  ]);
  store.putMembers([member("u_me", "Ada Lovelace", true)]);
  store.replacePriorityValues([{ priority: 0, label: "No priority" }]);
  store.putIssues(
    [
      issue({
        id: "i_1",
        identifier: "ENG-42",
        title: "Fix the flaky login test",
        stateId: "s_progress",
      }),
      issue({ id: "i_2", teamId: "team_secret", identifier: "SEC-1", title: "Secret work" }),
    ],
    NOW,
  );

  let registration: PluginMentionProviderRegistration | undefined;
  const bb = {
    ui: {
      registerMentionProvider(value: PluginMentionProviderRegistration) {
        registration = value;
      },
    },
  } as never;

  registerMentionProviders(bb, { store, bindings: () => bindings });
  if (registration === undefined) throw new Error("no provider registered");
  return { store, provider: registration };
}

describe("the issue mention provider", () => {
  it("returns zero rows for projectId: null", async () => {
    // `null` is the NORMAL state on the new-thread compose surface. Falling
    // through to "all bound teams" there would leak another team's issue
    // titles to someone who has not yet chosen a project — precisely the leak
    // the scoping model exists to prevent. It is tempting to treat it as a
    // convenience, which is why this test sits next to the unbound one.
    const { provider } = harness();
    const rows = await provider.search({
      trigger: "#",
      query: "flaky",
      projectId: null,
      threadId: null,
    });
    expect(rows).toEqual([]);
  });

  it("returns zero rows for an unbound project", async () => {
    const { provider } = harness([]);
    const rows = await provider.search({
      trigger: "#",
      query: "flaky",
      projectId: "p1",
      threadId: null,
    });
    expect(rows).toEqual([]);
  });

  it("finds an issue in a bound team", async () => {
    const { provider } = harness();
    const rows = await provider.search({
      trigger: "#",
      query: "flaky",
      projectId: "p1",
      threadId: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toContain("ENG-42");
    expect(rows[0]?.subtitle).toBe("In Progress");
  });

  it("never offers an unbound team's issue", async () => {
    const { provider } = harness();
    const rows = await provider.search({
      trigger: "#",
      query: "Secret",
      projectId: "p1",
      threadId: null,
    });
    expect(rows).toEqual([]);
  });

  it("lists what was touched most recently when the query is empty", async () => {
    const { provider } = harness();
    const rows = await provider.search({
      trigger: "#",
      query: "",
      projectId: "p1",
      threadId: null,
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("resolves a missing item to a note rather than throwing", async () => {
    // A throw at send time blocks the send with a visible error, and the user
    // loses the message they were writing.
    const { provider } = harness();
    const resolved = await provider.resolve("i_gone");
    expect(resolved.context).toContain("no longer in bb's local copy");
  });

  it("resolves a real item to prose, not JSON", async () => {
    const { provider } = harness();
    const resolved = await provider.resolve("i_1");
    expect(resolved.context).toContain("ENG-42 — Fix the flaky login test");
    expect(resolved.context).toContain("State: In Progress (started)");
    expect(resolved.context.trim().startsWith("{")).toBe(false);
  });
});

describe("tool selection", () => {
  it("gives read tools at every setting and withholds writes below full", () => {
    expect(toolsFor("off")).not.toContain("linear_comment");
    expect(toolsFor("off")).toContain("linear_search");

    // The default. Read and comment — an agent silently re-labelling a
    // colleague's issue on first run is worse than an uninvited comment, and
    // the uninvited comment is already off by default.
    expect(toolsFor("comment")).toContain("linear_comment");
    expect(toolsFor("comment")).not.toContain("linear_issue_update");

    expect(toolsFor("full")).toContain("linear_issue_update");
  });

  it("keeps every issue-creating tool behind Full, and reading in front of it", () => {
    // An agent that can file issues on a misread fills somebody's tracker
    // with its notes. Reading a project, a cycle or a saved view cannot.
    for (const tool of ["linear_project_list", "linear_cycle_get", "linear_view_run"]) {
      expect(toolsFor("off")).toContain(tool);
    }
    for (const tool of ["linear_issue_create", "linear_issue_relate", "linear_issue_attach"]) {
      expect(toolsFor("comment")).not.toContain(tool);
      expect(toolsFor("full")).toContain(tool);
    }
  });

  it("never offers a tool that deletes or archives, at any setting", () => {
    // Archiving is offered in the UI behind a confirmation a person reads.
    // An agent gets neither it nor anything worse, whatever the setting says.
    for (const writes of ["off", "comment", "full"] as const) {
      for (const tool of toolsFor(writes)) {
        expect(tool).not.toMatch(/archive|delete|remove/i);
      }
    }
  });

  it("has one sentence for an unbound project", () => {
    expect(UNBOUND_INSTRUCTION).toContain("isn't bound to a Linear team");
  });
});

describe("teamContextText", () => {
  it("gives a model the ids it needs and the types it should reason with", () => {
    // This is the tool that stops a model inventing "In Progress" at a team
    // that calls its column "Building".
    const text = teamContextText({
      team: { ...team("team_eng", "ENG", { name: "Engineering" }), fetchedAt: NOW },
      states: [state("s_build", "team_eng", "started", 1, "Building")],
      labels: [],
      members: [member("u_me", "Ada Lovelace", true)],
      priorities: [{ priority: 1, label: "Urgent" }],
    });
    expect(text).toContain("Building — type started — id s_build");
    expect(text).toContain("matching on the name would be matching on English");
    expect(text).toContain("Ada Lovelace — id u_me (you, the signed-in user)");
  });

  it("says plainly when a team does not estimate", () => {
    const text = teamContextText({
      team: { ...team("t", "T"), fetchedAt: NOW, estimationType: "notUsed" },
      states: [],
      labels: [],
      members: [],
      priorities: [],
    });
    expect(text).toContain("this team does not use them. Do not set one");
  });
});
