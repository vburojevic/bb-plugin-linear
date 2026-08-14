import { parseInstant } from "../format.js";
import type {
  BootstrapResult,
  BreadthResult,
  IssueRelationsResult,
  IssueDetailNode,
  IssueNode,
  TeamGraphResult,
} from "../linear/types.js";
import type { IssueInput, Store, TeamInput } from "../store/store.js";
import type {
  CommentRow,
  CycleRow,
  LabelRow,
  MemberRow,
  MilestoneRow,
  ProjectRow,
  RelationRow,
  WorkflowStateRow,
} from "../store/rows.js";

/**
 * The one boundary where Linear's shapes become the mirror's rows.
 *
 * Three things happen here and nowhere else, which is the point of having a
 * single file for it:
 *
 * **ISO-8601 becomes epoch milliseconds, exactly once.** Every timestamp is
 * parsed here and never re-parsed; everything downstream compares integers.
 * A value that does not parse becomes `null` rather than `NaN`, because a
 * `NaN` in a column silently poisons every comparison it takes part in and
 * does it three frames from the parse.
 *
 * **Relations flatten to ids.** Linear returns `{ team: { id } }`; the mirror
 * stores `team_id`. Doing it here means no query anywhere else has to know
 * that Linear nests.
 *
 * **`TimelessDate` stays a string.** `dueDate` is a calendar fact, not an
 * instant, and converting it picks a timezone on the user's behalf.
 *
 * Every write is an upsert keyed on Linear's `id`, which is what makes the
 * poller's deliberate watermark overlap free: re-reading a page costs one
 * request and changes nothing.
 */

export function applyBootstrap(
  store: Store,
  result: BootstrapResult,
  at: number,
  /** Which settings slot's key produced this. A Linear key is scoped to one
   *  workspace, so this is also the answer to "which key can reach these
   *  teams" for every team in the result. */
  slot: string,
): void {
  const { viewer } = result;

  store.putWorkspace(
    {
      id: viewer.organization.id,
      slot,
      name: viewer.organization.name,
      urlKey: viewer.organization.urlKey,
      viewerId: viewer.id,
      viewerName: viewer.displayName,
      gitBranchFormat: viewer.organization.gitBranchFormat,
    },
    at,
  );

  // The viewer is a member row like any other, flagged `is_me`. That is what
  // lets "assigned to you" be a plain query rather than a special case
  // threaded through every filter.
  store.putMembers([
    {
      id: viewer.id,
      workspaceId: viewer.organization.id,
      name: viewer.name,
      displayName: viewer.displayName,
      email: viewer.email,
      avatarUrl: viewer.avatarUrl,
      active: true,
      isApp: false,
      isMe: true,
      updatedAt: at,
    },
  ]);

  // Project statuses are workspace-level (`Organization.projectStatuses`),
  // unlike issue workflow states, which are team-level. The two look
  // symmetrical and are scoped differently.
  store.replaceProjectStatuses(
    viewer.organization.projectStatuses.map((status) => ({
      id: status.id,
      workspaceId: viewer.organization.id,
      name: status.name,
      type: status.type,
      position: status.position,
      color: status.color,
    })),
    viewer.organization.id,
  );

  store.replacePriorityValues(
    result.issuePriorityValues.map((value) => ({
      priority: value.priority,
      label: value.label,
      workspaceId: viewer.organization.id,
    })),
    viewer.organization.id,
  );

  store.putTeams(
    result.teams.nodes.map((node) => toTeam(node, viewer.organization.id)),
    at,
  );
}

function toTeam(
  node: BootstrapResult["teams"]["nodes"][number],
  workspaceId: string,
): TeamInput {
  return {
    id: node.id,
    workspaceId,
    key: node.key,
    name: node.name,
    icon: node.icon,
    color: node.color,
    parentId: node.parent?.id ?? null,
    estimationType: node.issueEstimationType,
    estimationAllowZero: node.issueEstimationAllowZero,
    estimationExtended: node.issueEstimationExtended,
    defaultEstimate: node.defaultIssueEstimate,
    cyclesEnabled: node.cyclesEnabled,
    triageEnabled: node.triageEnabled,
    activeCycleId: node.activeCycle?.id ?? null,
    updatedAt: parseInstant(node.updatedAt),
  };
}

/**
 * States are **replaced** per team rather than upserted, because a state
 * deleted in Linear has no tombstone: an upsert would leave it in the picker
 * forever, and picking it would fail with an error about an id that no longer
 * exists. Members are also replaced per workspace: the active-users query has
 * no tombstone for someone who left, so upserting would retain them forever.
 */
export function applyTeamGraph(
  store: Store,
  result: TeamGraphResult,
  teamIds: readonly string[],
  at: number,
): void {
  const workspaceId =
    teamIds
      .map((teamId) => store.workspaceForTeam(teamId)?.id ?? null)
      .find((id): id is string => id !== null) ?? store.workspace()?.id;
  const byTeam = new Map<string, WorkflowStateRow[]>();
  for (const teamId of teamIds) byTeam.set(teamId, []);
  for (const node of result.workflowStates.nodes) {
    const list = byTeam.get(node.team.id);
    if (list === undefined) continue;
    list.push({
      id: node.id,
      teamId: node.team.id,
      name: node.name,
      type: node.type,
      color: node.color,
      position: node.position,
      description: node.description,
    });
  }
  for (const [teamId, states] of byTeam) {
    // A team that came back with no states at all is a team whose page was
    // truncated or whose request partially failed — replacing with an empty
    // list would erase a working state picker. Nothing is a safer answer than
    // wrong.
    if (states.length === 0) continue;
    store.replaceWorkflowStates(teamId, states);
  }

  const labels: LabelRow[] = result.issueLabels.nodes.map((node) => ({
    id: node.id,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    teamId: node.team?.id ?? null,
    name: node.name,
    color: node.color,
    parentId: node.parent?.id ?? null,
    isGroup: node.isGroup,
    updatedAt: parseInstant(node.updatedAt),
  }));
  store.putLabels(labels);

  const members: MemberRow[] = result.users.nodes.map((node) => ({
    id: node.id,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    name: node.name,
    displayName: node.displayName,
    email: node.email,
    avatarUrl: node.avatarUrl,
    active: node.active,
    isApp: node.app,
    isMe: node.isMe,
    updatedAt: at,
  }));
  if (workspaceId === undefined) store.putMembers(members);
  else store.replaceWorkspaceMembers(workspaceId, members);
}

export function toIssueInput(node: IssueNode): IssueInput {
  return {
    id: node.id,
    identifier: node.identifier,
    number: node.number,
    teamId: node.team.id,
    title: node.title,
    description: node.description,
    url: node.url,
    branchName: node.branchName,
    priority: node.priority,
    estimate: node.estimate,
    stateId: node.state.id,
    assigneeId: node.assignee?.id ?? null,
    creatorId: node.creator?.id ?? null,
    projectId: node.project?.id ?? null,
    milestoneId: node.projectMilestone?.id ?? null,
    cycleId: node.cycle?.id ?? null,
    parentId: node.parent?.id ?? null,
    // Stays a string. See the header comment.
    dueDate: node.dueDate,
    sortOrder: node.sortOrder,
    subIssueSortOrder: node.subIssueSortOrder,
    labelIds: node.labelIds,
    startedAt: parseInstant(node.startedAt),
    completedAt: parseInstant(node.completedAt),
    canceledAt: parseInstant(node.canceledAt),
    triagedAt: parseInstant(node.triagedAt),
    archivedAt: parseInstant(node.archivedAt),
    createdAt: parseInstant(node.createdAt),
    updatedAt: parseInstant(node.updatedAt) ?? 0,
  };
}

/**
 * Write a page of issues, and return the watermark this page justifies.
 *
 * The returned value is the **oldest** `updatedAt` in the page, not the
 * newest and not `Date.now()`. Checkpointing to the newest means a crash
 * mid-walk skips everything the walk had not reached; checkpointing to the
 * local clock means drifting against Linear's, which produces the same skip
 * with no crash required. The oldest re-reads a page instead of losing one,
 * and re-reading is free because every write is an upsert by id.
 */
export function applyIssues(
  store: Store,
  nodes: readonly IssueNode[],
  at: number,
): {
  readonly written: number;
  readonly oldestUpdatedAt: number | null;
  readonly newestUpdatedAt: number | null;
} {
  if (nodes.length === 0) {
    return { written: 0, oldestUpdatedAt: null, newestUpdatedAt: null };
  }

  const rows = nodes.map(toIssueInput);
  store.putIssues(rows, at);

  for (const node of nodes) {
    if (node.previousIdentifiers.length > 0) {
      // An issue moved between teams changes identifier, which is why this
      // field exists. Keeping the trail is what stops a link written last
      // month resolving to "no such issue".
      store.putPreviousIdentifiers(node.id, node.previousIdentifiers);
    }
  }

  let oldest: number | null = null;
  let newest: number | null = null;
  for (const row of rows) {
    if (oldest === null || row.updatedAt < oldest) oldest = row.updatedAt;
    if (newest === null || row.updatedAt > newest) newest = row.updatedAt;
  }
  return { written: rows.length, oldestUpdatedAt: oldest, newestUpdatedAt: newest };
}

/**
 * One issue, in full, from the detail query.
 *
 * Writes the issue, its comments and its children in one pass, because the
 * detail pane reads all three and a pane that renders the issue and then the
 * comments a beat later reads as slow even when it is not.
 */
export function applyIssueDetail(store: Store, node: IssueDetailNode, at: number): void {
  // A child that is **already in the mirror** is left alone. The detail query
  // returns four fields per child, and upserting that over a full row would
  // blank every other column until the poller happened to touch it again —
  // which is a worse row than the one it replaced, arriving as a side effect
  // of opening the parent.
  const existingChildren = new Set(
    store.issuesByIds(node.children.nodes.map((child) => child.id)).map((child) => child.id),
  );
  const stubs = node.children.nodes
    .filter((child) => !existingChildren.has(child.id))
    .map((child) => detailChildToNode(child, node));

  applyIssues(store, [node, ...stubs], at);

  const comments: CommentRow[] = node.comments.nodes.map((comment) => ({
    id: comment.id,
    issueId: comment.issue?.id ?? node.id,
    userId: comment.user?.id ?? null,
    parentId: comment.parent?.id ?? null,
    body: comment.body,
    url: comment.url,
    createdAt: parseInstant(comment.createdAt),
    updatedAt: parseInstant(comment.updatedAt) ?? at,
    editedAt: parseInstant(comment.editedAt),
    resolvedAt: parseInstant(comment.resolvedAt),
  }));
  store.putComments(comments);
}

/**
 * A child arrives with four fields, not the whole issue.
 *
 * Rather than write a partial row that a later full fetch would have to
 * repair, a child that is **already in the mirror** is left alone and one that
 * is not gets a minimal row: enough to render "3 of 7 done" and to be
 * clickable, and honest about being a stub because every other column is empty
 * until the poller reaches it.
 */
function detailChildToNode(
  child: IssueDetailNode["children"]["nodes"][number],
  parent: IssueDetailNode,
): IssueNode {
  return {
    id: child.id,
    identifier: child.identifier,
    number: 0,
    title: child.title,
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
    createdAt: parent.createdAt,
    // Zero, deliberately: the poller's watermark comparison then treats this
    // stub as older than anything real, so the next tick that touches the
    // child replaces it with the full row.
    updatedAt: new Date(0).toISOString(),
    team: parent.team,
    state: { id: child.state.id },
    assignee: null,
    creator: null,
    project: null,
    projectMilestone: null,
    cycle: null,
    parent: { id: parent.id },
  };
}

/**
 * Projects, their milestones, and the bound teams' cycles.
 *
 * `startDate` and `targetDate` stay `TimelessDate` strings for the same reason
 * `dueDate` does: they are calendar facts, and converting one to epoch picks a
 * timezone on the user's behalf.
 *
 * `isActive` / `isNext` / `isPrevious` come straight from Linear. Deriving
 * them from `startsAt` and `endsAt` against the local clock reimplements the
 * team's cycle configuration badly and disagrees across a timezone.
 */
export function applyBreadth(store: Store, result: BreadthResult, at: number): void {
  const projects: ProjectRow[] = [];
  const links: { projectId: string; teamId: string }[] = [];
  const milestones: MilestoneRow[] = [];

  for (const node of result.projects.nodes) {
    projects.push({
      id: node.id,
      name: node.name,
      description: node.description,
      url: node.url,
      statusId: node.status?.id ?? null,
      leadId: node.lead?.id ?? null,
      startDate: node.startDate,
      targetDate: node.targetDate,
      progress: node.progress,
      updatedAt: parseInstant(node.updatedAt) ?? at,
    });
    for (const team of node.teams.nodes) {
      links.push({ projectId: node.id, teamId: team.id });
    }
    for (const milestone of node.projectMilestones.nodes) {
      milestones.push({
        id: milestone.id,
        projectId: node.id,
        name: milestone.name,
        targetDate: milestone.targetDate,
        sortOrder: milestone.sortOrder,
        updatedAt: parseInstant(milestone.updatedAt) ?? at,
      });
    }
  }

  store.putProjects(projects, links);
  store.putMilestones(milestones);

  const cycles: CycleRow[] = result.cycles.nodes.map((node) => ({
    id: node.id,
    teamId: node.team.id,
    number: node.number,
    name: node.name,
    startsAt: parseInstant(node.startsAt),
    endsAt: parseInstant(node.endsAt),
    isActive: node.isActive,
    isNext: node.isNext,
    isPrevious: node.isPrevious,
    updatedAt: parseInstant(node.updatedAt) ?? at,
  }));
  store.putCycles(cycles);
}

/**
 * Both directions, flattened into one table.
 *
 * `relations` is what this issue declares; `inverseRelations` is what
 * something else declares about it — and "blocked by" lives in the inverse
 * direction, which is the half a naive implementation misses. Storing both as
 * `(issueId → relatedIssueId, type)` from the *declaring* side means one query
 * answers "what blocks me" and "what do I block".
 */
export function applyRelations(store: Store, result: IssueRelationsResult): void {
  const rows: RelationRow[] = [];

  for (const node of result.issue.relations.nodes) {
    if (node.relatedIssue === null) continue;
    rows.push({
      id: node.id,
      issueId: result.issue.id,
      relatedIssueId: node.relatedIssue.id,
      type: node.type,
    });
  }

  store.replaceRelations(result.issue.id, rows);

  // The inverse side is declared by the *other* issue, so it is written under
  // that issue's id — never replacing this issue's own set.
  for (const node of result.issue.inverseRelations.nodes) {
    if (node.issue === null) continue;
    store.replaceRelations(node.issue.id, [
      {
        id: node.id,
        issueId: node.issue.id,
        relatedIssueId: result.issue.id,
        type: node.type,
      },
    ]);
  }
}
