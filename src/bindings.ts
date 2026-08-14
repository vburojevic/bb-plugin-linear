import type { BindingsView, ProjectBindingView, TeamView } from "./contract.js";
import { compareTitles, joinSentence } from "./format.js";
import { refused } from "./linear/errors.js";
import type { BindingRow, TeamRow } from "./store/rows.js";

/**
 * Per-project team scoping — the model, and the refusal.
 *
 * A bb project binds to exactly one **primary** Linear team, plus zero or more
 * additional teams each marked **write** or **read**. Unqualified writes,
 * spawns and pull-request transitions target the primary; a tool or command
 * may name another team explicitly and is allowed if and only if that team is
 * in the write set.
 *
 * Two alternatives were rejected and both are worth stating, because the
 * shape of this file is the argument against them.
 *
 * *A project that implicitly reaches every team the key can see* makes "which
 * team does this new issue go to?" unanswerable without a picker on every
 * action, and turns the refusal below into a lie.
 *
 * *Primary-only writes* forces a monorepo organisation into one bb project per
 * team on a single repository — forty projects, each with its own environments
 * and worktrees — purely to work around a Linear-side fact. That is a bb-side
 * workaround for somebody else's data model.
 */

export interface Scope {
  readonly projectId: string;
  /** `null` when the project is bound to nothing. Every Linear capability is
   *  withheld in that case rather than degraded. */
  readonly primaryTeamId: string | null;
  /** Primary plus every additional write team. */
  readonly writeTeamIds: readonly string[];
  /** Everything readable: write teams plus read-only ones. */
  readonly readTeamIds: readonly string[];
}

export const UNBOUND: Scope = {
  projectId: "",
  primaryTeamId: null,
  writeTeamIds: [],
  readTeamIds: [],
};

export function scopeFor(projectId: string, bindings: readonly BindingRow[]): Scope {
  const mine = bindings.filter((row) => row.projectId === projectId);
  const primary = mine.find((row) => row.role === "primary") ?? null;
  const write = mine.filter((row) => row.role === "primary" || row.role === "write");
  return {
    projectId,
    primaryTeamId: primary?.teamId ?? null,
    writeTeamIds: write.map((row) => row.teamId),
    readTeamIds: mine.map((row) => row.teamId),
  };
}

export function canRead(scope: Scope, teamId: string): boolean {
  return scope.readTeamIds.includes(teamId);
}

export function canWrite(scope: Scope, teamId: string): boolean {
  return scope.writeTeamIds.includes(teamId);
}

/**
 * A cross-team request gets a **named refusal, not an empty list.**
 *
 * A filter artefact — "no results" — teaches the user that the issue does not
 * exist. A refusal teaches the actual rule, and names both sides of it so the
 * next step is obvious. This exact sentence is also what the panel renders
 * when a deep link points at an issue whose team no bb project binds, which
 * is the one place a stranger meets the scoping model and the place it should
 * teach itself.
 */
export function crossTeamRefusal(input: {
  readonly identifier: string;
  readonly targetTeam: { readonly name: string; readonly key: string };
  readonly allowed: readonly { readonly name: string; readonly key: string }[];
  readonly action: "write" | "read";
}): string {
  const verb = input.action === "write" ? "can write to" : "can see";
  const allowedText =
    input.allowed.length === 0
      ? "isn't bound to any Linear team"
      : `${verb} ${joinSentence(input.allowed.map((team) => `${team.name} (${team.key})`))}`;
  return (
    `This thread's project ${allowedText}. ` +
    `${input.identifier} belongs to ${input.targetTeam.name} (${input.targetTeam.key}). ` +
    `Add ${input.targetTeam.name} to this project's binding, or open the issue from a project that owns it.`
  );
}

export function refuseCrossTeam(input: Parameters<typeof crossTeamRefusal>[0]): never {
  throw refused(crossTeamRefusal(input));
}

/**
 * Widen a bound team set to include sub-teams, when the setting asks for it.
 *
 * `includeSubTeams` exists as an argument on `Team.issues` and `Team.projects`
 * and on custom-view connections — and **not on the root `issues` query**,
 * where every one of this plugin's queries lives. So the setting is honoured
 * by expanding team ids at tick-build time and widening the existing
 * `team: { id: { in: [...] } }` filter: one query shape, the team-scoping lint
 * intact, and the sub-team ids visible in the document for debugging.
 *
 * Off by default. A parent-team binding silently pulling six children's issues
 * is exactly the "silently wrong" outcome the scoping model exists to prevent.
 */
export function expandTeams(
  rootIds: readonly string[],
  teams: readonly TeamRow[],
  includeSubTeams: boolean,
): string[] {
  if (!includeSubTeams || rootIds.length === 0) return [...rootIds];

  const children = new Map<string, string[]>();
  for (const team of teams) {
    if (team.parentId === null) continue;
    const list = children.get(team.parentId) ?? [];
    list.push(team.id);
    children.set(team.parentId, list);
  }

  const seen = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of children.get(next) ?? []) {
      // A cycle in a team graph should be impossible. A walk that assumes so
      // is a walk that hangs the sync service the day it is not.
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/**
 * The sentence a project's binding reads as, for the settings section and the
 * picker.
 *
 * *"Engineering is where new work goes. Issues in Design and Platform are
 * editable from here too; Platform is read-only."* — one sentence rather than
 * three chips, because the difference between a write team and a read-only one
 * is a rule, and a rule reads better as prose than as a legend.
 */
export function describeBinding(input: {
  readonly primary: TeamRow | null;
  readonly write: readonly TeamRow[];
  readonly read: readonly TeamRow[];
}): string {
  if (input.primary === null) return "Not bound to a Linear team.";

  const sentences = [`${input.primary.name} is where new work goes.`];
  const editable = input.write.map((team) => team.name);
  if (editable.length > 0) {
    sentences.push(
      `Issues in ${joinSentence(editable)} ${editable.length === 1 ? "are" : "are"} editable from here too.`,
    );
  }
  if (input.read.length > 0) {
    const names = joinSentence(input.read.map((team) => team.name));
    sentences.push(`${names} ${input.read.length === 1 ? "is" : "are"} read-only.`);
  }
  return sentences.join(" ");
}

/**
 * What to offer when a project has no binding yet.
 *
 * With exactly one team there is no picker: one sentence and one button.
 * Auto-binding is still rejected — it trains both the code and the user into
 * an assumption that breaks the day a second team appears, and it makes the
 * refusal above meaningless because nobody ever chose anything.
 */
export type BindOffer =
  | { readonly kind: "none-visible" }
  | { readonly kind: "single"; readonly team: TeamRow; readonly sentence: string }
  | { readonly kind: "pick"; readonly teams: readonly TeamRow[] };

/* ────────────────────────────────────────────────────────────────────────── */
/* The settings section's view                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "personal" | "standard";
}

export function toTeamView(
  team: TeamRow,
  bound: boolean,
  /** Workspace name by id, and only when more than one is connected. Two
   *  workspaces can each have a team called Engineering, and a picker that
   *  cannot tell them apart is a picker that binds the wrong one. */
  workspaceNames?: ReadonlyMap<string, string>,
): TeamView {
  return {
    id: team.id,
    workspaceName:
      workspaceNames === undefined || team.workspaceId === null
        ? null
        : (workspaceNames.get(team.workspaceId) ?? null),
    key: team.key,
    name: team.name,
    color: team.color,
    parentId: team.parentId,
    triageEnabled: team.triageEnabled,
    cyclesEnabled: team.cyclesEnabled,
    estimationType: team.estimationType,
    bound,
  };
}

/**
 * Bound projects and unbound projects, split.
 *
 * The settings section renders bound projects inline and puts everything else
 * behind a search field, because the alternative — a searchable team picker
 * rendered once per project — is forty pickers on a settings page for an
 * organisation with forty projects.
 *
 * **`includePersonal: true` is not optional at the call site.** It defaults to
 * false, and omitting it strands the solo developer who never created a
 * project: every thread of theirs lives in the personal project, so every
 * thread would be unbound, every Linear tool would be withheld, mentions would
 * return nothing, and the composer banner's Bind button would point at a list
 * the project is not in. It is listed here like any other project, labelled.
 */
export function buildBindingsView(input: {
  readonly projects: readonly ProjectSummary[];
  readonly bindings: readonly BindingRow[];
  readonly teams: readonly TeamRow[];
  readonly workspaceName: string | null;
  /** Every connected workspace. One entry means the names are dropped from
   *  the rows: naming the only workspace on every row is noise. */
  readonly workspaces?: readonly { readonly id: string; readonly name: string }[];
}): BindingsView {
  const teamsById = new Map(input.teams.map((team) => [team.id, team]));
  const workspaceNames =
    input.workspaces !== undefined && input.workspaces.length > 1
      ? new Map(input.workspaces.map((entry) => [entry.id, entry.name]))
      : undefined;
  const boundTeamIds = new Set(input.bindings.map((row) => row.teamId));

  const views = input.projects.map((project): ProjectBindingView => {
    const rows = input.bindings.filter((row) => row.projectId === project.id);
    const pick = (role: BindingRow["role"]) =>
      rows
        .filter((row) => row.role === role)
        .map((row) => teamsById.get(row.teamId))
        .filter((team): team is TeamRow => team !== undefined);

    const primary = pick("primary")[0] ?? null;
    const write = pick("write");
    const read = pick("read");

    return {
      projectId: project.id,
      projectName: project.kind === "personal" ? "Personal threads" : project.name,
      isPersonal: project.kind === "personal",
      primary: primary === null ? null : toTeamView(primary, true, workspaceNames),
      write: write.map((team) => toTeamView(team, true, workspaceNames)),
      read: read.map((team) => toTeamView(team, true, workspaceNames)),
      sentence: describeBinding({ primary, write, read }),
    };
  });

  return {
    workspaceName: input.workspaceName,
    bound: views
      .filter((view) => view.primary !== null)
      .sort((a, b) => compareTitles(a.projectName, b.projectName)),
    unbound: views
      .filter((view) => view.primary === null)
      .sort((a, b) => compareTitles(a.projectName, b.projectName)),
    teams: input.teams.map((team) =>
      toTeamView(team, boundTeamIds.has(team.id), workspaceNames),
    ),
    // Never a denominator. `teams` returns "All teams whose issues the user
    // can access", so a team-restricted key cannot see the teams it is
    // restricted away from — "3 of 5" would be a number the plugin has no way
    // to know.
    teamsVisible: input.teams.length,
  };
}

export function bindOffer(teams: readonly TeamRow[], workspaceName: string): BindOffer {
  if (teams.length === 0) return { kind: "none-visible" };
  if (teams.length === 1) {
    const team = teams[0]!;
    return {
      kind: "single",
      team,
      sentence: `${workspaceName} has one team, ${team.name} (${team.key}). Bind this project to it?`,
    };
  }
  return { kind: "pick", teams };
}
