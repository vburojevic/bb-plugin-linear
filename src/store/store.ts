import type { Database } from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";
import type {
  BindingRole,
  BindingRow,
  BranchLinkRow,
  CommentRow,
  CycleRow,
  GitAutomationRow,
  InboxRowRecord,
  IssueRow,
  LabelRow,
  MemberRow,
  MilestoneRow,
  PriorityValueRow,
  ProjectRow,
  PrStateRow,
  RelationRow,
  ProjectStatusRow,
  TeamRow,
  ThreadLinkRow,
  WorkflowStateRow,
  WorkspaceRow,
} from "./rows.js";

/**
 * The mirror.
 *
 * better-sqlite3 is synchronous, which is why this file reads like a set of
 * queries rather than a data-access layer: there is no await to hide behind
 * and no cache to invalidate. The poller writes, everything else reads, and
 * the only asynchrony in the whole plugin is the network.
 *
 * Every query is parameterised. Where a query needs a variable *shape* — an
 * `IN (?, ?, ?)` whose arity depends on how many teams are bound — the
 * placeholders are generated and the values are still bound; nothing user- or
 * Linear-supplied is ever concatenated into SQL.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Column mapping                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

const bool = (value: unknown): boolean => value === 1 || value === true;
const toInt = (value: boolean): number => (value ? 1 : 0);

interface RawIssue {
  id: string;
  identifier: string;
  number: number;
  teamId: string;
  title: string;
  description: string | null;
  url: string | null;
  branchName: string | null;
  priority: number;
  estimate: number | null;
  stateId: string | null;
  assigneeId: string | null;
  creatorId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  cycleId: string | null;
  parentId: string | null;
  dueDate: string | null;
  sortOrder: number;
  subIssueSortOrder: number | null;
  labelIds: string;
  startedAt: number | null;
  completedAt: number | null;
  canceledAt: number | null;
  triagedAt: number | null;
  archivedAt: number | null;
  createdAt: number | null;
  updatedAt: number;
  syncedAt: number;
}

const WORKSPACE_COLUMNS = `
  SELECT id, slot, name, url_key AS urlKey, viewer_id AS viewerId,
         viewer_name AS viewerName, git_branch_format AS gitBranchFormat,
         fetched_at AS fetchedAt
    FROM workspace`;

const TEAM_COLUMNS = `
  id, workspace_id AS workspaceId, key, name, icon, color, parent_id AS parentId,
  estimation_type AS estimationType,
  estimation_allow_zero AS estimationAllowZero,
  estimation_extended AS estimationExtended,
  default_estimate AS defaultEstimate,
  cycles_enabled AS cyclesEnabled, triage_enabled AS triageEnabled,
  active_cycle_id AS activeCycleId, updated_at AS updatedAt,
  fetched_at AS fetchedAt`;

/**
 * Every column qualified with its table.
 *
 * Not style: `queryIssues` joins `workflow_state`, which has its own `id`,
 * `name`, `color`, `position` and `description`. An unqualified list produces
 * `ambiguous column name: id` — and it produces it only on the queries that
 * join, so the single-row lookups keep working and the failure looks like a
 * filter bug.
 */
/** How many full-text hits a single query may consider. Five hundred is far
 *  past what any panel renders and far below what freezes an event loop. */
const FTS_MATCH_LIMIT = 500;

const ISSUE_COLUMNS = `
  issue.id AS id, issue.identifier AS identifier, issue.number AS number,
  issue.team_id AS teamId, issue.title AS title, issue.description AS description,
  issue.url AS url, issue.branch_name AS branchName, issue.priority AS priority,
  issue.estimate AS estimate, issue.state_id AS stateId,
  issue.assignee_id AS assigneeId, issue.creator_id AS creatorId,
  issue.project_id AS projectId, issue.milestone_id AS milestoneId,
  issue.cycle_id AS cycleId, issue.parent_id AS parentId,
  issue.due_date AS dueDate, issue.sort_order AS sortOrder,
  issue.sub_issue_sort_order AS subIssueSortOrder, issue.label_ids AS labelIds,
  issue.started_at AS startedAt, issue.completed_at AS completedAt,
  issue.canceled_at AS canceledAt, issue.triaged_at AS triagedAt,
  issue.archived_at AS archivedAt, issue.created_at AS createdAt,
  issue.updated_at AS updatedAt, issue.synced_at AS syncedAt`;

function toIssue(raw: RawIssue): IssueRow {
  let labelIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw.labelIds);
    if (Array.isArray(parsed)) labelIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // A malformed blob written by a future release is a row with no labels,
    // not a crash in the middle of rendering a list.
  }
  return { ...raw, labelIds };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Inputs                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export type TeamInput = Omit<TeamRow, "fetchedAt">;
export type IssueInput = Omit<IssueRow, "syncedAt">;

export type IssueSort = "updated" | "priority" | "due" | "manual" | "created";
export type IssueGrouping = "state" | "project" | "cycle" | "assignee" | "none";

export interface IssueFilter {
  readonly teamIds: readonly string[];
  readonly stateIds?: readonly string[];
  readonly stateTypes?: readonly string[];
  readonly assigneeIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly cycleIds?: readonly string[];
  readonly labelIds?: readonly string[];
  readonly priorities?: readonly number[];
  /** Free text, run through FTS5 over the mirror. Never leaves the machine. */
  readonly text?: string;
  /** Default false: an archived issue is not part of anyone's working list,
   *  and it is only kept at all so the mirror can tell archival from deletion. */
  readonly includeArchived?: boolean;
  /** Default false. The panel's baseline is open work. */
  readonly includeCompleted?: boolean;
}

export interface IssueQuery extends IssueFilter {
  readonly sort: IssueSort;
  readonly limit: number;
  readonly offset?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface Store {
  readonly db: Database;

  putWorkspace(row: Omit<WorkspaceRow, "fetchedAt">, at: number): void;
  /** The primary slot's workspace, or the first one recorded. Every surface
   *  that shows a single workspace name shows this one. */
  workspace(): WorkspaceRow | null;
  /** Every connected workspace, in slot order. */
  workspaces(): WorkspaceRow[];
  workspaceForTeam(teamId: string): WorkspaceRow | null;
  /** Drop a workspace and the teams that came from it, for when its key is
   *  removed from settings. Issues are left to the ordinary reconcile so a key
   *  pasted back a minute later does not cost a full re-read. */
  /** Forget a workspace's content. Returns the team ids that went with it, so
   *  the caller can clear their kv backfill markers. Bindings and thread
   *  links deliberately survive — see the implementation. */
  forgetWorkspace(workspaceId: string): string[];

  putTeams(teams: readonly TeamInput[], at: number): void;
  teams(): TeamRow[];
  team(id: string): TeamRow | null;
  teamByKey(key: string): TeamRow | null;
  /** Every key match — two workspaces can both have an ENG. */
  teamsByKey(key: string): TeamRow[];
  /** Walk the cached parent graph. Used by `includeSubTeams`, which exists
   *  only as an argument on `Team.issues` and *not* on the root `issues`
   *  query — so it is honoured by widening the team-id list at tick-build
   *  time rather than by a different query shape. */
  descendantTeamIds(rootIds: readonly string[]): string[];

  replaceWorkflowStates(teamId: string, states: readonly WorkflowStateRow[]): void;
  workflowStates(teamId: string): WorkflowStateRow[];
  workflowState(id: string): WorkflowStateRow | null;

  putLabels(labels: readonly LabelRow[]): void;
  /** Team labels plus workspace-level ones, which is what every picker needs
   *  and what `IssueLabel.team == null` means. */
  labels(teamIds: readonly string[]): LabelRow[];

  putMembers(members: readonly MemberRow[]): void;
  /** Replace one workspace's active-user snapshot. Linear's active-users
   *  query has no tombstones, so an upsert cannot express a departure. */
  replaceWorkspaceMembers(workspaceId: string, members: readonly MemberRow[]): void;
  /** Replaced wholesale, because a removal cannot be expressed as an upsert. */
  replaceTeamMembers(teamId: string, userIds: readonly string[]): void;
  /** Empty when membership has never been read for this team — the caller
   *  falls back to the workspace list rather than offering nobody. */
  teamMemberIds(teamId: string): string[];
  /** Omit team ids for the global UI; pass them on every project-scoped surface. */
  members(teamIds?: readonly string[]): MemberRow[];
  membersByIds(ids: readonly string[]): MemberRow[];
  /** Team membership where known; workspace membership only for teams whose
   * membership graph has not been fetched yet. */
  assignableMembers(teamIds: readonly string[]): MemberRow[];
  viewers(teamIds?: readonly string[]): MemberRow[];
  viewer(teamIds?: readonly string[]): MemberRow | null;

  replaceProjectStatuses(statuses: readonly ProjectStatusRow[], workspaceId?: string): void;
  projectStatuses(teamIds?: readonly string[]): ProjectStatusRow[];

  replacePriorityValues(values: readonly PriorityValueRow[], workspaceId?: string): void;
  priorityValues(teamIds?: readonly string[]): PriorityValueRow[];

  putIssues(issues: readonly IssueInput[], at: number): void;
  issue(id: string): IssueRow | null;
  /** Batch lookup for hot projections. One inbox page must not become one
   * SQLite statement per notification. */
  issuesByIds(ids: readonly string[]): IssueRow[];
  issueByIdentifier(identifier: string): IssueRow | null;
  /** Every identifier match — for writers that must refuse a cross-workspace
   *  collision rather than pick an arbitrary winner. */
  issuesByIdentifier(identifier: string): IssueRow[];
  issuesByBranch(branchName: string): IssueRow[];
  queryIssues(query: IssueQuery): IssueRow[];
  countIssues(filter: IssueFilter): number;
  deleteIssues(ids: readonly string[]): void;
  childIssues(parentId: string, limit: number): IssueRow[];
  putPreviousIdentifiers(issueId: string, identifiers: readonly string[]): void;
  /** Sub-issue progress for a page of rows, in one query rather than one per
   *  row: a forty-row page would otherwise be forty round trips through
   *  SQLite for a fraction almost nobody reads. */
  subIssueProgress(parentIds: readonly string[]): Map<string, { done: number; total: number }>;

  putComments(comments: readonly CommentRow[]): void;
  comments(issueId: string): CommentRow[];

  /**
   * Echo suppression, and it happens **before** the tick rather than after.
   *
   * Every local mutation returns the updated entity; its `(id, updatedAt)` is
   * recorded here immediately, so the next tick sees its own write and stays
   * silent. Doing it afterwards — comparing what arrived against what was just
   * sent — loses the race with a tick that is already in flight, and the user
   * gets notified about the change they just made.
   */
  recordEcho(entityId: string, updatedAt: number, at: number): void;
  isEcho(entityId: string, updatedAt: number): boolean;
  pruneEchoes(olderThan: number): number;

  /** Upserts, but never clobbers `seen_at` / `dismissed_at`: a row the user
   *  has already acted on must not come back unread because the poller saw it
   *  again. */
  putInbox(rows: readonly InboxRowRecord[]): void;
  inbox(options?: { includeDismissed?: boolean; limit?: number }): InboxRowRecord[];
  markInboxSeen(keys: readonly string[], at: number): void;
  dismissInbox(keys: readonly string[], at: number): void;
  unseenInboxCount(): number;
  pruneInbox(olderThan: number, limit: number): number;

  /** `INSERT OR IGNORE`; true only if this call won the row. Claim then send
   *  is at most once, which is the better failure than at least once. */
  claimDelivery(key: string, kind: string, at: number): boolean;
  markDelivered(key: string, at: number): void;
  pruneDeliveries(olderThan: number): number;

  putProjects(rows: readonly ProjectRow[], teamLinks: readonly { projectId: string; teamId: string }[]): void;
  projects(teamIds: readonly string[]): ProjectRow[];
  project(id: string): ProjectRow | null;

  putMilestones(rows: readonly MilestoneRow[]): void;
  milestone(id: string): MilestoneRow | null;

  putCycles(rows: readonly CycleRow[]): void;
  cycles(teamId: string): CycleRow[];
  cycle(id: string): CycleRow | null;

  replaceRelations(issueId: string, rows: readonly RelationRow[]): void;
  /** Identifiers of the open issues blocking each of these, in one query. The
   *  panel's second line and the Inbox both need it per page. */
  blockersFor(issueIds: readonly string[]): Map<string, string[]>;

  replaceGitAutomation(teamId: string, rows: readonly GitAutomationRow[]): void;
  gitAutomation(teamId: string): GitAutomationRow[];

  putBranchLink(row: BranchLinkRow): void;
  branchLink(environmentId: string): BranchLinkRow | null;

  putPrState(row: PrStateRow): void;
  prState(environmentId: string): PrStateRow | null;
  prStatesByIssue(issueIds: readonly string[]): PrStateRow[];

  /** Server-local secrets. Deliberately not settings: a declared descriptor
   *  is always user-editable, so a plugin-generated secret rendered as a form
   *  field is a field somebody can overwrite and silently break delivery
   *  with. */
  putLocalSecret(key: string, value: string): void;
  localSecret(key: string): string | null;

  /** One-shot host capability probe. Absent means "never asked". */
  putProbe(key: string, outcome: string, at: number): void;
  probe(key: string): { outcome: string; at: number } | null;

  linkThread(row: ThreadLinkRow): void;
  unlinkThread(threadId: string): void;
  threadLink(threadId: string): ThreadLinkRow | null;
  threadLinksByThreadIds(threadIds: readonly string[]): ThreadLinkRow[];
  threadLinksForIssues(issueIds: readonly string[]): ThreadLinkRow[];

  bindings(): BindingRow[];
  bindingsForProject(projectId: string): BindingRow[];
  boundTeamIds(): string[];
  setBinding(projectId: string, teamId: string, role: BindingRole, at: number): void;
  removeBinding(projectId: string, teamId: string): void;
  removeProjectBindings(projectId: string): void;

  /** Disconnect means it: every mirror table emptied. `bb plugin remove` does
   *  **not** do this — the host deletes settings rows and the secrets
   *  directory and leaves `data.db` in place — so this is the only thing that
   *  removes a workspace's issue data from the machine. */
  forgetEverything(): void;
}

export function createStore(db: Database): Store {
  const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");
  const LEGACY_WORKSPACE_ID = "__legacy__";

  const primaryWorkspaceId = (): string | null =>
    (
      db
        .prepare(`SELECT id FROM workspace ORDER BY slot = 'apiKey' DESC, slot LIMIT 1`)
        .get() as { id: string } | undefined
    )?.id ?? null;

  const workspaceIdForTeam = (teamId: string): string =>
    (
      db.prepare(`SELECT workspace_id AS workspaceId FROM team WHERE id = ?`).get(teamId) as
        | { workspaceId: string | null }
        | undefined
    )?.workspaceId ?? primaryWorkspaceId() ?? LEGACY_WORKSPACE_ID;

  /** Empty/omitted means every workspace for global UI surfaces. */
  const workspaceIdsForTeams = (teamIds?: readonly string[]): string[] => {
    if (teamIds === undefined || teamIds.length === 0) {
      const ids = (
        db
          .prepare(`SELECT id FROM workspace ORDER BY slot = 'apiKey' DESC, slot`)
          .all() as { id: string }[]
      ).map((row) => row.id);
      return [...new Set([...ids, LEGACY_WORKSPACE_ID])];
    }
    return [...new Set(teamIds.map(workspaceIdForTeam))];
  };

  const inputWorkspaceId = (explicit: string | undefined, teamId?: string | null): string =>
    explicit ??
    (teamId === undefined || teamId === null ? null : workspaceIdForTeam(teamId)) ??
    primaryWorkspaceId() ??
    LEGACY_WORKSPACE_ID;

  const putIssueStatement = db.prepare(`
    INSERT INTO issue (
      id, identifier, number, team_id, title, description, url, branch_name,
      priority, estimate, state_id, assignee_id, creator_id, project_id,
      milestone_id, cycle_id, parent_id, due_date, sort_order,
      sub_issue_sort_order, label_ids, started_at, completed_at, canceled_at,
      triaged_at, archived_at, created_at, updated_at, synced_at
    ) VALUES (
      @id, @identifier, @number, @teamId, @title, @description, @url, @branchName,
      @priority, @estimate, @stateId, @assigneeId, @creatorId, @projectId,
      @milestoneId, @cycleId, @parentId, @dueDate, @sortOrder,
      @subIssueSortOrder, @labelIds, @startedAt, @completedAt, @canceledAt,
      @triagedAt, @archivedAt, @createdAt, @updatedAt, @syncedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      identifier = excluded.identifier, number = excluded.number,
      team_id = excluded.team_id, title = excluded.title,
      description = excluded.description, url = excluded.url,
      branch_name = excluded.branch_name, priority = excluded.priority,
      estimate = excluded.estimate, state_id = excluded.state_id,
      assignee_id = excluded.assignee_id, creator_id = excluded.creator_id,
      project_id = excluded.project_id, milestone_id = excluded.milestone_id,
      cycle_id = excluded.cycle_id, parent_id = excluded.parent_id,
      due_date = excluded.due_date, sort_order = excluded.sort_order,
      sub_issue_sort_order = excluded.sub_issue_sort_order,
      label_ids = excluded.label_ids, started_at = excluded.started_at,
      completed_at = excluded.completed_at, canceled_at = excluded.canceled_at,
      triaged_at = excluded.triaged_at, archived_at = excluded.archived_at,
      created_at = excluded.created_at, updated_at = excluded.updated_at,
      synced_at = excluded.synced_at`);

  // `ON CONFLICT DO UPDATE` rather than `INSERT OR REPLACE`, so the row keeps
  // its rowid. The FTS5 index is keyed on rowid, and a replace would leave the
  // old entry orphaned behind a rowid nothing points at any more.
  const putIssuesTx = db.transaction((issues: readonly IssueInput[], at: number) => {
    for (const issue of issues) {
      putIssueStatement.run({
        ...issue,
        labelIds: JSON.stringify(issue.labelIds),
        syncedAt: at,
      });
    }
  });

  function buildIssueWhere(filter: IssueFilter): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    // Layer 2 of the team-scoping defence, and the reason it is not optional:
    // this clause is what makes it impossible for a query to return an
    // unbound team's issues even if a caller forgets to check. An empty team
    // list matches nothing, which is the correct answer for an unbound
    // project — not "everything".
    clauses.push(`issue.team_id IN (${placeholders(filter.teamIds.length)})`);
    params.push(...filter.teamIds);

    if (!filter.includeArchived) clauses.push("issue.archived_at IS NULL");

    if (!filter.includeCompleted) {
      clauses.push(`(state.type IS NULL OR state.type NOT IN ('completed', 'canceled'))`);
    }

    const inClause = (column: string, values: readonly string[] | undefined) => {
      if (values === undefined || values.length === 0) return;
      clauses.push(`${column} IN (${placeholders(values.length)})`);
      params.push(...values);
    };

    inClause("issue.state_id", filter.stateIds);
    inClause("state.type", filter.stateTypes);
    inClause("issue.assignee_id", filter.assigneeIds);
    inClause("issue.project_id", filter.projectIds);
    inClause("issue.cycle_id", filter.cycleIds);

    if (filter.priorities !== undefined && filter.priorities.length > 0) {
      clauses.push(`issue.priority IN (${placeholders(filter.priorities.length)})`);
      params.push(...filter.priorities);
    }

    if (filter.labelIds !== undefined && filter.labelIds.length > 0) {
      // `label_ids` is a JSON array on the row rather than a join table,
      // matching Linear's own flattened `Issue.labelIds`. `json_each` makes
      // that filterable without a second table to keep in step.
      clauses.push(`EXISTS (
        SELECT 1 FROM json_each(issue.label_ids)
        WHERE json_each.value IN (${placeholders(filter.labelIds.length)})
      )`);
      params.push(...filter.labelIds);
    }

    const text = filter.text?.trim() ?? "";
    if (text !== "") {
      // Bounded, and ranked before it is bounded. better-sqlite3 is
      // synchronous, so this subquery runs on the bb server's event loop —
      // and it is on the keystroke path (the panel search box and the `#`
      // mention menu both re-query per character). Every token is a prefix
      // match, so a one-character query matches a large fraction of a big
      // mirror; materialising that whole set before the outer LIMIT is how a
      // search box freezes an IDE. `bm25` puts the best matches inside the
      // cap, so the bound costs relevance only past 500 hits.
      clauses.push(
        `issue.rowid IN (
           SELECT rowid FROM issue_fts WHERE issue_fts MATCH ?
           ORDER BY bm25(issue_fts) LIMIT ${FTS_MATCH_LIMIT}
         )`,
      );
      params.push(toMatchQuery(text));
    }

    return { sql: clauses.join("\n      AND "), params };
  }

  const ORDER_BY: Record<IssueSort, string> = {
    updated: "issue.updated_at DESC",
    // Linear orders priority 1..4 and puts None (0) last, which is the order
    // people actually mean by "sort by priority" — 0 first would put every
    // unprioritised issue above the urgent ones.
    priority:
      "CASE WHEN issue.priority = 0 THEN 5 ELSE issue.priority END ASC, issue.updated_at DESC",
    // Nulls last: an issue with no due date is not more urgent than one due
    // next year.
    due: "issue.due_date IS NULL ASC, issue.due_date ASC, issue.updated_at DESC",
    manual: "issue.sort_order ASC, issue.updated_at DESC",
    created: "issue.created_at DESC",
  };

  return {
    db,

    /* ── Identity ────────────────────────────────────────────────────────── */

    putWorkspace(row, at) {
      const first =
        (db.prepare(`SELECT COUNT(*) AS count FROM workspace`).get() as { count: number }).count === 0;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO workspace (id, slot, name, url_key, viewer_id, viewer_name, git_branch_format, fetched_at)
           VALUES (@id, @slot, @name, @urlKey, @viewerId, @viewerName, @gitBranchFormat, @fetchedAt)
           ON CONFLICT(id) DO UPDATE SET
             slot = excluded.slot,
             name = excluded.name, url_key = excluded.url_key,
             viewer_id = excluded.viewer_id, viewer_name = excluded.viewer_name,
             git_branch_format = excluded.git_branch_format,
             fetched_at = excluded.fetched_at`,
        ).run({ ...row, fetchedAt: at });
        if (first) {
          for (const table of ["workspace_label", "workspace_member", "workspace_project_status", "workspace_priority_value"]) {
            db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`).run(
              row.id,
              LEGACY_WORKSPACE_ID,
            );
          }
        }
      })();
    },

    workspace() {
      // Primary first, then whatever else is there. A surface that shows one
      // workspace name shows the one the user configured first.
      const row = db
        .prepare(`${WORKSPACE_COLUMNS} ORDER BY slot = 'apiKey' DESC, slot LIMIT 1`)
        .get() as WorkspaceRow | undefined;
      return row ?? null;
    },

    workspaces() {
      return db
        .prepare(`${WORKSPACE_COLUMNS} ORDER BY slot = 'apiKey' DESC, slot`)
        .all() as WorkspaceRow[];
    },

    workspaceForTeam(teamId) {
      const row = db
        .prepare(
          `SELECT w.id, w.slot, w.name, w.url_key AS urlKey, w.viewer_id AS viewerId,
                  w.viewer_name AS viewerName, w.git_branch_format AS gitBranchFormat,
                  w.fetched_at AS fetchedAt
             FROM team JOIN workspace w ON w.id = team.workspace_id
            WHERE team.id = ?`,
        )
        .get(teamId) as WorkspaceRow | undefined;
      return row ?? null;
    },

    forgetWorkspace(workspaceId) {
      return db.transaction(() => {
        // The workspace's CONTENT goes with it — issues, comments, its teams'
        // vocabulary — because a mirror that keeps serving a departed
        // workspace's issues is both stale and a data-retention problem.
        //
        // What deliberately SURVIVES: `binding` and `thread_link`. Those are
        // the user's own statements of intent, not Linear's data, and this
        // function runs from a *detached discovery pass* whose only evidence
        // is one settings read — a transient empty read would otherwise
        // silently destroy bindings with no confirmation and no undo. The
        // orphan-polling problem they used to cause is solved at the source
        // instead: `boundTeamIds()` only returns teams that still exist.
        //
        // Returns the forgotten team ids so the caller can clear their kv
        // backfill markers — without that, re-adding the key leaves the
        // teams marked "already backfilled" and the board comes back empty.
        //
        // `workspace_id IS NULL` teams belong to the primary workspace by
        // construction (the pre-M13 upgrade state), so forgetting the primary
        // slot's workspace must sweep them too or clearing the first key
        // leaves the entire mirror behind.
        const primary =
          (db.prepare(`SELECT slot FROM workspace WHERE id = ?`).get(workspaceId) as
            | { slot: string }
            | undefined)?.slot === "apiKey";
        const teamIds = (
          db
            .prepare(
              primary
                ? `SELECT id FROM team WHERE workspace_id = ? OR workspace_id IS NULL`
                : `SELECT id FROM team WHERE workspace_id = ?`,
            )
            .all(workspaceId) as { id: string }[]
        ).map((row) => row.id);
        if (teamIds.length > 0) {
          const marks = placeholders(teamIds.length);
          db.prepare(
            `DELETE FROM comment WHERE issue_id IN (SELECT id FROM issue WHERE team_id IN (${marks}))`,
          ).run(...teamIds);
          db.prepare(
            `DELETE FROM relation WHERE issue_id IN (SELECT id FROM issue WHERE team_id IN (${marks}))`,
          ).run(...teamIds);
          db.prepare(
            `DELETE FROM issue_previous_identifier
              WHERE issue_id IN (SELECT id FROM issue WHERE team_id IN (${marks}))`,
          ).run(...teamIds);
          db.prepare(
            `DELETE FROM echo WHERE entity_id IN (SELECT id FROM issue WHERE team_id IN (${marks}))`,
          ).run(...teamIds);
          db.prepare(`DELETE FROM issue WHERE team_id IN (${marks})`).run(...teamIds);
          db.prepare(`DELETE FROM workflow_state WHERE team_id IN (${marks})`).run(...teamIds);
          db.prepare(`DELETE FROM label WHERE team_id IN (${marks})`).run(...teamIds);
          db.prepare(`DELETE FROM cycle WHERE team_id IN (${marks})`).run(...teamIds);
          db.prepare(`DELETE FROM team_member WHERE team_id IN (${marks})`).run(...teamIds);
          db.prepare(`DELETE FROM git_automation_state WHERE team_id IN (${marks})`).run(
            ...teamIds,
          );
          db.prepare(`DELETE FROM project_team WHERE team_id IN (${marks})`).run(...teamIds);
        }
        db.prepare(`DELETE FROM inbox WHERE workspace_id = ?`).run(workspaceId);
        // Projects have many team links but no workspace column. Once every
        // link owned by this workspace is gone, an unlinked project and all of
        // its milestones are remote metadata with no remaining owner.
        db.prepare(`DELETE FROM milestone WHERE project_id IN (
          SELECT project.id FROM project WHERE NOT EXISTS (
            SELECT 1 FROM project_team WHERE project_team.project_id = project.id
          )
        )`).run();
        db.prepare(`DELETE FROM project WHERE NOT EXISTS (
          SELECT 1 FROM project_team WHERE project_team.project_id = project.id
        )`).run();
        if (teamIds.length > 0) {
          db.prepare(`DELETE FROM team WHERE id IN (${placeholders(teamIds.length)})`).run(
            ...teamIds,
          );
        }
        db.prepare(`DELETE FROM workspace_label WHERE workspace_id = ?`).run(workspaceId);
        db.prepare(`DELETE FROM workspace_member WHERE workspace_id = ?`).run(workspaceId);
        db.prepare(`DELETE FROM workspace_project_status WHERE workspace_id = ?`).run(workspaceId);
        db.prepare(`DELETE FROM workspace_priority_value WHERE workspace_id = ?`).run(workspaceId);
        db.prepare(`DELETE FROM label WHERE NOT EXISTS (
          SELECT 1 FROM workspace_label WHERE workspace_label.label_id = label.id
        )`).run();
        db.prepare(`DELETE FROM member WHERE NOT EXISTS (
          SELECT 1 FROM workspace_member WHERE workspace_member.user_id = member.id
        )`).run();
        db.prepare(`DELETE FROM project_status WHERE NOT EXISTS (
          SELECT 1 FROM workspace_project_status WHERE workspace_project_status.status_id = project_status.id
        )`).run();
        // The legacy table has no owner column. New code never reads it, and
        // retaining it after any workspace disconnect would keep data whose
        // workspace can no longer be proven.
        db.prepare(`DELETE FROM priority_value`).run();
        db.prepare(`DELETE FROM workspace WHERE id = ?`).run(workspaceId);
        return teamIds;
      })();
    },

    /* ── Teams ───────────────────────────────────────────────────────────── */

    putTeams(teams, at) {
      const statement = db.prepare(
        `INSERT INTO team (id, workspace_id, key, name, icon, color, parent_id, estimation_type,
                           estimation_allow_zero, estimation_extended, default_estimate,
                           cycles_enabled, triage_enabled, active_cycle_id, updated_at, fetched_at)
         VALUES (@id, @workspaceId, @key, @name, @icon, @color, @parentId, @estimationType,
                 @estimationAllowZero, @estimationExtended, @defaultEstimate,
                 @cyclesEnabled, @triageEnabled, @activeCycleId, @updatedAt, @fetchedAt)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = COALESCE(excluded.workspace_id, team.workspace_id),
           key = excluded.key, name = excluded.name, icon = excluded.icon,
           color = excluded.color, parent_id = excluded.parent_id,
           estimation_type = excluded.estimation_type,
           estimation_allow_zero = excluded.estimation_allow_zero,
           estimation_extended = excluded.estimation_extended,
           default_estimate = excluded.default_estimate,
           cycles_enabled = excluded.cycles_enabled,
           triage_enabled = excluded.triage_enabled,
           active_cycle_id = excluded.active_cycle_id,
           updated_at = excluded.updated_at, fetched_at = excluded.fetched_at`,
      );
      db.transaction(() => {
        for (const team of teams) {
          statement.run({
            ...team,
            estimationAllowZero: toInt(team.estimationAllowZero),
            estimationExtended: toInt(team.estimationExtended),
            cyclesEnabled: toInt(team.cyclesEnabled),
            triageEnabled: toInt(team.triageEnabled),
            fetchedAt: at,
          });
        }
      })();
    },

    teams() {
      return (
        db.prepare(`SELECT ${TEAM_COLUMNS} FROM team ORDER BY key`).all() as RawTeam[]
      ).map(hydrateTeam);
    },

    team(id) {
      const row = db.prepare(`SELECT ${TEAM_COLUMNS} FROM team WHERE id = ?`).get(id) as
        | RawTeam
        | undefined;
      return row === undefined ? null : hydrateTeam(row);
    },

    teamByKey(key) {
      const row = db
        .prepare(`SELECT ${TEAM_COLUMNS} FROM team WHERE key = ? COLLATE NOCASE`)
        .get(key) as RawTeam | undefined;
      return row === undefined ? null : hydrateTeam(row);
    },

    teamsByKey(key) {
      // Every match, for the callers that must DETECT a cross-workspace key
      // collision rather than inherit whichever row the index returns first.
      // Two workspaces can both have an ENG; "arbitrary winner" is how a
      // binding lands on the wrong company's board.
      const rows = db
        .prepare(`SELECT ${TEAM_COLUMNS} FROM team WHERE key = ? COLLATE NOCASE`)
        .all(key) as RawTeam[];
      return rows.map(hydrateTeam);
    },

    descendantTeamIds(rootIds) {
      if (rootIds.length === 0) return [];
      const parents = db.prepare(`SELECT id, parent_id AS parentId FROM team`).all() as {
        id: string;
        parentId: string | null;
      }[];
      const children = new Map<string, string[]>();
      for (const row of parents) {
        if (row.parentId === null) continue;
        const list = children.get(row.parentId) ?? [];
        list.push(row.id);
        children.set(row.parentId, list);
      }
      const seen = new Set<string>(rootIds);
      const queue = [...rootIds];
      while (queue.length > 0) {
        const next = queue.shift()!;
        for (const child of children.get(next) ?? []) {
          // A cycle in a team graph should be impossible; a walk that trusts
          // that is a walk that hangs the sync service if it is not.
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      return [...seen];
    },

    /* ── Workflow states ─────────────────────────────────────────────────── */

    replaceWorkflowStates(teamId, states) {
      db.transaction(() => {
        db.prepare(`DELETE FROM workflow_state WHERE team_id = ?`).run(teamId);
        const statement = db.prepare(
          `INSERT INTO workflow_state (id, team_id, name, type, color, position, description)
           VALUES (@id, @teamId, @name, @type, @color, @position, @description)`,
        );
        for (const state of states) statement.run(state);
      })();
    },

    workflowStates(teamId) {
      return db
        .prepare(
          `SELECT id, team_id AS teamId, name, type, color, position, description
             FROM workflow_state WHERE team_id = ? ORDER BY position`,
        )
        .all(teamId) as WorkflowStateRow[];
    },

    workflowState(id) {
      const row = db
        .prepare(
          `SELECT id, team_id AS teamId, name, type, color, position, description
             FROM workflow_state WHERE id = ?`,
        )
        .get(id) as WorkflowStateRow | undefined;
      return row ?? null;
    },

    /* ── Labels, members, statuses, priorities ───────────────────────────── */

    putLabels(labels) {
      const statement = db.prepare(
        `INSERT INTO label (id, team_id, name, color, parent_id, is_group, updated_at)
         VALUES (@id, @teamId, @name, @color, @parentId, @isGroup, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           team_id = excluded.team_id, name = excluded.name, color = excluded.color,
           parent_id = excluded.parent_id, is_group = excluded.is_group,
           updated_at = excluded.updated_at`,
      );
      const ownership = db.prepare(
        `INSERT OR IGNORE INTO workspace_label (workspace_id, label_id) VALUES (?, ?)`,
      );
      const removeStale = db.prepare(
        `DELETE FROM workspace_label WHERE label_id = ? AND workspace_id != ?`,
      );
      db.transaction(() => {
        for (const label of labels) {
          const workspaceId = inputWorkspaceId(label.workspaceId, label.teamId);
          const { workspaceId: _workspaceId, ...row } = label;
          statement.run({ ...row, isGroup: toInt(label.isGroup) });
          removeStale.run(label.id, workspaceId);
          ownership.run(workspaceId, label.id);
        }
      })();
    },

    labels(teamIds) {
      // Workspace-level labels (`team_id IS NULL`) always come along: they are
      // usable on every team, and a picker that omitted them would be missing
      // the labels an organisation standardised on.
      const workspaceIds = workspaceIdsForTeams(teamIds);
      const rows = db
        .prepare(
          `SELECT DISTINCT label.id, label.team_id AS teamId, label.name, label.color,
                  label.parent_id AS parentId, label.is_group AS isGroup,
                  label.updated_at AS updatedAt
             FROM label JOIN workspace_label ON workspace_label.label_id = label.id
            WHERE ${
              teamIds.length > 0
                ? `(label.team_id IN (${placeholders(teamIds.length)}) OR
                    (label.team_id IS NULL AND workspace_label.workspace_id IN (${placeholders(workspaceIds.length)})))`
                : `label.team_id IS NULL AND workspace_label.workspace_id IN (${placeholders(workspaceIds.length)})`
            }
            ORDER BY label.name`,
        )
        .all(...teamIds, ...workspaceIds) as RawLabel[];
      return rows.map((row) => ({ ...row, isGroup: bool(row.isGroup) }));
    },

    replaceTeamMembers(teamId, userIds) {
      db.transaction(() => {
        db.prepare(`DELETE FROM team_member WHERE team_id = ?`).run(teamId);
        const statement = db.prepare(
          `INSERT OR IGNORE INTO team_member (team_id, user_id) VALUES (?, ?)`,
        );
        for (const userId of userIds) statement.run(teamId, userId);
      })();
    },

    teamMemberIds(teamId) {
      return (
        db.prepare(`SELECT user_id AS userId FROM team_member WHERE team_id = ?`).all(teamId) as {
          userId: string;
        }[]
      ).map((row) => row.userId);
    },

    putMembers(members) {
      const statement = db.prepare(
        `INSERT INTO member (id, name, display_name, email, avatar_url, active, is_app, is_me, updated_at)
         VALUES (@id, @name, @displayName, @email, @avatarUrl, @active, @isApp, @isMe, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, display_name = excluded.display_name,
           email = excluded.email, avatar_url = excluded.avatar_url,
           active = excluded.active, is_app = excluded.is_app,
           is_me = excluded.is_me, updated_at = excluded.updated_at`,
      );
      const ownership = db.prepare(
        `INSERT OR IGNORE INTO workspace_member (workspace_id, user_id) VALUES (?, ?)`,
      );
      db.transaction(() => {
        for (const member of members) {
          const workspaceId = inputWorkspaceId(member.workspaceId);
          const { workspaceId: _workspaceId, ...row } = member;
          statement.run({
            ...row,
            active: toInt(member.active),
            isApp: toInt(member.isApp),
            isMe: toInt(member.isMe),
          });
          ownership.run(workspaceId, member.id);
        }
      })();
    },

    replaceWorkspaceMembers(workspaceId, members) {
      const statement = db.prepare(
        `INSERT INTO member (id, name, display_name, email, avatar_url, active, is_app, is_me, updated_at)
         VALUES (@id, @name, @displayName, @email, @avatarUrl, @active, @isApp, @isMe, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, display_name = excluded.display_name,
           email = excluded.email, avatar_url = excluded.avatar_url,
           active = excluded.active, is_app = excluded.is_app,
           is_me = excluded.is_me, updated_at = excluded.updated_at`,
      );
      const ownership = db.prepare(
        `INSERT OR IGNORE INTO workspace_member (workspace_id, user_id) VALUES (?, ?)`,
      );
      db.transaction(() => {
        db.prepare(`DELETE FROM workspace_member WHERE workspace_id = ?`).run(workspaceId);
        for (const member of members) {
          const { workspaceId: _workspaceId, ...row } = member;
          statement.run({
            ...row,
            active: toInt(member.active),
            isApp: toInt(member.isApp),
            isMe: toInt(member.isMe),
          });
          ownership.run(workspaceId, member.id);
        }
        db.prepare(`DELETE FROM member WHERE NOT EXISTS (
          SELECT 1 FROM workspace_member WHERE workspace_member.user_id = member.id
        )`).run();
      })();
    },

    members(teamIds) {
      const workspaceIds = workspaceIdsForTeams(teamIds);
      const rows = db
        .prepare(
          `SELECT DISTINCT member.id, member.name, member.display_name AS displayName,
                  member.email, member.avatar_url AS avatarUrl, member.active,
                  member.is_app AS isApp, member.is_me AS isMe,
                  member.updated_at AS updatedAt
             FROM member JOIN workspace_member ON workspace_member.user_id = member.id
            WHERE workspace_member.workspace_id IN (${placeholders(workspaceIds.length)})
            ORDER BY member.display_name`,
        )
        .all(...workspaceIds) as RawMember[];
      return rows.map(hydrateMember);
    },

    membersByIds(ids) {
      if (ids.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT id, name, display_name AS displayName, email, avatar_url AS avatarUrl,
                  active, is_app AS isApp, is_me AS isMe, updated_at AS updatedAt
             FROM member WHERE id IN (${placeholders(ids.length)})
            ORDER BY display_name`,
        )
        .all(...ids) as RawMember[];
      return rows.map(hydrateMember);
    },

    assignableMembers(teamIds) {
      if (teamIds.length === 0) return [];
      const memberships = db
        .prepare(
          `SELECT team_id AS teamId, user_id AS userId
             FROM team_member WHERE team_id IN (${placeholders(teamIds.length)})`,
        )
        .all(...teamIds) as { teamId: string; userId: string }[];
      const populatedTeams = new Set(memberships.map((row) => row.teamId));
      const fallbackTeams = teamIds.filter((teamId) => !populatedTeams.has(teamId));
      const byId = new Map(
        this.membersByIds([...new Set(memberships.map((row) => row.userId))])
          .filter((member) => member.active && !member.isApp)
          .map((member) => [member.id, member] as const),
      );
      if (fallbackTeams.length > 0) {
        for (const member of this.members(fallbackTeams)) {
          if (member.active && !member.isApp) byId.set(member.id, member);
        }
      }
      return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    },

    viewers(teamIds) {
      const workspaceIds = workspaceIdsForTeams(teamIds);
      const viewerIds = new Set(
        (
          db
            .prepare(
              `SELECT viewer_id AS viewerId FROM workspace
                WHERE id IN (${placeholders(workspaceIds.length)})`,
            )
            .all(...workspaceIds) as { viewerId: string }[]
        ).map((row) => row.viewerId),
      );
      return this.members(teamIds).filter(
        (member) => viewerIds.has(member.id) || (workspaceIds.includes(LEGACY_WORKSPACE_ID) && member.isMe),
      );
    },

    viewer(teamIds) {
      return this.viewers(teamIds)[0] ?? null;
    },

    replaceProjectStatuses(statuses, explicitWorkspaceId) {
      const workspaceIds = new Set(
        statuses.map((status) => inputWorkspaceId(status.workspaceId ?? explicitWorkspaceId)),
      );
      if (explicitWorkspaceId !== undefined) workspaceIds.add(explicitWorkspaceId);
      db.transaction(() => {
        for (const workspaceId of workspaceIds) {
          db.prepare(`DELETE FROM workspace_project_status WHERE workspace_id = ?`).run(workspaceId);
        }
        const statement = db.prepare(
          `INSERT INTO project_status (id, name, type, position, color)
           VALUES (@id, @name, @type, @position, @color)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
             position = excluded.position, color = excluded.color`,
        );
        const ownership = db.prepare(
          `INSERT OR IGNORE INTO workspace_project_status (workspace_id, status_id) VALUES (?, ?)`,
        );
        const removeStale = db.prepare(
          `DELETE FROM workspace_project_status WHERE status_id = ? AND workspace_id != ?`,
        );
        for (const status of statuses) {
          const workspaceId = inputWorkspaceId(status.workspaceId ?? explicitWorkspaceId);
          const { workspaceId: _workspaceId, ...row } = status;
          statement.run(row);
          removeStale.run(status.id, workspaceId);
          ownership.run(workspaceId, status.id);
        }
        db.prepare(`DELETE FROM project_status WHERE NOT EXISTS (
          SELECT 1 FROM workspace_project_status WHERE workspace_project_status.status_id = project_status.id
        )`).run();
      })();
    },

    projectStatuses(teamIds) {
      const workspaceIds = workspaceIdsForTeams(teamIds);
      return db
        .prepare(
          `SELECT DISTINCT project_status.id, project_status.name, project_status.type,
                  project_status.position, project_status.color
             FROM project_status
             JOIN workspace_project_status
               ON workspace_project_status.status_id = project_status.id
            WHERE workspace_project_status.workspace_id IN (${placeholders(workspaceIds.length)})
            ORDER BY project_status.position`,
        )
        .all(...workspaceIds) as ProjectStatusRow[];
    },

    replacePriorityValues(values, explicitWorkspaceId) {
      const workspaceIds = new Set(
        values.map((value) => inputWorkspaceId(value.workspaceId ?? explicitWorkspaceId)),
      );
      if (explicitWorkspaceId !== undefined) workspaceIds.add(explicitWorkspaceId);
      db.transaction(() => {
        const statement = db.prepare(
          `INSERT INTO workspace_priority_value (workspace_id, priority, label)
           VALUES (@workspaceId, @priority, @label)
           ON CONFLICT(workspace_id, priority) DO UPDATE SET label = excluded.label`,
        );
        for (const workspaceId of workspaceIds) {
          db.prepare(`DELETE FROM workspace_priority_value WHERE workspace_id = ?`).run(workspaceId);
        }
        for (const value of values) {
          statement.run({
            workspaceId: inputWorkspaceId(value.workspaceId ?? explicitWorkspaceId),
            priority: value.priority,
            label: value.label,
          });
        }

      })();
    },

    priorityValues(teamIds) {
      const workspaceIds = workspaceIdsForTeams(teamIds);
      return db
        .prepare(
          `SELECT priority, label FROM workspace_priority_value
            WHERE workspace_id IN (${placeholders(workspaceIds.length)})
            ORDER BY priority, workspace_id`,
        )
        .all(...workspaceIds) as PriorityValueRow[];
    },

    /* ── Issues ──────────────────────────────────────────────────────────── */

    putIssues(issues, at) {
      putIssuesTx(issues, at);
    },

    issue(id) {
      const row = db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issue WHERE id = ?`).get(id) as
        | RawIssue
        | undefined;
      return row === undefined ? null : toIssue(row);
    },

    issuesByIds(ids) {
      if (ids.length === 0) return [];
      return (
        db
          .prepare(`SELECT ${ISSUE_COLUMNS} FROM issue WHERE id IN (${placeholders(ids.length)})`)
          .all(...ids) as RawIssue[]
      ).map(toIssue);
    },

    issueByIdentifier(identifier) {
      const direct = db
        .prepare(`SELECT ${ISSUE_COLUMNS} FROM issue WHERE identifier = ? COLLATE NOCASE`)
        .get(identifier) as RawIssue | undefined;
      if (direct !== undefined) return toIssue(direct);
      // An issue moved between teams changes identifier. A link written last
      // month must still resolve, rather than telling the user the issue does
      // not exist.
      const previous = db
        .prepare(
          `SELECT ${ISSUE_COLUMNS} FROM issue
             WHERE id = (SELECT issue_id FROM issue_previous_identifier
                          WHERE identifier = ? COLLATE NOCASE)`,
        )
        .get(identifier) as RawIssue | undefined;
      return previous === undefined ? null : toIssue(previous);
    },

    issuesByIdentifier(identifier) {
      // Every match. ENG-42 can exist in two workspaces at once; a write
      // that resolves through the singular form when both are in the mirror
      // lands on whichever row the index favours. Callers about to WRITE use
      // this and refuse on more than one.
      const rows = db
        .prepare(`SELECT ${ISSUE_COLUMNS} FROM issue WHERE identifier = ? COLLATE NOCASE`)
        .all(identifier) as RawIssue[];
      if (rows.length > 0) return rows.map(toIssue);

      // The previous-identifier fallback, which the singular form has always
      // had and which this one must keep: an issue moved between teams
      // changes identifier, and a link written last month must still resolve
      // rather than telling the user the issue does not exist. Only reached
      // when nothing matches directly, so it cannot mask a live collision.
      const previous = db
        .prepare(
          `SELECT ${ISSUE_COLUMNS} FROM issue
             WHERE id IN (SELECT issue_id FROM issue_previous_identifier
                           WHERE identifier = ? COLLATE NOCASE)`,
        )
        .all(identifier) as RawIssue[];
      return previous.map(toIssue);
    },

    issuesByBranch(branchName) {
      return (
        db
          .prepare(`SELECT ${ISSUE_COLUMNS} FROM issue WHERE branch_name = ?`)
          .all(branchName) as RawIssue[]
      ).map(toIssue);
    },

    queryIssues(query) {
      const { sql, params } = buildIssueWhere(query);
      const rows = db
        .prepare(
          `SELECT ${ISSUE_COLUMNS}
             FROM issue LEFT JOIN workflow_state AS state ON state.id = issue.state_id
            WHERE ${sql}
            ORDER BY ${ORDER_BY[query.sort]}
            LIMIT ? OFFSET ?`,
        )
        .all(...params, query.limit, query.offset ?? 0) as RawIssue[];
      return rows.map(toIssue);
    },

    countIssues(filter) {
      const { sql, params } = buildIssueWhere(filter);
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM issue LEFT JOIN workflow_state AS state ON state.id = issue.state_id
            WHERE ${sql}`,
        )
        .get(...params) as { n: number };
      return row.n;
    },

    deleteIssues(ids) {
      if (ids.length === 0) return;
      db.transaction(() => {
        db.prepare(`DELETE FROM issue WHERE id IN (${placeholders(ids.length)})`).run(...ids);
        db.prepare(
          `DELETE FROM issue_previous_identifier WHERE issue_id IN (${placeholders(ids.length)})`,
        ).run(...ids);
      })();
    },

    childIssues(parentId, limit) {
      if (limit <= 0) return [];
      return (
        db
          .prepare(
            `SELECT ${ISSUE_COLUMNS} FROM issue
              WHERE parent_id = ? AND archived_at IS NULL
              ORDER BY sub_issue_sort_order IS NULL, sub_issue_sort_order, sort_order, id
              LIMIT ?`,
          )
          .all(parentId, Math.floor(limit)) as RawIssue[]
      ).map(toIssue);
    },

    subIssueProgress(parentIds) {
      const progress = new Map<string, { done: number; total: number }>();
      if (parentIds.length === 0) return progress;
      const rows = db
        .prepare(
          `SELECT issue.parent_id AS parentId,
                  COUNT(*) AS total,
                  SUM(CASE WHEN state.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
             FROM issue LEFT JOIN workflow_state AS state ON state.id = issue.state_id
            WHERE issue.parent_id IN (${placeholders(parentIds.length)})
              AND issue.archived_at IS NULL
            GROUP BY issue.parent_id`,
        )
        .all(...parentIds) as { parentId: string; total: number; done: number }[];
      for (const row of rows) {
        progress.set(row.parentId, { done: row.done ?? 0, total: row.total });
      }
      return progress;
    },

    putPreviousIdentifiers(issueId, identifiers) {
      const statement = db.prepare(
        `INSERT INTO issue_previous_identifier (identifier, issue_id) VALUES (?, ?)
         ON CONFLICT(identifier) DO UPDATE SET issue_id = excluded.issue_id`,
      );
      db.transaction(() => {
        for (const identifier of identifiers) statement.run(identifier, issueId);
      })();
    },

    /* ── Bindings ────────────────────────────────────────────────────────── */

    putComments(comments) {
      const statement = db.prepare(
        `INSERT INTO comment (id, issue_id, user_id, parent_id, body, url,
                              created_at, updated_at, edited_at, resolved_at)
         VALUES (@id, @issueId, @userId, @parentId, @body, @url,
                 @createdAt, @updatedAt, @editedAt, @resolvedAt)
         ON CONFLICT(id) DO UPDATE SET
           issue_id = excluded.issue_id, user_id = excluded.user_id,
           parent_id = excluded.parent_id, body = excluded.body,
           url = excluded.url, created_at = excluded.created_at,
           updated_at = excluded.updated_at, edited_at = excluded.edited_at,
           resolved_at = excluded.resolved_at`,
      );
      db.transaction(() => {
        for (const comment of comments) statement.run(comment);
      })();
    },

    comments(issueId) {
      return db
        .prepare(
          `SELECT id, issue_id AS issueId, user_id AS userId, parent_id AS parentId,
                  body, url, created_at AS createdAt, updated_at AS updatedAt,
                  edited_at AS editedAt, resolved_at AS resolvedAt
             FROM comment WHERE issue_id = ? ORDER BY created_at`,
        )
        .all(issueId) as CommentRow[];
    },

    recordEcho(entityId, updatedAt, at) {
      db.prepare(
        `INSERT OR IGNORE INTO echo (entity_id, updated_at, recorded_at) VALUES (?, ?, ?)`,
      ).run(entityId, updatedAt, at);
    },

    isEcho(entityId, updatedAt) {
      const row = db
        .prepare(`SELECT 1 AS hit FROM echo WHERE entity_id = ? AND updated_at = ?`)
        .get(entityId, updatedAt) as { hit: number } | undefined;
      return row !== undefined;
    },

    pruneEchoes(olderThan) {
      // An hour is far longer than any tick interval, and an echo that
      // outlives its usefulness only costs a row.
      return db.prepare(`DELETE FROM echo WHERE recorded_at < ?`).run(olderThan).changes;
    },

    putInbox(rows) {
      const statement = db.prepare(
        `INSERT INTO inbox (key, workspace_id, kind, issue_id, team_id, actor_id, title, body, url,
                            created_at, seen_at, dismissed_at, linear_read_at)
         VALUES (@key, @workspaceId, @kind, @issueId, @teamId, @actorId, @title, @body, @url,
                 @createdAt, @seenAt, @dismissedAt, @linearReadAt)
         ON CONFLICT(key) DO UPDATE SET
           workspace_id = excluded.workspace_id, kind = excluded.kind,
           issue_id = excluded.issue_id,
           team_id = excluded.team_id, actor_id = excluded.actor_id,
           title = excluded.title, body = excluded.body, url = excluded.url,
           created_at = excluded.created_at,
           linear_read_at = excluded.linear_read_at`,
      );
      db.transaction(() => {
        for (const row of rows) statement.run(row);
      })();
    },

    inbox(options) {
      const where = options?.includeDismissed === true ? "" : "WHERE dismissed_at IS NULL";
      return db
        .prepare(
          `SELECT key, workspace_id AS workspaceId, kind,
                  issue_id AS issueId, team_id AS teamId, actor_id AS actorId,
                  title, body, url, created_at AS createdAt, seen_at AS seenAt,
                  dismissed_at AS dismissedAt, linear_read_at AS linearReadAt
             FROM inbox ${where}
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(options?.limit ?? 200) as InboxRowRecord[];
    },

    markInboxSeen(keys, at) {
      if (keys.length === 0) return;
      db.prepare(
        `UPDATE inbox SET seen_at = ? WHERE seen_at IS NULL AND key IN (${placeholders(keys.length)})`,
      ).run(at, ...keys);
    },

    dismissInbox(keys, at) {
      if (keys.length === 0) return;
      db.prepare(
        `UPDATE inbox SET dismissed_at = ? WHERE key IN (${placeholders(keys.length)})`,
      ).run(at, ...keys);
    },

    unseenInboxCount() {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM inbox
            WHERE dismissed_at IS NULL AND seen_at IS NULL AND linear_read_at IS NULL`,
        )
        .get() as { n: number };
      return row.n;
    },

    pruneInbox(olderThan, limit) {
      if (limit <= 0) return 0;
      return db
        .prepare(
          `DELETE FROM inbox WHERE key IN (
             SELECT key FROM inbox
              WHERE dismissed_at IS NOT NULL AND dismissed_at < ?
              ORDER BY dismissed_at
              LIMIT ?
           )`,
        )
        .run(olderThan, Math.floor(limit)).changes;
    },

    claimDelivery(key, kind, at) {
      const result = db
        .prepare(`INSERT OR IGNORE INTO delivered (key, kind, claimed_at) VALUES (?, ?, ?)`)
        .run(key, kind, at);
      return result.changes === 1;
    },

    markDelivered(key, at) {
      db.prepare(`UPDATE delivered SET sent_at = ? WHERE key = ?`).run(at, key);
    },

    pruneDeliveries(olderThan) {
      return db.prepare(`DELETE FROM delivered WHERE claimed_at < ?`).run(olderThan).changes;
    },

    putProjects(rows, teamLinks) {
      const project = db.prepare(
        `INSERT INTO project (id, name, description, url, status_id, lead_id,
                              start_date, target_date, progress, updated_at)
         VALUES (@id, @name, @description, @url, @statusId, @leadId,
                 @startDate, @targetDate, @progress, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, description = excluded.description,
           url = excluded.url, status_id = excluded.status_id,
           lead_id = excluded.lead_id, start_date = excluded.start_date,
           target_date = excluded.target_date, progress = excluded.progress,
           updated_at = excluded.updated_at`,
      );
      const link = db.prepare(
        `INSERT OR IGNORE INTO project_team (project_id, team_id) VALUES (?, ?)`,
      );
      db.transaction(() => {
        for (const row of rows) project.run(row);
        for (const entry of teamLinks) link.run(entry.projectId, entry.teamId);
      })();
    },

    projects(teamIds) {
      if (teamIds.length === 0) return [];
      return db
        .prepare(
          `SELECT DISTINCT project.id, project.name, project.description, project.url,
                  project.status_id AS statusId, project.lead_id AS leadId,
                  project.start_date AS startDate, project.target_date AS targetDate,
                  project.progress, project.updated_at AS updatedAt
             FROM project
             JOIN project_team ON project_team.project_id = project.id
            WHERE project_team.team_id IN (${placeholders(teamIds.length)})
            ORDER BY project.name`,
        )
        .all(...teamIds) as ProjectRow[];
    },

    project(id) {
      const row = db
        .prepare(
          `SELECT id, name, description, url, status_id AS statusId, lead_id AS leadId,
                  start_date AS startDate, target_date AS targetDate, progress,
                  updated_at AS updatedAt
             FROM project WHERE id = ?`,
        )
        .get(id) as ProjectRow | undefined;
      return row ?? null;
    },

    putMilestones(rows) {
      const statement = db.prepare(
        `INSERT INTO milestone (id, project_id, name, target_date, sort_order, updated_at)
         VALUES (@id, @projectId, @name, @targetDate, @sortOrder, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, name = excluded.name,
           target_date = excluded.target_date, sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      );
      db.transaction(() => {
        for (const row of rows) statement.run(row);
      })();
    },

    milestone(id) {
      const row = db
        .prepare(
          `SELECT id, project_id AS projectId, name, target_date AS targetDate,
                  sort_order AS sortOrder, updated_at AS updatedAt
             FROM milestone WHERE id = ?`,
        )
        .get(id) as MilestoneRow | undefined;
      return row ?? null;
    },

    putCycles(rows) {
      const statement = db.prepare(
        `INSERT INTO cycle (id, team_id, number, name, starts_at, ends_at,
                            is_active, is_next, is_previous, updated_at)
         VALUES (@id, @teamId, @number, @name, @startsAt, @endsAt,
                 @isActive, @isNext, @isPrevious, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           team_id = excluded.team_id, number = excluded.number, name = excluded.name,
           starts_at = excluded.starts_at, ends_at = excluded.ends_at,
           is_active = excluded.is_active, is_next = excluded.is_next,
           is_previous = excluded.is_previous, updated_at = excluded.updated_at`,
      );
      db.transaction(() => {
        for (const row of rows) {
          statement.run({
            ...row,
            isActive: toInt(row.isActive),
            isNext: toInt(row.isNext),
            isPrevious: toInt(row.isPrevious),
          });
        }
      })();
    },

    cycles(teamId) {
      const rows = db
        .prepare(
          `SELECT id, team_id AS teamId, number, name, starts_at AS startsAt,
                  ends_at AS endsAt, is_active AS isActive, is_next AS isNext,
                  is_previous AS isPrevious, updated_at AS updatedAt
             FROM cycle WHERE team_id = ? ORDER BY number DESC`,
        )
        .all(teamId) as RawCycle[];
      return rows.map(hydrateCycle);
    },

    cycle(id) {
      const row = db
        .prepare(
          `SELECT id, team_id AS teamId, number, name, starts_at AS startsAt,
                  ends_at AS endsAt, is_active AS isActive, is_next AS isNext,
                  is_previous AS isPrevious, updated_at AS updatedAt
             FROM cycle WHERE id = ?`,
        )
        .get(id) as RawCycle | undefined;
      return row === undefined ? null : hydrateCycle(row);
    },

    replaceRelations(issueId, rows) {
      db.transaction(() => {
        // Replaced rather than upserted: a relation removed in Linear has no
        // tombstone, and a stale one produces a "blocked by" line about
        // something that is no longer blocking anything.
        db.prepare(`DELETE FROM relation WHERE issue_id = ?`).run(issueId);
        const statement = db.prepare(
          `INSERT OR REPLACE INTO relation (id, issue_id, related_issue_id, type)
           VALUES (@id, @issueId, @relatedIssueId, @type)`,
        );
        for (const row of rows) statement.run(row);
      })();
    },

    blockersFor(issueIds) {
      const blockers = new Map<string, string[]>();
      if (issueIds.length === 0) return blockers;
      // `blocks` points from the blocker to the blocked, so "what blocks me"
      // reads the *related* side. And only open blockers count: an issue
      // blocked by something already done is not blocked.
      const rows = db
        .prepare(
          `SELECT relation.related_issue_id AS blockedId, issue.identifier AS identifier
             FROM relation
             JOIN issue ON issue.id = relation.issue_id
             LEFT JOIN workflow_state AS state ON state.id = issue.state_id
            WHERE relation.type = 'blocks'
              AND relation.related_issue_id IN (${placeholders(issueIds.length)})
              AND (state.type IS NULL OR state.type NOT IN ('completed', 'canceled'))`,
        )
        .all(...issueIds) as { blockedId: string; identifier: string }[];
      for (const row of rows) {
        const list = blockers.get(row.blockedId) ?? [];
        list.push(row.identifier);
        blockers.set(row.blockedId, list);
      }
      return blockers;
    },

    replaceGitAutomation(teamId, rows) {
      db.transaction(() => {
        // Replaced rather than upserted: an automation row deleted in Linear
        // has no tombstone, and a stale one would keep moving issues to a
        // state the user removed from their configuration.
        db.prepare(`DELETE FROM git_automation_state WHERE team_id = ?`).run(teamId);
        const statement = db.prepare(
          `INSERT INTO git_automation_state
             (id, team_id, event, state_id, state_name, target_branch_pattern, target_branch_is_regex)
           VALUES (@id, @teamId, @event, @stateId, @stateName, @targetBranchPattern, @targetBranchIsRegex)`,
        );
        for (const row of rows) {
          statement.run({ ...row, targetBranchIsRegex: toInt(row.targetBranchIsRegex) });
        }
      })();
    },

    gitAutomation(teamId) {
      const rows = db
        .prepare(
          `SELECT id, team_id AS teamId, event, state_id AS stateId, state_name AS stateName,
                  target_branch_pattern AS targetBranchPattern,
                  target_branch_is_regex AS targetBranchIsRegex
             FROM git_automation_state WHERE team_id = ?`,
        )
        .all(teamId) as (Omit<GitAutomationRow, "targetBranchIsRegex"> & {
        targetBranchIsRegex: number;
      })[];
      return rows.map((row) => ({ ...row, targetBranchIsRegex: bool(row.targetBranchIsRegex) }));
    },

    putBranchLink(row) {
      db.prepare(
        `INSERT INTO branch_link (environment_id, branch_name, issue_id, resolution, resolved_at)
         VALUES (@environmentId, @branchName, @issueId, @resolution, @resolvedAt)
         ON CONFLICT(environment_id) DO UPDATE SET
           branch_name = excluded.branch_name, issue_id = excluded.issue_id,
           resolution = excluded.resolution, resolved_at = excluded.resolved_at`,
      ).run(row);
    },

    branchLink(environmentId) {
      const row = db
        .prepare(
          `SELECT environment_id AS environmentId, branch_name AS branchName,
                  issue_id AS issueId, resolution, resolved_at AS resolvedAt
             FROM branch_link WHERE environment_id = ?`,
        )
        .get(environmentId) as BranchLinkRow | undefined;
      return row ?? null;
    },

    putPrState(row) {
      db.prepare(
        `INSERT INTO pr_state (environment_id, issue_id, pr_number, pr_url, pr_state,
                               pr_attention, applied_state_id, applied_at, last_seen_at)
         VALUES (@environmentId, @issueId, @prNumber, @prUrl, @prState,
                 @prAttention, @appliedStateId, @appliedAt, @lastSeenAt)
         ON CONFLICT(environment_id) DO UPDATE SET
           issue_id = excluded.issue_id, pr_number = excluded.pr_number,
           pr_url = excluded.pr_url, pr_state = excluded.pr_state,
           pr_attention = excluded.pr_attention,
           applied_state_id = COALESCE(excluded.applied_state_id, pr_state.applied_state_id),
           applied_at = COALESCE(excluded.applied_at, pr_state.applied_at),
           last_seen_at = excluded.last_seen_at`,
      ).run(row);
    },

    prState(environmentId) {
      const row = db
        .prepare(
          `SELECT environment_id AS environmentId, issue_id AS issueId, pr_number AS prNumber,
                  pr_url AS prUrl, pr_state AS prState, pr_attention AS prAttention,
                  applied_state_id AS appliedStateId, applied_at AS appliedAt,
                  last_seen_at AS lastSeenAt
             FROM pr_state WHERE environment_id = ?`,
        )
        .get(environmentId) as PrStateRow | undefined;
      return row ?? null;
    },

    prStatesByIssue(issueIds) {
      if (issueIds.length === 0) return [];
      return db
        .prepare(
          `SELECT environment_id AS environmentId, issue_id AS issueId, pr_number AS prNumber,
                  pr_url AS prUrl, pr_state AS prState, pr_attention AS prAttention,
                  applied_state_id AS appliedStateId, applied_at AS appliedAt,
                  last_seen_at AS lastSeenAt
             FROM pr_state WHERE issue_id IN (${placeholders(issueIds.length)})`,
        )
        .all(...issueIds) as PrStateRow[];
    },

    putLocalSecret(key, value) {
      db.prepare(
        `INSERT INTO local_secret (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },

    localSecret(key) {
      const row = db.prepare(`SELECT value FROM local_secret WHERE key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },

    putProbe(key, outcome, at) {
      db.prepare(
        `INSERT INTO probe (key, outcome, at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET outcome = excluded.outcome, at = excluded.at`,
      ).run(key, outcome, at);
    },

    probe(key) {
      const row = db.prepare(`SELECT outcome, at FROM probe WHERE key = ?`).get(key) as
        | { outcome: string; at: number }
        | undefined;
      return row ?? null;
    },

    linkThread(row) {
      db.prepare(
        `INSERT INTO thread_link (thread_id, issue_id, team_id, project_id, created_at, origin)
         VALUES (@threadId, @issueId, @teamId, @projectId, @createdAt, @origin)
         ON CONFLICT(thread_id) DO UPDATE SET
           issue_id = excluded.issue_id, team_id = excluded.team_id,
           project_id = excluded.project_id, origin = excluded.origin`,
      ).run(row);
    },

    unlinkThread(threadId) {
      db.prepare(`DELETE FROM thread_link WHERE thread_id = ?`).run(threadId);
    },

    threadLink(threadId) {
      const row = db
        .prepare(
          `SELECT thread_id AS threadId, issue_id AS issueId, team_id AS teamId,
                  project_id AS projectId, created_at AS createdAt, origin
             FROM thread_link WHERE thread_id = ?`,
        )
        .get(threadId) as ThreadLinkRow | undefined;
      return row ?? null;
    },

    threadLinksByThreadIds(threadIds) {
      if (threadIds.length === 0) return [];
      return db
        .prepare(
          `SELECT thread_id AS threadId, issue_id AS issueId, team_id AS teamId,
                  project_id AS projectId, created_at AS createdAt, origin
             FROM thread_link WHERE thread_id IN (${placeholders(threadIds.length)})`,
        )
        .all(...threadIds) as ThreadLinkRow[];
    },

    threadLinksForIssues(issueIds) {
      if (issueIds.length === 0) return [];
      return db
        .prepare(
          `SELECT thread_id AS threadId, issue_id AS issueId, team_id AS teamId,
                  project_id AS projectId, created_at AS createdAt, origin
             FROM thread_link WHERE issue_id IN (${placeholders(issueIds.length)})`,
        )
        .all(...issueIds) as ThreadLinkRow[];
    },

    bindings() {
      return db
        .prepare(
          `SELECT project_id AS projectId, team_id AS teamId, role, bound_at AS boundAt
             FROM binding ORDER BY project_id, role, team_id`,
        )
        .all() as BindingRow[];
    },

    bindingsForProject(projectId) {
      return db
        .prepare(
          `SELECT project_id AS projectId, team_id AS teamId, role, bound_at AS boundAt
             FROM binding WHERE project_id = ?
             ORDER BY CASE role WHEN 'primary' THEN 0 WHEN 'write' THEN 1 ELSE 2 END, team_id`,
        )
        .all(projectId) as BindingRow[];
    },

    boundTeamIds() {
      // Only teams that still exist. A binding whose team is gone — the key
      // that reached it was cleared — must not keep driving the sync loop,
      // which would send that workspace's team ids over whichever key is left
      // and get silently empty answers forever. The binding row itself
      // survives (it is the user's intent, and re-adding the key restores it);
      // it just stops being a sync instruction while its team is absent.
      return (
        db
          .prepare(
            `SELECT DISTINCT b.team_id AS teamId
               FROM binding b JOIN team t ON t.id = b.team_id`,
          )
          .all() as { teamId: string }[]
      ).map((row) => row.teamId);
    },

    setBinding(projectId, teamId, role, at) {
      db.transaction(() => {
        // Promoting a team to primary demotes the incumbent rather than
        // colliding with the partial unique index. Doing it here rather than
        // at three call sites is what keeps "exactly one primary" true.
        if (role === "primary") {
          db.prepare(
            `UPDATE binding SET role = 'write' WHERE project_id = ? AND role = 'primary' AND team_id != ?`,
          ).run(projectId, teamId);
        }
        db.prepare(
          `INSERT INTO binding (project_id, team_id, role, bound_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, team_id) DO UPDATE SET role = excluded.role`,
        ).run(projectId, teamId, role, at);
      })();
    },

    removeBinding(projectId, teamId) {
      db.prepare(`DELETE FROM binding WHERE project_id = ? AND team_id = ?`).run(
        projectId,
        teamId,
      );
    },

    removeProjectBindings(projectId) {
      db.prepare(`DELETE FROM binding WHERE project_id = ?`).run(projectId);
    },

    /* ── Disconnect ──────────────────────────────────────────────────────── */

    forgetEverything() {
      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                AND name NOT LIKE '_bb_%' AND name NOT LIKE '%_fts_%'`,
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      db.transaction(() => {
        // The FTS shadow tables are emptied by the triggers as `issue` drains,
        // so they are deliberately not deleted directly — doing that would
        // desynchronise the index from its content table.
        for (const table of tables) db.prepare(`DELETE FROM "${table}"`).run();
      })();
    },
  };
}

/** SQLite has no boolean: these four arrive as 0 or 1. */
type RawTeam = Omit<
  TeamRow,
  "estimationAllowZero" | "estimationExtended" | "cyclesEnabled" | "triageEnabled"
> & {
  estimationAllowZero: number;
  estimationExtended: number;
  cyclesEnabled: number;
  triageEnabled: number;
};

function hydrateTeam(row: RawTeam): TeamRow {
  return {
    ...row,
    estimationAllowZero: bool(row.estimationAllowZero),
    estimationExtended: bool(row.estimationExtended),
    cyclesEnabled: bool(row.cyclesEnabled),
    triageEnabled: bool(row.triageEnabled),
  };
}

type RawCycle = Omit<CycleRow, "isActive" | "isNext" | "isPrevious"> & {
  isActive: number;
  isNext: number;
  isPrevious: number;
};

function hydrateCycle(row: RawCycle): CycleRow {
  return {
    ...row,
    isActive: bool(row.isActive),
    isNext: bool(row.isNext),
    isPrevious: bool(row.isPrevious),
  };
}

type RawLabel = Omit<LabelRow, "isGroup"> & { isGroup: number };
type RawMember = Omit<MemberRow, "active" | "isApp" | "isMe"> & {
  active: number;
  isApp: number;
  isMe: number;
};

function hydrateMember(row: RawMember): MemberRow {
  return { ...row, active: bool(row.active), isApp: bool(row.isApp), isMe: bool(row.isMe) };
}

/**
 * Turn what a person typed into an FTS5 MATCH expression.
 *
 * FTS5's query syntax is a real grammar: a stray `"`, a bare `*`, `NEAR`, `OR`
 * or an unbalanced paren throws rather than matching nothing, and the throw
 * lands in the middle of rendering a list while somebody is still typing. So
 * the input is tokenised, every token is quoted (doubling any internal quote)
 * and given a prefix `*`, and the tokens are joined by implicit AND.
 *
 * A side effect worth having: because the `unicode61` tokeniser splits on
 * punctuation, typing `ENG-123` searches for `eng` and `123`, which finds the
 * issue by identifier without a special case.
 */
export function toMatchQuery(text: string): string {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_]+/gu, " ").trim())
    .flatMap((token) => token.split(/\s+/))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" ");
}

export { MIGRATIONS };
