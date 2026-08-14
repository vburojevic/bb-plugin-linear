/**
 * Every GraphQL document this plugin sends, as plain strings, in one file.
 *
 * Plain strings rather than a client library's builders because the offline
 * verification plan depends on it: `test/documents.test.ts` walks this
 * registry, parses each source and validates it against the checked-in SDL, so
 * a wrong field name, a wrong argument type or a nullable read as non-null
 * fails in milliseconds on a laptop with no Linear workspace. That test is the
 * entire reason a hand-written GraphQL client is a defensible choice here, and
 * it only works if the documents are inspectable text.
 *
 * Two rules hold for every document below, and both are asserted by tests:
 *
 *   1. **Every connection carries an explicit `first:`, including inner ones.**
 *      An omitted `first:` bills as 50 and nested connections multiply, so one
 *      forgotten argument on an inner selection is a 50× cost multiplier on
 *      everything beneath it.
 *   2. **No shipped document reads a `@deprecated` field.** Linear leaves
 *      deprecated fields in place and working, which is exactly what makes
 *      them easy to adopt and expensive to have adopted.
 */

export interface LinearDocument {
  /** The GraphQL operation name. Also the log and diagnostic label. */
  readonly name: string;
  readonly kind: "query" | "mutation";
  readonly source: string;
  /**
   * Page-size variables, resolved for the complexity estimate. A document that
   * paginates through `first: $n` cannot be costed without knowing what `$n`
   * will be, and guessing Linear's default of 50 would under-report every
   * document that asks for more.
   */
  readonly pageSizes?: Readonly<Record<string, number>>;
}

const registry: LinearDocument[] = [];

function doc(
  name: string,
  kind: LinearDocument["kind"],
  source: string,
  pageSizes: Readonly<Record<string, number>> = {},
): LinearDocument {
  const document: LinearDocument = { name, kind, source, pageSizes };
  registry.push(document);
  return document;
}

/** Every document, for the validation and complexity tests to walk. */
export const DOCUMENTS: readonly LinearDocument[] = registry;

/* ────────────────────────────────────────────────────────────────────────── */
/* Identity                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The one query that answers "does this key work, and whose is it?".
 *
 * It reads `organization` because the Connection section's whole job is to
 * name the workspace a key belongs to — a user with two Linear accounts pastes
 * the wrong key roughly once, and "Connected as Ada Lovelace in Acme" is what
 * turns that into a two-second fix instead of a puzzling empty panel.
 *
 * `gitBranchFormat` comes along because it is free here and expensive later:
 * it is what makes the plugin's branch-name explanations match the workspace's
 * own convention instead of a guess.
 */
export const VIEWER = doc(
  "Viewer",
  "query",
  `query Viewer {
  viewer {
    id
    name
    displayName
    email
    avatarUrl
    organization {
      id
      name
      urlKey
      gitBranchFormat
    }
  }
}`,
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Discovery                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** One page of teams. 100 covers the overwhelming majority of workspaces in a
 *  single request, and the cursor covers the rest. */
export const TEAM_PAGE_SIZE = 100;

/**
 * The slow-moving graph, fetched the moment a key verifies.
 *
 * `teams`, not `administrableTeams`. The SDL says `teams` returns "All teams
 * whose issues the user can access", while `administrableTeams` returns teams
 * whose *settings* the user can change but whose issues they may not see —
 * binding from the wrong one gives a large organisation a picker full of teams
 * that then return nothing.
 *
 * `issuePriorityValues` is fetched once so priority labels are the workspace's
 * own strings, in the workspace's own language, forever. Five English
 * constants compiled into a plugin are five strings that are wrong for
 * everyone who did not write it.
 */
export const BOOTSTRAP = doc(
  "Bootstrap",
  "query",
  `query Bootstrap($teams: Int!, $after: String) {
  viewer {
    id
    name
    displayName
    email
    avatarUrl
    organization {
      id
      name
      urlKey
      gitBranchFormat
      projectStatuses {
        id
        name
        type
        position
        color
      }
    }
  }
  issuePriorityValues {
    priority
    label
  }
  teams(first: $teams, after: $after) {
    nodes {
      id
      key
      name
      icon
      color
      parent {
        id
      }
      issueEstimationType
      issueEstimationAllowZero
      issueEstimationExtended
      defaultIssueEstimate
      cyclesEnabled
      triageEnabled
      activeCycle {
        id
      }
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
  { teams: TEAM_PAGE_SIZE },
);

export const STATE_PAGE_SIZE = 100;
export const LABEL_PAGE_SIZE = 150;
export const MEMBER_PAGE_SIZE = 250;

/**
 * The bound teams' own vocabulary: their workflow states, their labels, and
 * the people who can be assigned.
 *
 * One aliased document rather than three requests, and one document for *all*
 * bound teams rather than one per team — requests are the scarce resource, and
 * a forty-team organisation should not cost forty round trips to learn what
 * its columns are called.
 *
 * The label filter is an `or` over "belongs to a bound team" and "belongs to
 * no team at all", because **`IssueLabel.team == null` means workspace-level,
 * not orphaned**. A picker that dropped those would be missing exactly the
 * labels an organisation standardised on. (`IssueLabel.organization` would
 * also identify them and is deprecated for saying so: "Workspace labels are
 * identified by their team being null.")
 */
export const TEAM_GRAPH = doc(
  "TeamGraph",
  "query",
  `query TeamGraph($teamIds: [ID!]!, $states: Int!, $labels: Int!, $users: Int!) {
  workflowStates(first: $states, filter: { team: { id: { in: $teamIds } } }) {
    nodes {
      id
      name
      type
      color
      position
      description
      team {
        id
      }
    }
    pageInfo {
      hasNextPage
    }
  }
  issueLabels(
    first: $labels
    filter: { or: [{ team: { id: { in: $teamIds } } }, { team: { null: true } }] }
  ) {
    nodes {
      id
      name
      color
      isGroup
      updatedAt
      parent {
        id
      }
      team {
        id
      }
    }
    pageInfo {
      hasNextPage
    }
  }
  users(first: $users, filter: { active: { eq: true } }) {
    nodes {
      id
      name
      displayName
      email
      avatarUrl
      active
      app
      isMe
    }
    pageInfo {
      hasNextPage
    }
  }
}`,
  { states: STATE_PAGE_SIZE, labels: LABEL_PAGE_SIZE, users: MEMBER_PAGE_SIZE },
);

export const TEAM_MEMBER_TEAMS = 10;
export const TEAM_MEMBER_PAGE = 100;

/**
 * Who can actually be assigned, per team.
 *
 * Its own document rather than a field on `TeamGraph`, because nesting it
 * there costs `teams × members` objects on a query that already reads three
 * other connections — 29,434 points against a 8,000 budget, which the
 * complexity test caught before a single request was made.
 *
 * The workspace-wide user list is still the right source for *rendering* an
 * assignee somebody else set: a former team member still has a name. This is
 * for the assignee *picker*, where Linear refuses issueUpdate with "not a
 * member" for anyone outside the team — so offering them is offering a choice
 * that fails.
 *
 * Ten teams and a hundred members each is 1,000 objects and covers the
 * overwhelming majority. Past that the picker falls back to the workspace
 * list, which is what it did before this existed.
 */
export const TEAM_MEMBERS = doc(
  "TeamMembers",
  "query",
  `query TeamMembers($teamIds: [ID!]!, $teams: Int!, $members: Int!) {
  teams(first: $teams, filter: { id: { in: $teamIds } }) {
    nodes {
      id
      members(first: $members) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
        }
      }
    }
    pageInfo {
      hasNextPage
    }
  }
}`,
  { teams: TEAM_MEMBER_TEAMS, members: TEAM_MEMBER_PAGE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Issues                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export const ISSUE_PAGE_SIZE = 100;

/**
 * Every issue read selects exactly this.
 *
 * **Flattened, not nested.** `labelIds: [String!]!` rather than
 * `labels { nodes { … } }`, and `{ id }` rather than an expanded relation
 * everywhere else: a connection multiplies the cost of everything beneath it
 * by its page size, and the names are already in the mirror's own label,
 * member and state tables.
 *
 * `branchName` — **not `gitBranchName`, which appears zero times in the whole
 * schema**. Writing the wrong one fails the query with an unknown-field error,
 * and `test/documents.test.ts` catches it offline before CI ever needs a
 * workspace.
 */
const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id
  identifier
  number
  title
  description
  url
  branchName
  priority
  estimate
  dueDate
  sortOrder
  subIssueSortOrder
  labelIds
  previousIdentifiers
  startedAt
  completedAt
  canceledAt
  triagedAt
  archivedAt
  createdAt
  updatedAt
  team {
    id
  }
  state {
    id
  }
  assignee {
    id
  }
  creator {
    id
  }
  project {
    id
  }
  projectMilestone {
    id
  }
  cycle {
    id
  }
  parent {
    id
  }
}`;

/**
 * The first-run backfill: **open issues only, and no history.**
 *
 * `state: { type: { nin: ["completed", "canceled"] } }` and a hard cap of five
 * page-walks. Fetching five years of closed issues to fill a sidebar is the
 * behaviour that gets a plugin uninstalled — it spends a stranger's whole
 * hourly budget on their first afternoon, to populate a list nobody scrolls
 * to the bottom of.
 *
 * `orderBy: updatedAt` so the rows that arrive first are the ones somebody
 * touched most recently, which is what the panel shows above the fold.
 */
export const ISSUES_BACKFILL = doc(
  "IssuesBackfill",
  "query",
  `query IssuesBackfill($teamIds: [ID!]!, $first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    orderBy: updatedAt
    filter: {
      team: { id: { in: $teamIds } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    nodes {
      ...IssueFields
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}

${ISSUE_FIELDS}`,
  { first: ISSUE_PAGE_SIZE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* One issue                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export const COMMENT_PAGE_SIZE = 20;
export const RELATED_PAGE_SIZE = 20;

/**
 * Everything the detail pane shows, and everything a thread spawned from an
 * issue needs, in **one** query.
 *
 * Deliberately the same document for both. The alternative — a lighter query
 * for the panel and a richer one for the spawn — means two documents that
 * drift, and the spawn path is the one nobody exercises until it matters.
 *
 * `issue(id: String!): Issue!` is **non-nullable** and accepts a UUID *or* a
 * human identifier. Two consequences, both handled at the call site rather
 * than here: a missing issue is a GraphQL **error**, not a null, so
 * `if (!data.issue)` will never fire; and a user-typed string can silently
 * resolve to something real, so anything about to mutate validates the team
 * first.
 *
 * `comments(first: 20)` is one connection page, which covers the overwhelming
 * majority of issues; older comments load on demand rather than making every
 * open of every issue pay for the rare thread with two hundred replies.
 */
export const ISSUE_DETAIL = doc(
  "IssueDetail",
  "query",
  `query IssueDetail($id: String!, $comments: Int!, $related: Int!) {
  issue(id: $id) {
    ...IssueFields
    priorityLabel
    children(first: $related) {
      nodes {
        id
        identifier
        title
        state {
          id
          type
        }
      }
    }
    comments(first: $comments) {
      nodes {
        id
        body
        url
        createdAt
        updatedAt
        editedAt
        resolvedAt
        user {
          id
        }
        parent {
          id
        }
      }
      pageInfo {
        hasNextPage
      }
    }
    team {
      id
      key
      name
      issueEstimationType
    }
  }
}

${ISSUE_FIELDS}`,
  { comments: COMMENT_PAGE_SIZE, related: RELATED_PAGE_SIZE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Writes                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The one write path for an issue's fields.
 *
 * **Labels move through `addedLabelIds` / `removedLabelIds`, never
 * `labelIds`.** `labelIds` replaces the entire set, so a patch built from a
 * read taken thirty seconds ago silently deletes any label somebody added in
 * between — and the user who lost it has no way to know it happened. A test
 * asserts the built variables never carry `labelIds`.
 *
 * The mutation returns the updated entity, which goes straight into the `echo`
 * table so the next tick sees its own write and does not notify the user about
 * a change the user just made.
 */
export const ISSUE_UPDATE = doc(
  "IssueUpdate",
  "mutation",
  `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      ...IssueFields
    }
  }
}

${ISSUE_FIELDS}`,
);

/**
 * A comment, with a **client-generated `id`** for create-once semantics.
 *
 * Linear accepts an `id` on the input; supplying one means a retry — a network
 * blip, a user double-click — resolves to the same comment instead of two.
 * Mutations are never retried automatically by the transport for exactly this
 * reason, and this is what makes a *deliberate* retry safe.
 */
export const COMMENT_CREATE = doc(
  "CommentCreate",
  "mutation",
  `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      url
      createdAt
      updatedAt
      editedAt
      resolvedAt
      user {
        id
      }
      parent {
        id
      }
      issue {
        id
      }
    }
  }
}`,
);

/* ────────────────────────────────────────────────────────────────────────── */
/* The tick                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export const TICK_ISSUE_PAGE_SIZE = 100;
export const TICK_COMMENT_PAGE_SIZE = 50;

/**
 * **One tick is one HTTP request.**
 *
 * Requests are the scarce resource, not complexity: a personal API key gets
 * 2,500 requests an hour against 3,000,000 complexity points, so a tick that
 * batches its lanes into one aliased document costs a fraction as much of the
 * thing that actually runs out. Two separate queries would double the poll
 * cost of every bound workspace for no benefit at all.
 *
 * Four rules hold here and each has cost somebody an afternoon somewhere:
 *
 * **`includeArchived: true`.** The default is false, so archiving is
 * indistinguishable from deletion to a delta poller: the row silently stops
 * appearing and the mirror keeps a ghost forever.
 *
 * **Comments get their own cursor.** Whether commenting bumps
 * `Issue.updatedAt` is not documented and could not be verified offline
 * (`docs/smoke.md`, item 11). Automation 3 depends on seeing comments, so the
 * plugin polls them on a separate watermark rather than betting on it — which
 * is correct under either answer.
 *
 * **Explicit `first:` on every connection, including `pageInfo`'s parent.** An
 * omitted `first:` bills as 50 and nested connections multiply.
 *
 * **Flattened selections.** `labelIds` rather than `labels { nodes }`, `{ id }`
 * rather than an expanded relation: the names are already in the mirror.
 */
export const TICK = doc(
  "Tick",
  "query",
  `query Tick(
  $teamIds: [ID!]!
  $issuesSince: DateTimeOrDuration!
  $commentsSince: DateTimeOrDuration!
  $issues: Int!
  $comments: Int!
) {
  issues(
    first: $issues
    orderBy: updatedAt
    includeArchived: true
    filter: { team: { id: { in: $teamIds } }, updatedAt: { gt: $issuesSince } }
  ) {
    nodes {
      ...IssueFields
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
  comments(
    first: $comments
    orderBy: updatedAt
    filter: {
      issue: { team: { id: { in: $teamIds } } }
      updatedAt: { gt: $commentsSince }
    }
  ) {
    nodes {
      id
      body
      url
      createdAt
      updatedAt
      editedAt
      resolvedAt
      user {
        id
      }
      parent {
        id
      }
      issue {
        id
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}

${ISSUE_FIELDS}`,
  { issues: TICK_ISSUE_PAGE_SIZE, comments: TICK_COMMENT_PAGE_SIZE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Notifications                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export const NOTIFICATION_PAGE_SIZE = 50;

/**
 * The viewer's own Linear inbox — **not** issue diffing.
 *
 * Diffing `assigneeId` across polls fails three ways that will bite a
 * stranger: it misses assign → unassign → reassign inside one tick, it fires
 * on the plugin's own mutations, and it cannot see mentions or comments at
 * all. `notifications` is Linear's own deduplicated, grouped event log,
 * available to a plain personal API key, with a stable `id` and a
 * `groupingKey` per row.
 *
 * **`NotificationFilter` has no `readAt` or `snoozedUntilAt` comparator** —
 * verified against the SDL, whose members are exactly `and`, `or`,
 * `archivedAt`, `createdAt`, `updatedAt`, `id`, `type` and `subscriptionType`.
 * So unread cannot be filtered server-side: this fetches by `createdAt`
 * watermark and evaluates `readAt` / `snoozedUntilAt` locally at send time,
 * which is where the suppression rules belong anyway.
 *
 * `team`, `issueId`, `commentId` and `parentCommentId` come off
 * `IssueNotification` itself, so team scoping and dedupe cost no second query.
 */
export const NOTIFICATIONS = doc(
  "Notifications",
  "query",
  `query Notifications($since: DateTimeOrDuration!, $first: Int!) {
  notifications(
    first: $first
    orderBy: createdAt
    filter: { createdAt: { gt: $since } }
  ) {
    nodes {
      id
      type
      category
      groupingKey
      createdAt
      readAt
      snoozedUntilAt
      inboxUrl
      title
      subtitle
      issueStatusType
      actor {
        id
      }
      ... on IssueNotification {
        issueId
        commentId
        parentCommentId
        team {
          id
        }
        issue {
          id
          identifier
          title
          updatedAt
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
  { first: NOTIFICATION_PAGE_SIZE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Pull requests                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Which issue does this branch belong to?
 *
 * **Linear's own resolver**, which already understands the workspace's
 * `gitBranchFormat`, its magic-word suffixes and any custom convention. Do not
 * write a `[A-Z]+-\d+` regex as the first attempt — the regex exists only as a
 * fallback for when this returns null, and its result is recorded as a less
 * confident `regex` resolution.
 *
 * `issueVcsBranchSearch` is **nullable**, unlike `issue`, so a branch that
 * belongs to nothing is a null rather than an error.
 */
export const BRANCH_SEARCH = doc(
  "BranchSearch",
  "query",
  `query BranchSearch($branchName: String!) {
  issueVcsBranchSearch(branchName: $branchName) {
    id
    identifier
    team {
      id
    }
    state {
      id
      type
    }
  }
}`,
);

/**
 * The team's git automation — *Linear's own configuration of exactly this
 * automation*, including per-target-branch variants.
 *
 * Never `Team.{start,review,merge,mergeable,draft}WorkflowState`: the SDL
 * deprecates all five with "Use team.gitAutomationStates instead", and the
 * document validation test fails on any deprecated read.
 */
export const TEAM_AUTOMATION = doc(
  "TeamAutomation",
  "query",
  `query TeamAutomation($teamId: String!, $first: Int!) {
  team(id: $teamId) {
    id
    gitAutomationStates(first: $first) {
      nodes {
        id
        event
        state {
          id
          name
        }
        targetBranch {
          branchPattern
          isRegex
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
}`,
  { first: 20 },
);

/**
 * Has this pull request already been linked to an issue?
 *
 * The correct probe, and cheap: it answers **across issues**, so it catches
 * the case that matters — Linear's own GitHub integration having already
 * linked the pull request, possibly to a different issue — which
 * `attachmentCreate`'s documented idempotency on `(issueId, url)` cannot.
 */
export const ATTACHMENTS_FOR_URL = doc(
  "AttachmentsForUrl",
  "query",
  `query AttachmentsForUrl($url: String!, $first: Int!) {
  attachmentsForURL(url: $url, first: $first) {
    nodes {
      id
      url
      issue {
        id
        identifier
      }
    }
  }
}`,
  { first: 10 },
);

export const ATTACH_PULL_REQUEST = doc(
  "AttachPullRequest",
  "mutation",
  `mutation AttachPullRequest($issueId: String!, $url: String!, $title: String!) {
  attachmentLinkGitHubPR(issueId: $issueId, url: $url, title: $title) {
    success
    attachment {
      id
      url
    }
  }
}`,
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Breadth                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export const PROJECT_PAGE_SIZE = 50;
export const CYCLE_PAGE_SIZE = 20;
export const MILESTONE_PAGE_SIZE = 20;

/**
 * Projects, their milestones, and the bound teams' cycles.
 *
 * **`Cycle.isActive` / `isNext` / `isPrevious` rather than date arithmetic.**
 * Linear's own answer accounts for the team's cycle configuration; comparing
 * `startsAt` and `endsAt` against a local clock reimplements it badly and
 * disagrees across a timezone.
 *
 * Projects are workspace-level and belong to many teams, so `teams` comes back
 * with each one — a project two teams share must appear on both boards.
 */
export const BREADTH = doc(
  "Breadth",
  "query",
  `query Breadth($teamIds: [ID!]!, $projects: Int!, $cycles: Int!, $milestones: Int!) {
  projects(first: $projects, filter: { accessibleTeams: { id: { in: $teamIds } } }) {
    nodes {
      id
      name
      description
      url
      startDate
      targetDate
      progress
      updatedAt
      status {
        id
      }
      lead {
        id
      }
      teams(first: 20) {
        nodes {
          id
        }
      }
      projectMilestones(first: $milestones) {
        nodes {
          id
          name
          targetDate
          sortOrder
          updatedAt
        }
      }
    }
    pageInfo {
      hasNextPage
    }
  }
  cycles(first: $cycles, filter: { team: { id: { in: $teamIds } } }) {
    nodes {
      id
      number
      name
      startsAt
      endsAt
      isActive
      isNext
      isPrevious
      updatedAt
      team {
        id
      }
    }
    pageInfo {
      hasNextPage
    }
  }
}`,
  { projects: PROJECT_PAGE_SIZE, cycles: CYCLE_PAGE_SIZE, milestones: MILESTONE_PAGE_SIZE },
);

/**
 * One issue's relations, both directions.
 *
 * `relations` is what this issue declares; `inverseRelations` is what declares
 * something about it — and "blocked by" lives in the inverse direction, which
 * is the half a naive implementation misses.
 *
 * **Sub-issues are not relations.** A parent/child link lives on
 * `Issue.parent`, and treating the two as one produces a "blocked by" line
 * pointing at a sub-issue.
 */
export const ISSUE_RELATIONS = doc(
  "IssueRelations",
  "query",
  `query IssueRelations($id: String!, $first: Int!) {
  issue(id: $id) {
    id
    relations(first: $first) {
      nodes {
        id
        type
        relatedIssue {
          id
          identifier
        }
      }
    }
    inverseRelations(first: $first) {
      nodes {
        id
        type
        issue {
          id
          identifier
        }
      }
    }
  }
}`,
  { first: 20 },
);

/**
 * Run a saved view **server-side at Linear**.
 *
 * A custom view's `filterData` is an opaque `JSONObject` in Linear's internal
 * dialect — *not* an `IssueFilter` — so the only correct way to resolve a view
 * is to ask Linear to run it. A test asserts no `filterData` read exists
 * anywhere in `src/`.
 */
export const CUSTOM_VIEW_ISSUES = doc(
  "CustomViewIssues",
  "query",
  `query CustomViewIssues($id: String!, $first: Int!, $after: String) {
  customView(id: $id) {
    id
    name
    issues(first: $first, after: $after) {
      nodes {
        ...IssueFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}

${ISSUE_FIELDS}`,
  { first: ISSUE_PAGE_SIZE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Webhooks                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * **`teamId` is singular.** There is no `teamIds` on the input, and
 * `WebhookUpdateInput` cannot change team scope at all — so this is one
 * webhook per bound team, and re-scoping is delete-then-create.
 *
 * `allPublicTeams` exists on the input and is **never used**: it would haul
 * other teams' data into the mirror and contradict the entire scoping promise.
 *
 * `secret` is supplied rather than generated by Linear, so the same value can
 * be stored locally before the first delivery arrives. `resourceTypes` is
 * required and is exactly what `classify()` and `apply()` consume.
 */
export const WEBHOOK_CREATE = doc(
  "WebhookCreate",
  "mutation",
  `mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) {
    success
    webhook {
      id
      url
      enabled
      resourceTypes
    }
  }
}`,
);

/**
 * Health, checked every five minutes in webhook mode.
 *
 * `failures` newer than the last success, or `enabled: false`, means Linear
 * has given up — it retries a delivery at most three times, after 1 minute, 1
 * hour and 6 hours, and then disables the webhook, with no replay API. The
 * plugin demotes itself to polling and says one sentence. **A healthy webhook
 * produces no row at all.**
 */
export const WEBHOOK_READ = doc(
  "WebhookRead",
  "query",
  `query WebhookRead($id: String!) {
  webhook(id: $id) {
    id
    url
    enabled
    teamIds
    resourceTypes
    failures {
      createdAt
      httpStatus
    }
  }
}`,
);

export const WEBHOOK_DELETE = doc(
  "WebhookDelete",
  "mutation",
  `mutation WebhookDelete($id: String!) {
  webhookDelete(id: $id) {
    success
  }
}`,
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Creating and connecting                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Create an issue.
 *
 * Returns the full `IssueFields` so the created issue lands in the mirror in
 * the same shape everything else does, through the same `absorbIssue` path —
 * which also records the echo, so the poller does not immediately report the
 * plugin's own write back to the user as news.
 */
export const ISSUE_CREATE = doc(
  "IssueCreate",
  "mutation",
  `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      ...IssueFields
    }
  }
}

${ISSUE_FIELDS}`,
);

/**
 * Relate two issues.
 *
 * `type` is a `String` on the input, not an enum, and the four values that
 * matter are `blocks`, `related`, `duplicate` and `similar`. Direction is
 * carried by which id is `issueId` and which is `relatedIssueId` — "A blocks
 * B" and "B blocks A" are the same mutation with the arguments swapped, which
 * is the single easiest thing to get backwards here.
 */
export const ISSUE_RELATION_CREATE = doc(
  "IssueRelationCreate",
  "mutation",
  `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation {
      id
      type
      issue {
        id
        identifier
      }
      relatedIssue {
        id
        identifier
      }
    }
  }
}`,
);

/**
 * Link any URL to an issue.
 *
 * `attachmentLinkURL` rather than `attachmentCreate`: when the workspace has a
 * matching integration configured and recognises the URL — GitHub, Zendesk,
 * Slack — this produces a *rich* attachment that participates in Linear's own
 * automations. `attachmentCreate` produces an inert one that looks the same
 * and does nothing.
 */
export const ATTACHMENT_LINK = doc(
  "AttachmentLink",
  "mutation",
  `mutation AttachmentLink($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
    success
    attachment {
      id
      title
      subtitle
      url
    }
  }
}`,
);

/**
 * Archive an issue.
 *
 * `issueArchive`, never `issueDelete`. Archiving is reversible in Linear's own
 * UI and is what the word "archive" means there; `issueDelete` trashes the
 * issue. A plugin that offered the destructive one behind a friendly word
 * would be doing the worst thing it could do to somebody's tracker.
 */
export const ISSUE_ARCHIVE = doc(
  "IssueArchive",
  "mutation",
  `mutation IssueArchive($id: String!) {
  issueArchive(id: $id) {
    success
  }
}`,
);

/**
 * The same selection as `IssueFields`, on the separate type Linear's search
 * returns.
 *
 * `searchIssues` answers with `IssueSearchResult`, not `Issue` — a distinct
 * type that mirrors the fields. Derived from the one string rather than
 * written out twice, because both feed `toIssueInput` and a drift between them
 * would be a column that is populated on one path and null on the other.
 *
 * The offline SDL validation is what found this: the fragment spread was
 * rejected before a single request was ever made.
 */
const SEARCH_RESULT_FIELDS = ISSUE_FIELDS.replace(
  "fragment IssueFields on Issue {",
  "fragment SearchResultFields on IssueSearchResult {",
);

export const SEARCH_PAGE_SIZE = 25;

/**
 * Linear's own full-text and vector search, for the case the mirror cannot
 * answer: an issue outside the backfill window, or in a team that is readable
 * but not bound.
 *
 * **Rate limited to 30 requests a minute**, separately from the hourly budget,
 * which is why this is never the default path — the local FTS index answers
 * instantly and costs nothing, and this is the escalation an agent asks for
 * explicitly.
 *
 * Team-scoped like every other issue read: the filter is not optional, and a
 * search that returned issues from teams the project is not bound to would
 * defeat the entire scoping model in the one place a user is least likely to
 * notice.
 */
export const SEARCH_ISSUES = doc(
  "SearchIssues",
  "query",
  `query SearchIssues($term: String!, $first: Int!, $teamIds: [ID!]!) {
  searchIssues(
    term: $term
    first: $first
    filter: { team: { id: { in: $teamIds } } }
  ) {
    nodes {
      ...SearchResultFields
    }
  }
}

${SEARCH_RESULT_FIELDS}`,
  { first: SEARCH_PAGE_SIZE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Slim discovery (accounts CLI)                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The slim team list: enough to resolve "--team Eng" to an id and to label
 * where an issue is about to be created, without paying BOOTSTRAP's price on
 * a path that needs none of the rest.
 */
export const TEAMS_SLIM = doc(
  "TeamsSlim",
  "query",
  `query TeamsSlim($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      key
      name
    }
  }
}`,
  { first: TEAM_PAGE_SIZE },
);
