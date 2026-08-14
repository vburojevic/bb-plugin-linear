/**
 * Hand-written result shapes for the documents in `documents.ts`.
 *
 * Narrow on purpose: each interface describes exactly the fields its document
 * selects, with the SDL's own nullability. `@linear/sdk` would supply
 * generated types for the whole 50,000-line schema, at ~29 MB unpacked and one
 * network round trip per relation getter against an hourly *request* budget —
 * and the escape hatch everyone reaches for is `client.rawRequest`, which is
 * raw GraphQL with a 29 MB wrapper around it. Twenty-five documents' worth of
 * interfaces is the smaller thing to own.
 *
 * Nullability here is copied from `src/schema/linear.graphql`, and the
 * document validation test is what keeps it honest: a field that turns
 * nullable upstream fails validation on the next `npm run schema:pull` rather
 * than throwing at a user six weeks later.
 */

/** Linear returns relations as `{ id }` objects, nullable where the SDL says
 *  so. Flattening them at the apply boundary is what keeps every id column in
 *  the mirror a plain string. */
export interface Ref {
  readonly id: string;
}

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor?: string | null;
}

export interface Connection<T> {
  readonly nodes: readonly T[];
  readonly pageInfo: PageInfo;
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface ViewerOrganization {
  readonly id: string;
  readonly name: string;
  readonly urlKey: string;
  /** `Organization.gitBranchFormat: String` — nullable. A workspace that has
   *  never customised its branch template has none, which is not an error. */
  readonly gitBranchFormat: string | null;
}

export interface Viewer {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
  /** `User.avatarUrl: String` — nullable. */
  readonly avatarUrl: string | null;
  readonly organization: ViewerOrganization;
}

export interface ViewerResult {
  readonly viewer: Viewer;
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface ProjectStatusNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly position: number;
  readonly color: string;
}

export interface TeamNode {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly parent: Ref | null;
  /** `notUsed | exponential | fibonacci | linear | tShirt`. */
  readonly issueEstimationType: string;
  readonly issueEstimationAllowZero: boolean;
  readonly issueEstimationExtended: boolean;
  readonly defaultIssueEstimate: number;
  readonly cyclesEnabled: boolean;
  readonly triageEnabled: boolean;
  readonly activeCycle: Ref | null;
  readonly updatedAt: string;
}

export interface BootstrapResult {
  readonly viewer: Viewer & {
    readonly organization: ViewerOrganization & {
      readonly projectStatuses: readonly ProjectStatusNode[];
    };
  };
  readonly issuePriorityValues: readonly { readonly priority: number; readonly label: string }[];
  readonly teams: Connection<TeamNode>;
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface WorkflowStateNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly color: string;
  readonly position: number;
  readonly description: string | null;
  readonly team: Ref;
}

export interface IssueLabelNode {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly isGroup: boolean;
  readonly updatedAt: string;
  readonly parent: Ref | null;
  /** `null` means workspace-level, not orphaned. */
  readonly team: Ref | null;
}

export interface UserNode {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
  readonly avatarUrl: string | null;
  readonly active: boolean;
  readonly app: boolean;
  readonly isMe: boolean;
}

export interface TeamGraphResult {
  readonly workflowStates: Connection<WorkflowStateNode>;
  readonly issueLabels: Connection<IssueLabelNode>;
  readonly users: Connection<UserNode>;
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface IssueNode {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly branchName: string;
  readonly priority: number;
  readonly estimate: number | null;
  /** `TimelessDate` — stays a string. */
  readonly dueDate: string | null;
  readonly sortOrder: number;
  readonly subIssueSortOrder: number | null;
  readonly labelIds: readonly string[];
  readonly previousIdentifiers: readonly string[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly canceledAt: string | null;
  readonly triagedAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly team: Ref;
  readonly state: Ref;
  readonly assignee: Ref | null;
  readonly creator: Ref | null;
  readonly project: Ref | null;
  readonly projectMilestone: Ref | null;
  readonly cycle: Ref | null;
  readonly parent: Ref | null;
}

export interface IssuesResult {
  readonly issues: Connection<IssueNode>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* One issue                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export interface CommentNode {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly editedAt: string | null;
  readonly resolvedAt: string | null;
  readonly user: Ref | null;
  readonly parent: Ref | null;
  readonly issue?: Ref | null;
}

export interface ChildIssueNode {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly state: { readonly id: string; readonly type: string };
}

export interface IssueDetailNode extends IssueNode {
  /** The workspace's own word for this priority, in its own language. */
  readonly priorityLabel: string;
  readonly children: Connection<ChildIssueNode>;
  readonly comments: Connection<CommentNode>;
  readonly team: Ref & {
    readonly key: string;
    readonly name: string;
    /** `notUsed | exponential | fibonacci | linear | tShirt`. The estimate
     *  control does not render at all on `notUsed` — "3 points" is wrong on a
     *  t-shirt team, and an empty control is wrong on a team that does not
     *  estimate. */
    readonly issueEstimationType: string;
  };
}

export interface IssueDetailResult {
  /** `Query.issue` is non-nullable: a missing issue arrives as a GraphQL
   *  error, never as a null. */
  readonly issue: IssueDetailNode;
}

export interface IssueUpdateResult {
  readonly issueUpdate: {
    readonly success: boolean;
    readonly issue: IssueNode | null;
  };
}

export interface CommentCreateResult {
  readonly commentCreate: {
    readonly success: boolean;
    readonly comment: CommentNode | null;
  };
}

export interface TickResult {
  readonly issues: Connection<IssueNode>;
  readonly comments: Connection<CommentNode>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Notifications                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * `Notification.type` is a plain `String!` and the per-kind types are custom
 * scalars, so the literal `"issueAssignedToYou"` appears nowhere in the SDL.
 * What *is* a real enum is `category`. `classify()` routes on that and refines
 * with `type`, and treats an unrecognised value as a generic row rather than
 * dropping it — an exhaustive switch on `type` would go silently deaf the next
 * time Linear adds a member.
 */
export interface NotificationNode {
  readonly id: string;
  readonly type: string;
  readonly category: string;
  readonly groupingKey: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly snoozedUntilAt: string | null;
  readonly inboxUrl: string;
  readonly title: string;
  readonly subtitle: string;
  readonly issueStatusType: string | null;
  readonly actor: Ref | null;
  /** Present only on `IssueNotification`. */
  readonly issueId?: string;
  readonly commentId?: string | null;
  readonly parentCommentId?: string | null;
  readonly team?: Ref;
  readonly issue?: {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly updatedAt: string;
  };
}

export interface NotificationsResult {
  readonly notifications: Connection<NotificationNode>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pull requests                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export interface BranchSearchResult {
  /** Nullable, unlike `issue`: a branch that belongs to nothing is a null
   *  rather than an error. */
  readonly issueVcsBranchSearch: {
    readonly id: string;
    readonly identifier: string;
    readonly team: Ref;
    readonly state: { readonly id: string; readonly type: string };
  } | null;
}

export interface TeamAutomationResult {
  readonly team: {
    readonly id: string;
    readonly gitAutomationStates: Connection<{
      readonly id: string;
      readonly event: string;
      readonly state: { readonly id: string; readonly name: string } | null;
      readonly targetBranch: {
        readonly branchPattern: string;
        readonly isRegex: boolean;
      } | null;
    }>;
  };
}

export interface AttachmentsForUrlResult {
  readonly attachmentsForURL: {
    readonly nodes: readonly {
      readonly id: string;
      readonly url: string;
      readonly issue: { readonly id: string; readonly identifier: string } | null;
    }[];
  };
}

export interface AttachPullRequestResult {
  readonly attachmentLinkGitHubPR: {
    readonly success: boolean;
    readonly attachment: { readonly id: string; readonly url: string } | null;
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Breadth                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface BreadthResult {
  readonly projects: Connection<{
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly url: string;
    readonly startDate: string | null;
    readonly targetDate: string | null;
    readonly progress: number;
    readonly updatedAt: string;
    readonly status: Ref | null;
    readonly lead: Ref | null;
    readonly teams: { readonly nodes: readonly Ref[] };
    readonly projectMilestones: {
      readonly nodes: readonly {
        readonly id: string;
        readonly name: string;
        readonly targetDate: string | null;
        readonly sortOrder: number;
        readonly updatedAt: string;
      }[];
    };
  }>;
  readonly cycles: Connection<{
    readonly id: string;
    readonly number: number;
    readonly name: string | null;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly isActive: boolean;
    readonly isNext: boolean;
    readonly isPrevious: boolean;
    readonly updatedAt: string;
    readonly team: Ref;
  }>;
}

export interface IssueRelationsResult {
  readonly issue: {
    readonly id: string;
    readonly relations: {
      readonly nodes: readonly {
        readonly id: string;
        readonly type: string;
        readonly relatedIssue: { readonly id: string; readonly identifier: string } | null;
      }[];
    };
    readonly inverseRelations: {
      readonly nodes: readonly {
        readonly id: string;
        readonly type: string;
        readonly issue: { readonly id: string; readonly identifier: string } | null;
      }[];
    };
  };
}

export interface WebhookCreateResult {
  readonly webhookCreate: {
    readonly success: boolean;
    readonly webhook: {
      readonly id: string;
      readonly url: string | null;
      readonly enabled: boolean;
      readonly resourceTypes: readonly string[];
    } | null;
  };
}

export interface WebhookReadResult {
  readonly webhook: {
    readonly id: string;
    readonly url: string | null;
    readonly enabled: boolean;
    readonly teamIds: readonly string[] | null;
    readonly resourceTypes: readonly string[];
    readonly failures: readonly {
      readonly createdAt: string;
      readonly httpStatus: number | null;
    }[];
  };
}

export interface WebhookDeleteResult {
  readonly webhookDelete: { readonly success: boolean };
}

export interface IssueCreateResult {
  readonly issueCreate: { readonly success: boolean; readonly issue: IssueNode | null };
}

export interface IssueRelationCreateResult {
  readonly issueRelationCreate: {
    readonly success: boolean;
    readonly issueRelation: {
      readonly id: string;
      readonly type: string;
      readonly issue: { readonly id: string; readonly identifier: string } | null;
      readonly relatedIssue: { readonly id: string; readonly identifier: string } | null;
    } | null;
  };
}

export interface AttachmentLinkResult {
  readonly attachmentLinkURL: {
    readonly success: boolean;
    readonly attachment: {
      readonly id: string;
      readonly title: string | null;
      readonly subtitle: string | null;
      readonly url: string | null;
    } | null;
  };
}

export interface IssueArchiveResult {
  readonly issueArchive: { readonly success: boolean };
}

export interface SearchIssuesResult {
  readonly searchIssues: { readonly nodes: readonly IssueNode[] };
}
