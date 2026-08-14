/**
 * The mirror's row shapes.
 *
 * Every surface — the panel, the CLI, the mention providers, the agent tools —
 * reads from here. **No surface ever waits on Linear to render.** That is the
 * single decision the whole architecture is arranged around: the poller fills
 * SQLite, and everything else is a query.
 *
 * Columns are `snake_case` in SQL and camelCase here, aliased explicitly in
 * each `SELECT` rather than mapped by a generic transformer. The aliasing is
 * more typing and it is worth it: a renamed column fails to compile at the
 * query instead of yielding `undefined` at the render.
 */

export interface WorkspaceRow {
  readonly id: string;
  /** Which settings slot's key found this workspace. A Linear personal API key
   *  is scoped to one workspace, so this is also the answer to "which key can
   *  write to this team". */
  readonly slot: string;
  readonly name: string;
  readonly urlKey: string;
  readonly viewerId: string;
  readonly viewerName: string;
  readonly gitBranchFormat: string | null;
  readonly fetchedAt: number;
}

export interface TeamRow {
  readonly id: string;
  /** Null on a row written before workspaces were plural. Resolves to the
   *  primary slot, which is where it came from. */
  readonly workspaceId: string | null;
  readonly key: string;
  readonly name: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly parentId: string | null;
  /** `notUsed | exponential | fibonacci | linear | tShirt`. Not "points" —
   *  rendering "3 points" on a t-shirt team is wrong in a way that makes the
   *  whole panel look like it does not know the workspace. */
  readonly estimationType: string;
  readonly estimationAllowZero: boolean;
  readonly estimationExtended: boolean;
  readonly defaultEstimate: number;
  readonly cyclesEnabled: boolean;
  readonly triageEnabled: boolean;
  readonly activeCycleId: string | null;
  readonly updatedAt: number | null;
  readonly fetchedAt: number;
}

/**
 * `type` is one of `triage | backlog | unstarted | started | completed |
 * canceled | duplicate` — but the SDL types it as `String`, not an enum, and
 * Linear adds members. An exhaustive switch over five of them drops issues on
 * triage-enabled teams; every consumer here treats an unrecognised value as
 * "unknown" and renders the team's own state name beside a neutral mark.
 */
export interface WorkflowStateRow {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly type: string;
  readonly color: string | null;
  readonly position: number;
  readonly description: string | null;
}

export interface LabelRow {
  readonly id: string;
  /** `null` means **workspace-level**, not orphaned. */
  readonly teamId: string | null;
  readonly name: string;
  readonly color: string | null;
  readonly parentId: string | null;
  readonly isGroup: boolean;
  readonly updatedAt: number | null;
}

export interface MemberRow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  readonly active: boolean;
  readonly isApp: boolean;
  readonly isMe: boolean;
  readonly updatedAt: number | null;
}

export interface ProjectStatusRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly position: number;
  readonly color: string | null;
}

export interface PriorityValueRow {
  readonly priority: number;
  readonly label: string;
}

export interface IssueRow {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly teamId: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string | null;
  /** `Issue.branchName`. Not `gitBranchName`, which does not exist anywhere in
   *  the schema — writing it fails the query with an unknown-field error. */
  readonly branchName: string | null;
  readonly priority: number;
  readonly estimate: number | null;
  readonly stateId: string | null;
  readonly assigneeId: string | null;
  readonly creatorId: string | null;
  readonly projectId: string | null;
  readonly milestoneId: string | null;
  readonly cycleId: string | null;
  readonly parentId: string | null;
  /** `TimelessDate` — a calendar date, kept as `YYYY-MM-DD`. */
  readonly dueDate: string | null;
  readonly sortOrder: number;
  readonly subIssueSortOrder: number | null;
  /** JSON array of label ids, straight from `Issue.labelIds`. Flattened
   *  rather than nested: a `labels { nodes { … } }` selection is a connection,
   *  and connections multiply the complexity of everything beneath them. */
  readonly labelIds: readonly string[];
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly canceledAt: number | null;
  readonly triagedAt: number | null;
  readonly archivedAt: number | null;
  readonly createdAt: number | null;
  readonly updatedAt: number;
  readonly syncedAt: number;
}

export type BindingRole = "primary" | "write" | "read";

export interface BindingRow {
  readonly projectId: string;
  readonly teamId: string;
  readonly role: BindingRole;
  readonly boundAt: number;
}

export function isBindingRole(value: string): value is BindingRole {
  return value === "primary" || value === "write" || value === "read";
}

export interface CommentRow {
  readonly id: string;
  readonly issueId: string;
  readonly userId: string | null;
  readonly parentId: string | null;
  readonly body: string;
  readonly url: string | null;
  readonly createdAt: number | null;
  readonly updatedAt: number;
  readonly editedAt: number | null;
  readonly resolvedAt: number | null;
}

export type ThreadLinkOrigin = "spawn" | "manual" | "branch";

export interface ThreadLinkRow {
  readonly threadId: string;
  readonly issueId: string;
  readonly teamId: string;
  readonly projectId: string | null;
  readonly createdAt: number;
  readonly origin: ThreadLinkOrigin;
}

export interface InboxRowRecord {
  readonly key: string;
  readonly kind: string;
  readonly issueId: string | null;
  readonly teamId: string | null;
  readonly actorId: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly url: string | null;
  readonly createdAt: number;
  readonly seenAt: number | null;
  readonly dismissedAt: number | null;
  readonly linearReadAt: number | null;
}

export interface GitAutomationRow {
  readonly id: string;
  readonly teamId: string;
  readonly event: string;
  readonly stateId: string | null;
  readonly stateName: string | null;
  readonly targetBranchPattern: string | null;
  readonly targetBranchIsRegex: boolean;
}

export type BranchResolution = "linear" | "regex" | "none";

export interface BranchLinkRow {
  readonly environmentId: string;
  readonly branchName: string;
  readonly issueId: string | null;
  readonly resolution: BranchResolution;
  readonly resolvedAt: number;
}

export interface PrStateRow {
  readonly environmentId: string;
  readonly issueId: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly prState: string | null;
  readonly prAttention: string | null;
  readonly appliedStateId: string | null;
  readonly appliedAt: number | null;
  readonly lastSeenAt: number;
}

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly url: string | null;
  readonly statusId: string | null;
  readonly leadId: string | null;
  /** `TimelessDate` — a calendar date, kept as `YYYY-MM-DD`. */
  readonly startDate: string | null;
  readonly targetDate: string | null;
  readonly progress: number | null;
  readonly updatedAt: number;
}

export interface MilestoneRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly targetDate: string | null;
  readonly sortOrder: number;
  readonly updatedAt: number;
}

export interface CycleRow {
  readonly id: string;
  readonly teamId: string;
  readonly number: number;
  readonly name: string | null;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  /** From Linear, never from date arithmetic here. */
  readonly isActive: boolean;
  readonly isNext: boolean;
  readonly isPrevious: boolean;
  readonly updatedAt: number;
}

export type RelationType = "blocks" | "related" | "duplicate" | "similar";

export interface RelationRow {
  readonly id: string;
  readonly issueId: string;
  readonly relatedIssueId: string;
  readonly type: string;
}
