import type { BudgetSnapshot } from "./budget.js";
import {
  BOOTSTRAP,
  COMMENT_CREATE,
  COMMENT_PAGE_SIZE,
  ISSUE_DETAIL,
  ISSUE_UPDATE,
  ISSUES_BACKFILL,
  ISSUES_EXIST,
  EXISTENCE_PAGE_SIZE,
  ISSUE_PAGE_SIZE,
  TICK,
  LABEL_PAGE_SIZE,
  MEMBER_PAGE_SIZE,
  ATTACHMENTS_FOR_URL,
  ATTACH_PULL_REQUEST,
  BRANCH_SEARCH,
  BREADTH,
  CUSTOM_VIEW_ISSUES,
  CYCLE_PAGE_SIZE,
  ISSUE_RELATIONS,
  MILESTONE_PAGE_SIZE,
  PROJECT_PAGE_SIZE,
  NOTIFICATIONS,
  NOTIFICATION_PAGE_SIZE,
  RELATED_PAGE_SIZE,
  STATE_PAGE_SIZE,
  ATTACHMENT_LINK,
  ISSUE_ARCHIVE,
  ISSUE_CREATE,
  ISSUE_RELATION_CREATE,
  SEARCH_ISSUES,
  SEARCH_PAGE_SIZE,
  TEAM_AUTOMATION,
  WEBHOOK_CREATE,
  WEBHOOK_DELETE,
  WEBHOOK_READ,
  TEAM_GRAPH,
  TEAM_MEMBERS,
  TEAM_MEMBER_PAGE,
  TEAM_MEMBER_TEAMS,
  TEAM_PAGE_SIZE,
  VIEWER,
} from "./documents.js";
import { mutationFailed } from "./errors.js";
import {
  createTransport,
  type BreakerView,
  type ExecuteOptions,
  type LinearTransport,
  type TransportOptions,
  type TransportSession,
} from "./transport.js";
import type {
  AttachmentsForUrlResult,
  AttachPullRequestResult,
  BootstrapResult,
  BranchSearchResult,
  BreadthResult,
  IssueRelationsResult,
  CommentCreateResult,
  IssueDetailResult,
  IssuesResult,
  IssueUpdateResult,
  TeamGraphResult,
  NotificationsResult,
  AttachmentLinkResult,
  IssueArchiveResult,
  IssueCreateResult,
  IssueRelationCreateResult,
  SearchIssuesResult,
  TeamAutomationResult,
  WebhookCreateResult,
  WebhookDeleteResult,
  WebhookReadResult,
  TickResult,
  ViewerResult,
} from "./types.js";

/**
 * The seam every test in this repository leans on.
 *
 * `server.ts` takes a `LinearClientFactory` and calls it once per load with a
 * session — a credential getter, a budget sink, a logger, a lifetime signal.
 * The default factory builds the real transport; a test passes a factory that
 * returns hand-written answers, and nothing below it ever opens a socket.
 *
 * The factory shape rather than a ready-made client, because a client needs
 * the credential *getter* the plugin owns, and constructing it at module scope
 * would mean holding plugin state across a reload — which is the one thing the
 * host's lifecycle punishes hardest.
 */
export interface LinearClient {
  /** Whose key is this, and which workspace does it reach? The single query
   *  the Connection section runs. */
  verify(options?: CallOptions): Promise<ViewerResult>;

  /** The slow-moving graph: the viewer, the workspace, its project statuses,
   *  its priority vocabulary, and one page of teams. */
  bootstrap(after: string | null, options?: CallOptions): Promise<BootstrapResult>;

  /** The bound teams' own vocabulary — states, labels, assignable people —
   *  for every bound team in one request rather than one request per team. */
  teamGraph(teamIds: readonly string[], options?: CallOptions): Promise<TeamGraphResult>;

  /** Who can be assigned, per team. Separate from `teamGraph` because nesting
   *  it there costs teams × members objects on a query that already reads
   *  three connections. */
  teamMembers(
    teamIds: readonly string[],
    options?: CallOptions,
  ): Promise<{
    teams: {
      nodes: readonly {
        id: string;
        members: { nodes: readonly { id: string }[]; pageInfo: { hasNextPage: boolean } };
      }[];
    };
  }>;

  /** One page of open issues for the bound teams. */
  backfillIssues(
    teamIds: readonly string[],
    after: string | null,
    options?: CallOptions,
  ): Promise<IssuesResult>;

  /** Which of these issue ids does Linear still have? A liveness probe for
   *  the reconcile: it tells a closed issue apart from a deleted one. */
  issuesExist(
    ids: readonly string[],
    options?: CallOptions,
  ): Promise<{ issues: { nodes: readonly { id: string }[] } }>;

  /** One issue with everything the detail pane and a spawned thread need.
   *  Deliberately the same document for both, so the spawn path — the one
   *  nobody exercises until it matters — cannot drift from the one that is
   *  exercised constantly. */
  issueDetail(id: string, options?: CallOptions): Promise<IssueDetailResult>;

  /** Patch an issue. `input` is built by `buildIssueUpdateInput`, which never
   *  emits `labelIds`. */
  updateIssue(
    id: string,
    input: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<IssueUpdateResult>;

  /** Post a comment. `input.id` is a client-generated UUID, which is what
   *  makes a deliberate retry idempotent. */
  createComment(
    input: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<CommentCreateResult>;

  /** One tick: the batched delta for every bound team, in one request.
   *  Variables come from `planTick`, which is where the page sizes and the
   *  shard decision live. */
  tick(variables: Record<string, unknown>, options?: CallOptions): Promise<TickResult>;

  /** The viewer's own Linear inbox, on its own cursor and its own clock. */
  notifications(since: string, options?: CallOptions): Promise<NotificationsResult>;

  /** Projects, their milestones, and the bound teams' cycles. */
  breadth(teamIds: readonly string[], options?: CallOptions): Promise<BreadthResult>;

  /** One issue's relations, both directions. */
  relations(issueId: string, options?: CallOptions): Promise<IssueRelationsResult>;

  /** Run a saved view **server-side at Linear** — `filterData` is opaque and
   *  reimplementing the filter is not an option. */
  customViewIssues(
    id: string,
    after: string | null,
    options?: CallOptions,
  ): Promise<{ customView: { id: string; name: string; issues: { nodes: readonly unknown[] } } }>;

  /** Linear's own branch resolver. Nullable. */
  branchSearch(branchName: string, options?: CallOptions): Promise<BranchSearchResult>;

  /** The team's git automation — Linear's own configuration of exactly this
   *  automation. */
  teamAutomation(teamId: string, options?: CallOptions): Promise<TeamAutomationResult>;

  attachmentsForUrl(url: string, options?: CallOptions): Promise<AttachmentsForUrlResult>;

  attachPullRequest(
    input: { issueId: string; url: string; title: string },
    options?: CallOptions,
  ): Promise<AttachPullRequestResult>;

  /** Create an issue. `input.teamId` decides which team it lands in, and the
   *  caller has already checked that team is in scope. */
  createIssue(input: Record<string, unknown>, options?: CallOptions): Promise<IssueCreateResult>;

  /** Relate two issues. Direction is which id is which. */
  createRelation(
    input: { issueId: string; relatedIssueId: string; type: string },
    options?: CallOptions,
  ): Promise<IssueRelationCreateResult>;

  /** Link any URL to an issue, richly where Linear recognises it. */
  linkUrl(
    input: { issueId: string; url: string; title: string | null },
    options?: CallOptions,
  ): Promise<AttachmentLinkResult>;

  /** Archive — reversible — never delete. */
  archiveIssue(id: string, options?: CallOptions): Promise<IssueArchiveResult>;

  /** Linear's own search, for what the mirror does not hold. Rate limited to
   *  30 requests a minute, separately from the hourly budget. */
  searchIssues(
    term: string,
    teamIds: readonly string[],
    options?: CallOptions,
  ): Promise<SearchIssuesResult>;

  /** One webhook per bound team — `WebhookCreateInput.teamId` is singular. */
  createWebhook(
    input: { url: string; teamId: string; secret: string; resourceTypes: readonly string[]; label: string },
    options?: CallOptions,
  ): Promise<WebhookCreateResult>;

  readWebhook(id: string, options?: CallOptions): Promise<WebhookReadResult>;

  deleteWebhook(id: string, options?: CallOptions): Promise<WebhookDeleteResult>;

  budget(): BudgetSnapshot | null;
  breaker(): BreakerView;
}

export interface CallOptions {
  readonly initiator?: "background" | "user";
  readonly signal?: AbortSignal;
}

export type LinearClientFactory = (
  session: TransportSession,
  options?: TransportOptions,
) => LinearClient;

function call(options: CallOptions | undefined, variables?: Record<string, unknown>): ExecuteOptions {
  return {
    initiator: options?.initiator ?? "user",
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(variables ? { variables } : {}),
  };
}

export const createLinearClient: LinearClientFactory = (session, options) => {
  const transport: LinearTransport = createTransport(session, options ?? {});

  return {
    verify: (callOptions) => transport.execute<ViewerResult>(VIEWER, call(callOptions)),

    bootstrap: (after, callOptions) =>
      transport.execute<BootstrapResult>(
        BOOTSTRAP,
        call(callOptions, { teams: TEAM_PAGE_SIZE, after }),
      ),

    teamGraph: (teamIds, callOptions) =>
      transport.execute<TeamGraphResult>(
        TEAM_GRAPH,
        call(callOptions, {
          teamIds: [...teamIds],
          states: STATE_PAGE_SIZE,
          labels: LABEL_PAGE_SIZE,
          users: MEMBER_PAGE_SIZE,
        }),
      ),

    teamMembers: (teamIds, callOptions) =>
      transport.execute(
        TEAM_MEMBERS,
        call(callOptions, {
          teamIds: [...teamIds],
          teams: TEAM_MEMBER_TEAMS,
          members: TEAM_MEMBER_PAGE,
        }),
      ),

    backfillIssues: (teamIds, after, callOptions) =>
      transport.execute<IssuesResult>(
        ISSUES_BACKFILL,
        call(callOptions, { teamIds: [...teamIds], first: ISSUE_PAGE_SIZE, after }),
      ),

    issuesExist: (ids, callOptions) =>
      transport.execute<{ issues: { nodes: readonly { id: string }[] } }>(
        ISSUES_EXIST,
        call(callOptions, { ids: [...ids], first: EXISTENCE_PAGE_SIZE }),
      ),

    issueDetail: (id, callOptions) =>
      transport.execute<IssueDetailResult>(
        ISSUE_DETAIL,
        call(callOptions, { id, comments: COMMENT_PAGE_SIZE, related: RELATED_PAGE_SIZE }),
      ),

    updateIssue: (id, input, callOptions) =>
      transport.execute<IssueUpdateResult>(ISSUE_UPDATE, call(callOptions, { id, input })),

    createComment: (input, callOptions) =>
      transport.execute<CommentCreateResult>(COMMENT_CREATE, call(callOptions, { input })),

    tick: (variables, callOptions) =>
      transport.execute<TickResult>(TICK, call(callOptions, variables)),

    notifications: (since, callOptions) =>
      transport.execute<NotificationsResult>(
        NOTIFICATIONS,
        call(callOptions, { since, first: NOTIFICATION_PAGE_SIZE }),
      ),

    breadth: (teamIds, callOptions) =>
      transport.execute<BreadthResult>(
        BREADTH,
        call(callOptions, {
          teamIds: [...teamIds],
          projects: PROJECT_PAGE_SIZE,
          cycles: CYCLE_PAGE_SIZE,
          milestones: MILESTONE_PAGE_SIZE,
        }),
      ),

    relations: (issueId, callOptions) =>
      transport.execute<IssueRelationsResult>(
        ISSUE_RELATIONS,
        call(callOptions, { id: issueId, first: 20 }),
      ),

    customViewIssues: (id, after, callOptions) =>
      transport.execute(
        CUSTOM_VIEW_ISSUES,
        call(callOptions, { id, first: ISSUE_PAGE_SIZE, after }),
      ),

    branchSearch: (branchName, callOptions) =>
      transport.execute<BranchSearchResult>(BRANCH_SEARCH, call(callOptions, { branchName })),

    teamAutomation: (teamId, callOptions) =>
      transport.execute<TeamAutomationResult>(
        TEAM_AUTOMATION,
        call(callOptions, { teamId, first: 20 }),
      ),

    attachmentsForUrl: (url, callOptions) =>
      transport.execute<AttachmentsForUrlResult>(
        ATTACHMENTS_FOR_URL,
        call(callOptions, { url, first: 10 }),
      ),

    attachPullRequest: (input, callOptions) =>
      transport.execute<AttachPullRequestResult>(ATTACH_PULL_REQUEST, call(callOptions, input)),

    createIssue: (input, callOptions) =>
      transport.execute<IssueCreateResult>(ISSUE_CREATE, call(callOptions, { input })),

    createRelation: (input, callOptions) =>
      transport.execute<IssueRelationCreateResult>(
        ISSUE_RELATION_CREATE,
        call(callOptions, { input }),
      ),

    linkUrl: (input, callOptions) =>
      transport.execute<AttachmentLinkResult>(
        ATTACHMENT_LINK,
        call(callOptions, { issueId: input.issueId, url: input.url, title: input.title }),
      ),

    archiveIssue: (id, callOptions) =>
      transport.execute<IssueArchiveResult>(ISSUE_ARCHIVE, call(callOptions, { id })),

    searchIssues: (term, teamIds, callOptions) =>
      transport.execute<SearchIssuesResult>(
        SEARCH_ISSUES,
        call(callOptions, { term, first: SEARCH_PAGE_SIZE, teamIds: [...teamIds] }),
      ),

    createWebhook: (input, callOptions) =>
      transport.execute<WebhookCreateResult>(
        WEBHOOK_CREATE,
        call(callOptions, {
          input: {
            url: input.url,
            teamId: input.teamId,
            secret: input.secret,
            resourceTypes: [...input.resourceTypes],
            label: input.label,
            enabled: true,
          },
        }),
      ),

    readWebhook: (id, callOptions) =>
      transport.execute<WebhookReadResult>(WEBHOOK_READ, call(callOptions, { id })),

    deleteWebhook: (id, callOptions) =>
      transport.execute<WebhookDeleteResult>(WEBHOOK_DELETE, call(callOptions, { id })),

    budget: () => transport.budget(),
    breaker: () => transport.breaker(),
  };
};

/**
 * Unwrap a Linear mutation payload.
 *
 * Every Linear mutation returns `{ success: Boolean!, <entity> }`, and
 * **`success: false` with no `errors` array is a real response** — HTTP 200,
 * no GraphQL errors, nothing written. A client that only inspects
 * `body.errors` reports success and the issue never moves, which is the
 * quietest possible failure and the one users report as "sometimes it just
 * doesn't work".
 *
 * A null entity is treated the same way: a payload that says it succeeded but
 * hands back nothing has not done what was asked either.
 */
export function unwrapMutation<T>(
  payload: { success?: boolean } & Record<string, unknown>,
  entityKey: string,
  what: string,
): T {
  if (payload.success === false) {
    throw mutationFailed(`Linear didn't ${what}.`);
  }
  const entity = payload[entityKey];
  if (entity === null || entity === undefined) {
    throw mutationFailed(`Linear said it would ${what} but returned nothing.`);
  }
  return entity as T;
}
