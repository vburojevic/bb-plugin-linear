import { describe, expect, it } from "vitest";
import {
  bindOffer,
  buildBindingsView,
  canRead,
  canWrite,
  crossTeamRefusal,
  describeBinding,
  expandTeams,
  refuseCrossTeam,
  scopeFor,
} from "../src/bindings.js";
import type { BindingRow, TeamRow } from "../src/store/rows.js";
import { NOW, team as makeTeam } from "./helpers/store.js";

const ENG: TeamRow = { ...makeTeam("t_eng", "ENG", { name: "Engineering" }), fetchedAt: NOW };
const DES: TeamRow = { ...makeTeam("t_des", "DES", { name: "Design" }), fetchedAt: NOW };
const PLT: TeamRow = { ...makeTeam("t_plt", "PLT", { name: "Platform" }), fetchedAt: NOW };

const BINDINGS: BindingRow[] = [
  { projectId: "p1", teamId: "t_eng", role: "primary", boundAt: NOW },
  { projectId: "p1", teamId: "t_des", role: "write", boundAt: NOW },
  { projectId: "p1", teamId: "t_plt", role: "read", boundAt: NOW },
  { projectId: "p2", teamId: "t_des", role: "primary", boundAt: NOW },
];

describe("scopeFor", () => {
  it("separates what a project may write from what it may see", () => {
    const scope = scopeFor("p1", BINDINGS);
    expect(scope.primaryTeamId).toBe("t_eng");
    expect([...scope.writeTeamIds].sort()).toEqual(["t_des", "t_eng"]);
    expect([...scope.readTeamIds].sort()).toEqual(["t_des", "t_eng", "t_plt"]);

    expect(canWrite(scope, "t_plt")).toBe(false);
    expect(canRead(scope, "t_plt")).toBe(true);
    expect(canRead(scope, "t_other")).toBe(false);
  });

  it("gives an unbound project nothing at all", () => {
    const scope = scopeFor("p_new", BINDINGS);
    expect(scope.primaryTeamId).toBeNull();
    expect(scope.readTeamIds).toEqual([]);
  });

  it("keeps one project's binding out of another's", () => {
    expect(scopeFor("p2", BINDINGS).primaryTeamId).toBe("t_des");
    expect(scopeFor("p2", BINDINGS).readTeamIds).toEqual(["t_des"]);
  });
});

describe("the cross-team refusal", () => {
  it("names both sides and the way out", () => {
    // A filter artefact — "no results" — teaches the user that the issue does
    // not exist. A refusal teaches the actual rule.
    const message = crossTeamRefusal({
      identifier: "PLT-402",
      targetTeam: { name: "Platform", key: "PLT" },
      allowed: [
        { name: "Engineering", key: "ENG" },
        { name: "Design", key: "DES" },
      ],
      action: "write",
    });
    expect(message).toContain("Engineering (ENG) and Design (DES)");
    expect(message).toContain("PLT-402 belongs to Platform (PLT)");
    expect(message).toContain("Add Platform to this project's binding");
  });

  it("reads sensibly when the project is bound to nothing", () => {
    const message = crossTeamRefusal({
      identifier: "PLT-402",
      targetTeam: { name: "Platform", key: "PLT" },
      allowed: [],
      action: "read",
    });
    expect(message).toContain("isn't bound to any Linear team");
  });

  it("throws a refusal, which is never retried", () => {
    expect(() =>
      refuseCrossTeam({
        identifier: "PLT-1",
        targetTeam: { name: "Platform", key: "PLT" },
        allowed: [],
        action: "write",
      }),
    ).toThrow(/PLT-1 belongs to Platform/);
  });
});

describe("expandTeams", () => {
  const TREE: TeamRow[] = [
    ENG,
    { ...DES, parentId: "t_eng" },
    { ...PLT, parentId: "t_des" },
  ];

  it("is off by default, because a silent widening is the outcome scoping exists to prevent", () => {
    expect(expandTeams(["t_eng"], TREE, false)).toEqual(["t_eng"]);
  });

  it("walks two levels when asked", () => {
    expect(expandTeams(["t_eng"], TREE, true).sort()).toEqual(["t_des", "t_eng", "t_plt"]);
  });

  it("terminates on a cycle rather than hanging the sync service", () => {
    const cyclic: TeamRow[] = [
      { ...ENG, parentId: "t_des" },
      { ...DES, parentId: "t_eng" },
    ];
    expect(expandTeams(["t_eng"], cyclic, true).sort()).toEqual(["t_des", "t_eng"]);
  });

  it("returns an empty set for an empty set", () => {
    expect(expandTeams([], TREE, true)).toEqual([]);
  });
});

describe("describeBinding", () => {
  it("reads as a sentence, not a legend", () => {
    expect(describeBinding({ primary: ENG, write: [DES], read: [PLT] })).toBe(
      "Engineering is where new work goes. Issues in Design are editable from here too. Platform is read-only.",
    );
  });

  it("says only what applies", () => {
    expect(describeBinding({ primary: ENG, write: [], read: [] })).toBe(
      "Engineering is where new work goes.",
    );
    expect(describeBinding({ primary: null, write: [], read: [] })).toBe(
      "Not bound to a Linear team.",
    );
  });
});

describe("bindOffer", () => {
  it("offers a sentence and a button when there is exactly one team", () => {
    // No picker — and still no auto-binding: auto-binding trains both the code
    // and the user into an assumption that breaks the day a second team
    // appears, and it makes the refusal meaningless because nobody chose.
    const offer = bindOffer([ENG], "Acme");
    expect(offer.kind).toBe("single");
    if (offer.kind !== "single") return;
    expect(offer.sentence).toBe(
      "Acme has one team, Engineering (ENG). Bind this project to it?",
    );
  });

  it("offers a picker when there are several", () => {
    expect(bindOffer([ENG, DES], "Acme").kind).toBe("pick");
  });

  it("says so when the key can see none", () => {
    expect(bindOffer([], "Acme").kind).toBe("none-visible");
  });
});

describe("buildBindingsView", () => {
  const projects = [
    { id: "p1", name: "bb/api", kind: "standard" as const },
    { id: "p2", name: "bb/marketing-site", kind: "standard" as const },
    { id: "p_personal", name: "Personal", kind: "personal" as const },
  ];

  it("lists the personal project like any other, labelled", () => {
    // Omitting it strands the solo developer who never created a project:
    // every thread of theirs would be unbound, every Linear tool withheld, and
    // the Bind button would point at a list the project is not in.
    const view = buildBindingsView({
      projects,
      bindings: BINDINGS,
      teams: [ENG, DES, PLT],
      workspaceName: "Acme",
    });
    const personal = view.unbound.find((entry) => entry.projectId === "p_personal");
    expect(personal?.projectName).toBe("Personal threads");
    expect(personal?.isPersonal).toBe(true);
  });

  it("splits bound from unbound", () => {
    const view = buildBindingsView({
      projects,
      bindings: BINDINGS,
      teams: [ENG, DES, PLT],
      workspaceName: "Acme",
    });
    expect(view.bound.map((entry) => entry.projectId).sort()).toEqual(["p1", "p2"]);
    expect(view.unbound.map((entry) => entry.projectId)).toEqual(["p_personal"]);
  });

  it("counts visible teams without a denominator", () => {
    // `teams` returns "All teams whose issues the user can access", so a
    // team-restricted key cannot see what it is restricted away from.
    const view = buildBindingsView({
      projects,
      bindings: BINDINGS,
      teams: [ENG, DES],
      workspaceName: "Acme",
    });
    expect(view.teamsVisible).toBe(2);
    expect(view.teams.map((entry) => entry.bound)).toEqual([true, true]);
  });

  it("survives a binding whose team is not in the local copy yet", () => {
    const view = buildBindingsView({
      projects: [projects[0]!],
      bindings: [{ projectId: "p1", teamId: "t_unknown", role: "primary", boundAt: NOW }],
      teams: [],
      workspaceName: null,
    });
    // Unbound rather than crashing: the team list arrives on the next
    // discovery, and until then the honest answer is that nothing is resolved.
    expect(view.bound).toEqual([]);
    expect(view.unbound[0]?.sentence).toBe("Not bound to a Linear team.");
  });
});
