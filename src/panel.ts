import type {
  Facets,
  PanelFilters,
  PanelNotice,
  PanelView,
  WorkingSetView,
} from "./contract.js";
import { todayAsTimelessDate } from "./format.js";
import {
  selectPanelState,
  selectRow,
  type BbFact,
  type Grouping,
  type IssueRowView,
} from "./select/panel.js";
import { toneForStateType } from "./select/tone.js";
import {
  isWorkingSetEmpty,
  nonEmpty,
  selectWorkingSet,
  type WorkingFacts,
} from "./select/working.js";
import type { IssueSort, Store } from "./store/store.js";
import type { IssueRow, MemberRow, TeamRow, WorkflowStateRow } from "./store/rows.js";

/**
 * Assembly: mirror rows in, one `PanelView` out.
 *
 * The projection lives in `src/select/panel.ts` and is pure; this is the layer
 * that gathers what it needs from SQLite. Kept separate because the two fail
 * differently — a projection bug is a wrong sentence, a gathering bug is a
 * missing row — and because the projection is what the tests assert on.
 *
 * **No surface here ever waits on Linear.** Everything below is a query
 * against the local mirror; the poller is what makes it current, and a poller
 * that is behind produces a stale panel with a sentence saying so rather than
 * a spinner.
 */

export interface PanelQuery {
  /** A team id or a team key; `null` means every bound team. */
  readonly team: string | null;
  readonly grouping: Grouping;
  readonly sort: IssueSort;
  readonly search: string;
  readonly filters: PanelFilters;
}

export interface PanelDeps {
  readonly store: Store;
  readonly now: () => number;
  readonly hasCredential: boolean;
  /** Teams bound to at least one bb project. The panel's scope is the
   *  binding, never the workspace. */
  readonly boundTeamIds: readonly string[];
  /** Which of those teams have finished their bounded backfill. A team that
   *  has not is *reading*, not *empty*. */
  readonly backfilledTeamIds: ReadonlySet<string>;
  readonly notice: PanelNotice | null;
  /** What bb knows that Linear cannot. Empty until the milestone that fills
   *  it; an absent fact renders as no fact rather than as a wrong one. */
  readonly bbFacts?: ReadonlyMap<string, BbFact>;
}

/**
 * How many rows cross the wire.
 *
 * The panel windows above 200 rows, 60 at a time, so anything past this is
 * invisible until the user filters or searches — and shipping ten thousand
 * rows to render sixty is the kind of thing that makes a plugin the reason bb
 * feels slow.
 */
export const PANEL_ROW_LIMIT = 300;

/**
 * Resolve an id-or-key to a bound team id, or to nothing.
 *
 * The value is untrusted — it round-trips through the address bar — so it is
 * resolved first and then **narrowed against the bound set**. That second step
 * is what stops a hand-edited deep link from reading a team no bb project
 * binds, and it is why an unknown team produces the no-binding state rather
 * than an empty list that looks like a team with no work.
 */
function scopeTeams(deps: PanelDeps, team: string | null): string[] {
  if (team === null) return [...deps.boundTeamIds];
  const resolved = deps.store.team(team) ?? deps.store.teamByKey(team);
  if (resolved === null) return [];
  return deps.boundTeamIds.includes(resolved.id) ? [resolved.id] : [];
}

export function buildPanelView(deps: PanelDeps, query: PanelQuery): PanelView {
  const teamIds = scopeTeams(deps, query.team);
  const selectedTeam = teamIds.length === 1 ? deps.store.team(teamIds[0]!) : null;

  if (!deps.hasCredential || teamIds.length === 0) {
    return selectPanelState({
      hasCredential: deps.hasCredential,
      boundTeams: [],
      selectedTeam: null,
      hasEverSynced: false,
      issues: [],
      views: [],
      grouping: emptyGroupingContext(query.grouping),
      total: 0,
      totalWithoutFilters: 0,
      activeFacets: [],
      notice: deps.notice,
    });
  }

  const filter = {
    teamIds,
    stateIds: query.filters.stateIds,
    stateTypes: query.filters.stateTypes,
    assigneeIds: query.filters.assigneeIds,
    labelIds: query.filters.labelIds,
    priorities: query.filters.priorities,
    includeCompleted: query.filters.includeCompleted,
    text: query.search,
  };

  const issues = deps.store.queryIssues({ ...filter, sort: query.sort, limit: PANEL_ROW_LIMIT });
  const total = deps.store.countIssues(filter);
  // The baseline for "Clear filters to see all 214" — the same scope with
  // every facet dropped, including the search text.
  const totalWithoutFilters = deps.store.countIssues({ teamIds });

  const states = new Map<string, WorkflowStateRow>();
  for (const teamId of teamIds) {
    for (const state of deps.store.workflowStates(teamId)) states.set(state.id, state);
  }
  const members = new Map<string, MemberRow>(
    deps.store.members().map((member) => [member.id, member]),
  );
  const priorityLabels = new Map<number, string>(
    deps.store.priorityValues().map((value) => [value.priority, value.label]),
  );

  const issueIds = issues.map((issue) => issue.id);
  const progress = deps.store.subIssueProgress(issueIds);
  const blockers = deps.store.blockersFor(issueIds);
  // Read from `pr_state`, never from a fresh git-host call per row: a lookup
  // shells out to `gh`, and forty rows would be forty processes.
  const pullRequests = new Map(
    deps.store
      .prStatesByIssue(issueIds)
      .filter((row) => row.issueId !== null && row.prNumber !== null)
      .map((row) => [row.issueId!, { number: row.prNumber!, attention: row.prAttention ?? "none" }]),
  );
  const cycleNames = new Map(
    teamIds
      .flatMap((teamId) => deps.store.cycles(teamId))
      .map((cycle) => [cycle.id, cycle.name ?? `Cycle ${cycle.number}`] as const),
  );
  const projectNames = new Map(
    deps.store.projects(teamIds).map((project) => [project.id, project.name] as const),
  );
  // A cycle name earns its place on a row only when the view spans cycles —
  // inside a single-cycle filter it is the same string on every row, which
  // makes it decoration.
  const spansCycles = new Set(issues.map((issue) => issue.cycleId)).size > 1;
  const today = todayAsTimelessDate(deps.now());

  const context = {
    states,
    members,
    priorityLabels,
    now: deps.now(),
    today,
    // Grouping by state means every glyph inside a group is identical, so the
    // lead column carries the bb-native fact instead and the state moves to
    // the header where it varies.
    lead: query.grouping === "state" ? ("bb-fact" as const) : ("state" as const),
  };

  const views: IssueRowView[] = issues.map((issue) =>
    selectRow(
      issue,
      context,
      {
        pr: pullRequests.get(issue.id) ?? null,
        blockedBy: blockers.get(issue.id) ?? [],
        subIssues: progress.get(issue.id) ?? null,
        cycleName: issue.cycleId === null ? null : (cycleNames.get(issue.cycleId) ?? null),
        showCycle: spansCycles,
      },
      deps.bbFacts?.get(issue.id) ?? "none",
    ),
  );

  return selectPanelState({
    hasCredential: deps.hasCredential,
    boundTeams: teamIds
      .map((id) => deps.store.team(id))
      .filter((team): team is TeamRow => team !== null),
    selectedTeam,
    hasEverSynced: teamIds.every((id) => deps.backfilledTeamIds.has(id)),
    issues,
    views,
    grouping: {
      grouping: query.grouping,
      states,
      members,
      projectNames,
      cycleNames,
    },
    total,
    totalWithoutFilters,
    activeFacets: describeActiveFacets(query, states, members, deps.store),
    notice: deps.notice,
  });
}

function emptyGroupingContext(grouping: Grouping) {
  return {
    grouping,
    states: new Map<string, WorkflowStateRow>(),
    members: new Map<string, MemberRow>(),
    projectNames: new Map<string, string>(),
    cycleNames: new Map<string, string>(),
  };
}

/**
 * Every active facet, named in the user's own vocabulary.
 *
 * This is what makes the empty state a sentence rather than a shrug: *"No
 * issues match **assigned to you** and **In Progress** in **Engineering**"*
 * tells you which control to reach for. A generic "no results" does not.
 */
function describeActiveFacets(
  query: PanelQuery,
  states: ReadonlyMap<string, WorkflowStateRow>,
  members: ReadonlyMap<string, MemberRow>,
  store: Store,
): string[] {
  const facets: string[] = [];

  if (query.search.trim() !== "") facets.push(`“${query.search.trim()}”`);

  for (const stateId of query.filters.stateIds) {
    const state = states.get(stateId);
    if (state !== undefined) facets.push(state.name);
  }
  for (const type of query.filters.stateTypes) facets.push(type);

  for (const assigneeId of query.filters.assigneeIds) {
    const member = members.get(assigneeId);
    if (member === undefined) continue;
    facets.push(member.isMe ? "assigned to you" : `assigned to ${member.displayName}`);
  }

  if (query.filters.labelIds.length > 0) {
    const byId = new Map(store.labels([]).map((label) => [label.id, label.name]));
    for (const labelId of query.filters.labelIds) {
      const name = byId.get(labelId);
      if (name !== undefined) facets.push(name);
    }
  }

  const priorityNames = new Map(
    store.priorityValues().map((value) => [value.priority, value.label]),
  );
  for (const priority of query.filters.priorities) {
    facets.push(priorityNames.get(priority) ?? `priority ${priority}`);
  }

  return facets;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The Working set                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The panel's default segment.
 *
 * Grouped by **bb fact**, so the lead glyph carries the Linear state — the
 * mirror image of *All issues*, where the grouping is by state and the lead
 * carries the bb fact. In both cases the lead column shows the thing that
 * varies within a group, which is the only way a column of glyphs is worth
 * the pixels.
 */
/**
 * The issues a thread with no linked issue could plausibly mean.
 *
 * Assigned to you and unfinished, in the teams this thread's project is bound
 * to — not "every issue in the workspace", which is a picker rather than a
 * suggestion. Somebody opening a thread's Linear tab with nothing linked wants
 * the two or three things it could obviously be, and a searchable list of four
 * hundred is the same as no help at all.
 */
export function buildThreadCandidates(
  deps: PanelDeps,
  teamIds: readonly string[],
  limit = 6,
): IssueRowView[] {
  if (teamIds.length === 0) return [];
  const viewer = deps.store.viewer();
  if (viewer === null) return [];

  const issues = deps.store.queryIssues({
    teamIds,
    assigneeIds: [viewer.id],
    sort: "updated",
    limit: limit * 3,
  });

  const states = new Map<string, WorkflowStateRow>();
  for (const teamId of teamIds) {
    for (const state of deps.store.workflowStates(teamId)) states.set(state.id, state);
  }

  const open = issues
    .filter((issue) => {
      const type = issue.stateId === null ? "" : (states.get(issue.stateId)?.type ?? "");
      return type !== "completed" && type !== "canceled";
    })
    .slice(0, limit);

  return buildRowViews(deps, open);
}

/**
 * Project a handful of already-chosen issues into rows.
 *
 * For the small, explicit lists — a thread's candidates, the identifiers found
 * in a chat message — where the caller has decided *which* issues and only
 * needs them rendered the same way every other row is. Deliberately carries no
 * second-line facts: those cost a query each and none of these surfaces show
 * them.
 */
export function buildRowViews(deps: PanelDeps, issues: readonly IssueRow[]): IssueRowView[] {
  if (issues.length === 0) return [];

  const states = new Map<string, WorkflowStateRow>();
  for (const teamId of new Set(issues.map((issue) => issue.teamId))) {
    for (const state of deps.store.workflowStates(teamId)) states.set(state.id, state);
  }

  const context = {
    states,
    members: new Map(deps.store.members().map((member) => [member.id, member])),
    priorityLabels: new Map(
      deps.store.priorityValues().map((value) => [value.priority, value.label]),
    ),
    now: deps.now(),
    today: todayAsTimelessDate(deps.now()),
    lead: "state" as const,
  };

  return issues.map((issue) => selectRow(issue, context));
}

export function buildWorkingSet(deps: PanelDeps, team: string | null): WorkingSetView {
  const teamIds = scopeTeams(deps, team);

  if (!deps.hasCredential) return { kind: "no-credential" };
  if (teamIds.length === 0) return { kind: "no-binding" };
  if (!teamIds.every((id) => deps.backfilledTeamIds.has(id))) {
    const only = teamIds.length === 1 ? deps.store.team(teamIds[0]!) : null;
    return { kind: "first-sync", teamName: only?.name ?? null };
  }

  // Every open issue in scope. The buckets are a partition of this, not five
  // separate queries — which is what makes "at most one bucket per issue"
  // enforceable rather than aspirational.
  const issues = deps.store.queryIssues({ teamIds, sort: "priority", limit: PANEL_ROW_LIMIT });
  const issueIds = issues.map((issue) => issue.id);

  const states = new Map<string, WorkflowStateRow>();
  for (const teamId of teamIds) {
    for (const state of deps.store.workflowStates(teamId)) states.set(state.id, state);
  }
  const members = new Map(deps.store.members().map((member) => [member.id, member]));
  const priorityLabels = new Map(
    deps.store.priorityValues().map((value) => [value.priority, value.label]),
  );

  const links = deps.store.threadLinksForIssues(issueIds);
  const prRows = deps.store.prStatesByIssue(issueIds);
  const blockers = deps.store.blockersFor(issueIds);
  const progress = deps.store.subIssueProgress(issueIds);

  const facts: WorkingFacts = {
    running: new Set(
      links
        .filter((link) => deps.bbFacts?.get(link.issueId) === "thread-running")
        .map((link) => link.issueId),
    ),
    threaded: new Set(links.map((link) => link.issueId)),
    branched: new Set(
      prRows.filter((row) => row.issueId !== null).map((row) => row.issueId!),
    ),
    pullRequests: new Map(
      prRows
        .filter((row) => row.issueId !== null && row.prNumber !== null)
        .map((row) => [row.issueId!, { attention: row.prAttention ?? "none" }]),
    ),
    blockers,
    viewerId: deps.store.viewer()?.id ?? null,
    stateTypes: new Map([...states].map(([id, state]) => [id, state.type])),
  };

  const buckets = selectWorkingSet(issues, facts);
  if (isWorkingSetEmpty(buckets)) {
    return { kind: "clear", hints: buckets.map((bucket) => bucket.emptyHint) };
  }

  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const context = {
    states,
    members,
    priorityLabels,
    now: deps.now(),
    today: todayAsTimelessDate(deps.now()),
    // Grouped by bb fact, so the lead is the Linear state.
    lead: "state" as const,
  };
  const prByIssue = new Map(
    prRows
      .filter((row) => row.issueId !== null && row.prNumber !== null)
      .map((row) => [row.issueId!, { number: row.prNumber!, attention: row.prAttention ?? "none" }]),
  );

  return {
    kind: "buckets",
    buckets: nonEmpty(buckets).map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      emptyHint: bucket.emptyHint,
      rows: bucket.issueIds
        .map((id) => byId.get(id))
        .filter((issue): issue is NonNullable<typeof issue> => issue !== undefined)
        .map((issue) =>
          selectRow(
            issue,
            context,
            {
              pr: prByIssue.get(issue.id) ?? null,
              blockedBy: blockers.get(issue.id) ?? [],
              subIssues: progress.get(issue.id) ?? null,
              showCycle: false,
            },
            deps.bbFacts?.get(issue.id) ?? "none",
          ),
        ),
    })),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Facets                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The chips the filter row offers, derived from the bound teams' **own rows**.
 *
 * A team with triage enabled gets a Triage chip; a team without one does not.
 * A fixed list of five state types compiled into the plugin would show a
 * Triage filter that matches nothing on most teams, and hide one on the teams
 * that use it.
 */
export function buildFacets(deps: PanelDeps, team: string | null): Facets {
  const teamIds = scopeTeams(deps, team);

  const states = teamIds
    .flatMap((id) => deps.store.workflowStates(id))
    .map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      position: state.position,
      tone: toneForStateType(state.type),
    }));

  // Deduplicate types across teams: two teams both having a "started" state
  // is one chip, not two.
  const seenTypes = new Set<string>();
  const stateTypes: Facets["stateTypes"] = [];
  for (const state of states) {
    if (seenTypes.has(state.type)) continue;
    seenTypes.add(state.type);
    stateTypes.push({
      type: state.type,
      label: STATE_TYPE_LABELS[state.type] ?? state.name,
      tone: toneForStateType(state.type),
    });
  }

  return {
    states: states.sort((a, b) => a.position - b.position),
    stateTypes,
    labels: deps.store.labels(teamIds).map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
    })),
    members: deps.store.members().map((member) => ({
      id: member.id,
      name: member.displayName,
      initials: initials(member.displayName || member.name),
      avatarUrl: member.avatarUrl,
      isMe: member.isMe,
    })),
    priorities: deps.store.priorityValues().map((value) => ({
      priority: value.priority,
      label: value.label,
    })),
  };
}

/**
 * The one place this plugin puts English on a Linear concept, and it is
 * deliberate: `WorkflowState.type` is a categorisation, not a name, and it has
 * no workspace-supplied label. Where a *name* exists — a state, a priority, a
 * label — the workspace's own string always wins, and an unrecognised type
 * falls back to the team's state name rather than to a constant.
 */
const STATE_TYPE_LABELS: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In progress",
  completed: "Done",
  canceled: "Cancelled",
  duplicate: "Duplicate",
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...(words[0] ?? "")][0] ?? "";
  const second = words.length > 1 ? ([...(words[1] ?? "")][0] ?? "") : "";
  return `${first}${second}`.toUpperCase();
}
