import { z } from "zod";
import { defineRpcContract } from "./sdk-runtime.js";
import { STATE_TYPES, type Tone } from "./select/tone.js";

/**
 * The wire between the plugin's server and its React surfaces.
 *
 * Every shape here is also the shape `src/select/*` produces, so there is one
 * definition rather than a TypeScript type and a zod schema drifting apart —
 * the pure projections import their types *from here*. The host validates
 * output against these schemas before serialising, which makes them a real
 * contract and not documentation: a projection that starts returning
 * `undefined` where the schema says `null` fails loudly at the boundary
 * instead of rendering as a blank row.
 *
 * Nothing here ever carries a credential. Not the key, not a fingerprint of
 * it, not a redacted prefix — the frontend has no use for one and every
 * additional place a secret can appear is a place it can leak.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Shared views                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export const budgetViewSchema = z.object({
  remaining: z.number().nullable(),
  limit: z.number().nullable(),
  /** Epoch milliseconds. Rendered with `Intl`, never parsed back. */
  resetAt: z.number().nullable(),
});
export type BudgetView = z.infer<typeof budgetViewSchema>;

export const workspaceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  urlKey: z.string(),
});
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const viewerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});
export type ViewerView = z.infer<typeof viewerViewSchema>;

/**
 * The one line the Connection section grows *after* a mutation has actually
 * been refused.
 *
 * Linear does not expose a key's scopes — there is no `apiKeys` or
 * `viewerScopes` root field, and the only `scopes` in the whole SDL belongs to
 * an OAuth client approval. So the plugin cannot say "this key is read-only"
 * until a write has come back refused, and it says nothing until then. That is
 * why every mutating control renders enabled: a disabled button would be a
 * claim the plugin has no way to substantiate.
 */
export const writeRefusalSchema = z.object({
  at: z.number(),
  what: z.string(),
});
export type WriteRefusal = z.infer<typeof writeRefusalSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Connection                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export const connectionStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-credential") }),
  z.object({ kind: z.literal("checking") }),
  z.object({
    kind: z.literal("connected"),
    viewer: viewerViewSchema,
    workspace: workspaceViewSchema,
    budget: budgetViewSchema.nullable(),
    writeRefusal: writeRefusalSchema.nullable(),
    checkedAt: z.number(),
  }),
  /**
   * Three failures with three different sentences, and the distinction is
   * earned rather than guessed: Linear answers 401 for both a mistyped key and
   * a revoked one, so the plugin tells them apart by whether *this* key has
   * ever verified before — a fact it keeps as a non-reversible fingerprint, so
   * the answer survives a restart without a secret reaching kv.
   */
  z.object({ kind: z.literal("invalid-key"), message: z.string() }),
  z.object({ kind: z.literal("revoked"), message: z.string() }),
  z.object({ kind: z.literal("unreachable"), message: z.string() }),
  z.object({
    kind: z.literal("rate-limited"),
    message: z.string(),
    resetAt: z.number().nullable(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Rows                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export const toneSchema = z.enum([...STATE_TYPES, "unknown"]);
// The enum and the union are two spellings of one fact; these two lines fail
// the build if they stop agreeing.
const _toneForward: Tone = "unknown" as z.infer<typeof toneSchema>;
const _toneBack: z.infer<typeof toneSchema> = "unknown" as Tone;
void _toneForward;
void _toneBack;

export const assigneeViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});
export type AssigneeView = z.infer<typeof assigneeViewSchema>;

export const secondLineSchema = z.object({
  kind: z.enum(["pr", "due", "blocked", "sub-issues", "cycle"]),
  text: z.string(),
  tone: toneSchema,
});
export type SecondLine = z.infer<typeof secondLineSchema>;
export type SecondLineKind = SecondLine["kind"];

/** What bb knows about an issue that Linear cannot: whether a thread is
 *  running on it, whether it has a branch, whether a pull request exists. */
export const bbFactSchema = z.enum([
  "thread-running",
  "thread-idle",
  "pull-request",
  "branch",
  "none",
]);
export type BbFact = z.infer<typeof bbFactSchema>;

/**
 * The lead column, and the one place this panel refuses to copy Linear.
 *
 * In *All issues* the list is grouped by state, so every glyph inside the "In
 * Progress" group is identical — a column of identical marks is a column
 * nobody reads. There the lead carries the **bb-native** fact instead (a
 * thread running, a branch, a pull request, nothing), which is the half of the
 * picture linear.app cannot draw, and the state moves to the group header
 * where it actually varies.
 *
 * In *Working set* the grouping is by bb fact, so the same argument runs the
 * other way and the lead is the Linear state.
 */
export const leadKindSchema = z.enum(["state", "bb-fact"]);
export type LeadKind = z.infer<typeof leadKindSchema>;

export const priorityMarkSchema = z.enum(["urgent", "high"]).nullable();

export const issueRowViewSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  stateName: z.string(),
  tone: toneSchema,
  lead: leadKindSchema,
  bbFact: bbFactSchema,
  assignee: assigneeViewSchema.nullable(),
  priority: z.number(),
  priorityLabel: z.string(),
  priorityMark: priorityMarkSchema,
  updatedAt: z.number(),
  age: z.string(),
  secondLine: secondLineSchema.nullable(),
  accessibleName: z.string(),
  struckThrough: z.boolean(),
});
export type IssueRowView = z.infer<typeof issueRowViewSchema>;

export const issueGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** **Post-filter, always.** */
  count: z.number(),
  tone: toneSchema,
  rows: z.array(issueRowViewSchema),
});
export type IssueGroup = z.infer<typeof issueGroupSchema>;

export const panelNoticeSchema = z.object({
  tone: z.enum(["warn", "error"]),
  message: z.string(),
});
export type PanelNotice = z.infer<typeof panelNoticeSchema>;

export const panelStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-credential") }),
  z.object({ kind: z.literal("no-binding") }),
  z.object({ kind: z.literal("first-sync"), teamName: z.string().nullable() }),
  z.object({ kind: z.literal("empty-team"), teamName: z.string() }),
  z.object({
    kind: z.literal("empty-filter"),
    facets: z.array(z.string()),
    totalWithoutFilters: z.number(),
  }),
  z.object({
    kind: z.literal("rows"),
    groups: z.array(issueGroupSchema),
    shown: z.number(),
    total: z.number(),
  }),
]);
export type PanelState = z.infer<typeof panelStateSchema>;

export const panelViewSchema = z.object({
  notice: panelNoticeSchema.nullable(),
  state: panelStateSchema,
});
export type PanelView = z.infer<typeof panelViewSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Panel query                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export const groupingSchema = z.enum(["state", "project", "cycle", "assignee", "none"]);
export type Grouping = z.infer<typeof groupingSchema>;

export const sortSchema = z.enum(["updated", "priority", "due", "manual", "created"]);
export type Sort = z.infer<typeof sortSchema>;

export const panelFiltersSchema = z.object({
  stateIds: z.array(z.string()).default([]),
  stateTypes: z.array(z.string()).default([]),
  assigneeIds: z.array(z.string()).default([]),
  labelIds: z.array(z.string()).default([]),
  priorities: z.array(z.number()).default([]),
  /** Off by default: the panel's baseline is open work. */
  includeCompleted: z.boolean().default(false),
});
export type PanelFilters = z.infer<typeof panelFiltersSchema>;

export const panelQuerySchema = z.object({
  /**
   * A team id **or** a team key, or `null` for "All bound teams".
   *
   * Both, because the same value arrives from two places: the header selector
   * knows ids, and a deep link (`/plugins/linear/linear/t/ENG`) carries the
   * key, which is what a human can read and retype. The server resolves
   * either and narrows the result against the bound set, so a hand-edited
   * link cannot widen scope.
   *
   * The panel is workspace-scoped because it cannot be otherwise:
   * `PluginNavPanelProps` is `{ subPath }` and nothing else, and
   * `useBbContext().projectId` is null on a plugin panel route.
   */
  team: z.string().nullable().default(null),
  grouping: groupingSchema.default("state"),
  sort: sortSchema.default("updated"),
  search: z.string().default(""),
  filters: panelFiltersSchema.default({
    stateIds: [],
    stateTypes: [],
    assigneeIds: [],
    labelIds: [],
    priorities: [],
    includeCompleted: false,
  }),
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Detail                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export const propertyViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  tone: toneSchema.optional(),
});
export type PropertyView = z.infer<typeof propertyViewSchema>;

export const commentViewSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.string(),
  authorInitials: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: z.number().nullable(),
  edited: z.boolean(),
  parentId: z.string().nullable(),
  url: z.string().nullable(),
});
export type CommentView = z.infer<typeof commentViewSchema>;

export const stateOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  tone: toneSchema,
});
export type StateOption = z.infer<typeof stateOptionSchema>;

export const subIssueViewSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  tone: toneSchema,
  done: z.boolean(),
});
export type SubIssueView = z.infer<typeof subIssueViewSchema>;

export const detailViewSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  stateId: z.string().nullable(),
  stateName: z.string(),
  tone: toneSchema,
  struckThrough: z.boolean(),
  stateOptions: z.array(stateOptionSchema),
  properties: z.array(propertyViewSchema),
  labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string().nullable() })),
  /**
   * The raw values behind the editable properties.
   *
   * `properties` is for *reading* and drops anything empty, which is right for
   * a pane you scan. An editor cannot use it: "Assignee — none" has to be
   * present and clickable precisely when it is empty, because that is when you
   * want to set one. So the editable rows are driven from here and the two
   * never disagree, because both come from one projection.
   */
  fields: z.object({
    assignee: assigneeViewSchema.nullable(),
    priority: z.number(),
    priorityLabel: z.string(),
    estimate: z.number().nullable(),
    estimateLabel: z.string().nullable(),
    /** `TimelessDate` — `YYYY-MM-DD`, never converted to an instant. */
    dueDate: z.string().nullable(),
    dueDateLabel: z.string().nullable(),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    cycleId: z.string().nullable(),
    cycleName: z.string().nullable(),
  }),
  subIssues: z.array(subIssueViewSchema),
  comments: z.array(commentViewSchema),
  commentsTruncated: z.boolean(),
  footnotes: z.array(propertyViewSchema),
  teamKey: z.string(),
  teamName: z.string(),
  usesEstimates: z.boolean(),
  /** The branch name Linear generated. Not a rendered property — it is a
   *  value you copy, and a row of git syntax in a properties list is noise
   *  for everyone who was not about to copy it. */
  branchName: z.string().nullable(),
});
export type DetailView = z.infer<typeof detailViewSchema>;

/**
 * What the detail pane gets back, including the two answers that are not an
 * issue.
 *
 * `refusal` is the cross-team sentence, rendered — this is the one place in
 * the UI where a stranger meets the scoping rule, and it is where the rule
 * teaches itself. `missing` is a deep link to something this workspace does
 * not have.
 */
export const detailResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), detail: detailViewSchema }),
  z.object({ kind: z.literal("missing"), identifier: z.string() }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
  z.object({ kind: z.literal("loading") }),
]);
export type DetailResult = z.infer<typeof detailResultSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* One thread's issue                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * **The chip owns steady state; the banner owns news.**
 *
 * The thread header chip always shows the linked issue and its state. So the
 * banner never renders "ENG-42 is in In Progress" — that would be a permanent,
 * unactionable duplicate of the chip fifteen pixels away, and this section's
 * own rule is that a row says nothing when it has nothing to say.
 *
 * The banner renders only when something changed or something is wrong.
 */
export const threadBannerSchema = z.discriminatedUnion("kind", [
  /** A transition just happened. Decays: it stays while the thread is active
   *  and for 24 hours after, then stops rendering. A sentence about a pull
   *  request that opened three weeks ago is not news. */
  z.object({
    kind: z.literal("moved"),
    identifier: z.string(),
    stateName: z.string(),
    tone: toneSchema,
    because: z.string(),
    at: z.number(),
  }),
  /** A transition was expected and the lookup failed. Shown once per
   *  environment, never forever — and not at all on a host that has never
   *  produced a pull-request lookup, because a GitLab shop should not get a
   *  permanent apology attached to every linked thread. */
  z.object({ kind: z.literal("lookup-failed"), identifier: z.string() }),
  z.object({
    kind: z.literal("blocked"),
    identifier: z.string(),
    blockers: z.array(z.string()),
  }),
  /** The branch resolves to an issue and nothing is linked yet. */
  z.object({
    kind: z.literal("branch-unlinked"),
    identifier: z.string(),
    issueId: z.string(),
  }),
  /** The branch looks like a Linear branch but the project is unbound. */
  z.object({ kind: z.literal("branch-unbound"), identifier: z.string() }),
]);
export type ThreadBanner = z.infer<typeof threadBannerSchema>;

export const threadIssueSchema = z.object({
  link: z
    .object({
      issueId: z.string(),
      identifier: z.string(),
      title: z.string(),
      stateId: z.string().nullable(),
      stateName: z.string(),
      tone: toneSchema,
      url: z.string().nullable(),
      stateOptions: z.array(stateOptionSchema),
    })
    .nullable(),
  banner: threadBannerSchema.nullable(),
});
export type ThreadIssueView = z.infer<typeof threadIssueSchema>;

/**
 * Everything the thread's side-panel tab draws.
 *
 * Deliberately **not** `threadIssue`. That one is mounted on every visible
 * thread — the header chip and the composer banner both read it — and it has
 * to stay cheap. This one is opened on purpose, once, and can afford to answer
 * the harder question: if there is no issue, what *is* this thread, and what
 * could it be linked to?
 *
 * The four answers are ordered by how much is known, and every one of them is
 * actionable. A tab that says "no issue" and stops is a tab nobody opens
 * twice.
 */
export const threadPanelSchema = z.object({
  /** The issue to render in full. Non-null when the thread is linked, or when
   *  its branch resolved to an issue that is in scope and already linked. */
  issueId: z.string().nullable(),
  /** The thread is linked explicitly, rather than matched from a branch. Only
   *  an explicit link can be removed, so only an explicit link offers it. */
  linked: z.boolean(),
  /** A branch that resolved to an issue nobody has linked yet. */
  suggestion: z
    .object({ issueId: z.string(), identifier: z.string(), title: z.string() })
    .nullable(),
  /** What this thread belongs to, when there is no issue to show. Null when
   *  the thread has no project at all. */
  project: z
    .object({
      id: z.string(),
      name: z.string(),
      /** The Linear teams this project is bound to, primary first. Empty means
       *  bound to nothing, which is its own answer and its own fix. */
      teams: z.array(z.object({ key: z.string(), name: z.string() })),
    })
    .nullable(),
  /** Issues you could plausibly mean, for the case where nothing resolved.
   *  Assigned to you and unfinished, in this project's teams — not "every
   *  issue", which is a picker rather than a suggestion. */
  candidates: z.array(issueRowViewSchema),
});
export type ThreadPanelView = z.infer<typeof threadPanelSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Working set                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export const workingBucketSchema = z.object({
  id: z.enum(["running", "started-no-pr", "pr-needs-you", "assigned-unstarted", "blocked"]),
  label: z.string(),
  emptyHint: z.string(),
  rows: z.array(issueRowViewSchema),
});
export type WorkingBucketView = z.infer<typeof workingBucketSchema>;

export const workingSetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-credential") }),
  z.object({ kind: z.literal("no-binding") }),
  z.object({ kind: z.literal("first-sync"), teamName: z.string().nullable() }),
  /** The one case that gets a sentence of its own. Five empty headings is a
   *  wall of nothing; one sentence naming what was asked is not. */
  z.object({ kind: z.literal("clear"), hints: z.array(z.string()) }),
  z.object({ kind: z.literal("buckets"), buckets: z.array(workingBucketSchema) }),
]);
export type WorkingSetView = z.infer<typeof workingSetSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Inbox                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export const inboxItemSchema = z.object({
  key: z.string(),
  kind: z.enum(["assigned", "comment", "blocked", "unblocked", "other"]),
  text: z.string(),
  identifier: z.string().nullable(),
  issueId: z.string().nullable(),
  url: z.string().nullable(),
  /** The workspace name, only when more than one is connected — a merged
   *  inbox without labels is a guessing game, and labels on a single
   *  workspace are noise. */
  workspace: z.string().nullable(),
  age: z.string(),
  unseen: z.boolean(),
});
export type InboxItemView = z.infer<typeof inboxItemSchema>;

export const inboxViewSchema = z.object({
  items: z.array(inboxItemSchema),
  /** Capped at 99+ by the renderer, not here — the number itself stays a
   *  number so nothing downstream has to parse "99+". */
  unseen: z.number(),
});
export type InboxView = z.infer<typeof inboxViewSchema>;

export const inboxSummarySchema = z.object({
  unseen: z.number(),
  newest: z
    .object({
      text: z.string(),
      identifier: z.string().nullable(),
    })
    .nullable(),
});
export type InboxSummary = z.infer<typeof inboxSummarySchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Facets, teams, bindings                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export const teamViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  parentId: z.string().nullable(),
  triageEnabled: z.boolean(),
  cyclesEnabled: z.boolean(),
  /** `notUsed | exponential | fibonacci | linear | tShirt`. The estimate
   *  control does not render at all on `notUsed`. */
  estimationType: z.string(),
  /** Which workspace this team came from, when the user has more than one
   *  connected. Null when there is only one — the answer is then not
   *  information, it is noise on every row. */
  workspaceName: z.string().nullable(),
  bound: z.boolean(),
});
export type TeamView = z.infer<typeof teamViewSchema>;

export const facetsSchema = z.object({
  states: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      position: z.number(),
      tone: toneSchema,
    }),
  ),
  /** Derived from the bound teams' own rows, so a triage-enabled team gets a
   *  Triage chip and a team without one does not. */
  stateTypes: z.array(z.object({ type: z.string(), label: z.string(), tone: toneSchema })),
  labels: z.array(
    z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }),
  ),
  members: z.array(assigneeViewSchema.extend({ isMe: z.boolean() })),
  priorities: z.array(z.object({ priority: z.number(), label: z.string() })),
});
export type Facets = z.infer<typeof facetsSchema>;

export const bindingRoleSchema = z.enum(["primary", "write", "read"]);

export const projectBindingViewSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /** bb's own project kind. The personal project is listed like any other and
   *  labelled — omitting it strands the solo developer who never created a
   *  project, whose every thread would be unbound. */
  isPersonal: z.boolean(),
  primary: teamViewSchema.nullable(),
  write: z.array(teamViewSchema),
  read: z.array(teamViewSchema),
  /** One sentence rather than three chips: the difference between a write
   *  team and a read-only one is a rule, and a rule reads better as prose. */
  sentence: z.string(),
});
export type ProjectBindingView = z.infer<typeof projectBindingViewSchema>;

export const bindingsViewSchema = z.object({
  workspaceName: z.string().nullable(),
  bound: z.array(projectBindingViewSchema),
  unbound: z.array(projectBindingViewSchema),
  teams: z.array(teamViewSchema),
  /** Never "3 of 5". `teams` returns "All teams whose issues the user can
   *  access", so a team-restricted key cannot see what it is restricted away
   *  from and the denominator is unknowable. */
  teamsVisible: z.number(),
});
export type BindingsView = z.infer<typeof bindingsViewSchema>;

/* ────────────────────────────────────────────────────────────────────────── */

export const rpcContract = defineRpcContract({
  /**
   * The Connection section's only data source.
   *
   * `recheck` is what the **Check again** button sends. Without it the handler
   * answers from a short-lived cache, because this section is rendered on
   * every visit to the plugin's settings page and a workspace lookup per visit
   * is a request spent on something the user did not ask for.
   */
  connection: {
    input: z.object({ recheck: z.boolean().optional() }).strict(),
    output: z.object({ state: connectionStateSchema }),
  },

  /**
   * One row per configured API key.
   *
   * Rendered only when more than one is set, because for almost every install
   * there is exactly one and a list of one is worse than a sentence. A key
   * that fails here does not make the others fail: a revoked second key is a
   * line in the settings section, not an outage.
   */
  workspaces: {
    input: z.null(),
    output: z.object({
      workspaces: z.array(
        z.object({
          slot: z.string(),
          label: z.string(),
          teams: z.number(),
          state: connectionStateSchema,
        }),
      ),
    }),
  },

  /**
   * Re-read the workspace: which teams exist, and each bound team's own
   * states, labels and people.
   *
   * Separate from `connection` because they answer different questions.
   * `connection` asks whether the key works; this asks what the key can *see*.
   * Replacing the key changes the second answer completely — a different
   * workspace has different teams — and until something re-runs discovery the
   * team list on screen belongs to the workspace that key no longer reaches.
   */
  refreshWorkspace: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      teamsVisible: z.number(),
    }),
  },

  /** Everything the nav panel draws, already projected. The component is a
   *  switch over `state.kind` and holds no logic of its own. */
  panel: {
    input: panelQuerySchema.strict(),
    output: panelViewSchema,
  },

  /** The chips the filter row offers, derived from the bound teams' own rows
   *  rather than from a fixed list. */
  facets: {
    input: z.object({ team: z.string().nullable() }).strict(),
    output: facetsSchema,
  },

  /** Bound projects, unbound projects, and the teams this key can see. */
  bindings: {
    input: z.null(),
    output: bindingsViewSchema,
  },

  bind: {
    input: z
      .object({
        projectId: z.string().min(1),
        teamId: z.string().min(1),
        role: bindingRoleSchema,
      })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  unbind: {
    input: z.object({ projectId: z.string().min(1), teamId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  /** One issue, projected. Answers from the mirror and refreshes behind the
   *  scenes; a deep link to something not yet mirrored triggers one targeted
   *  fetch rather than a full sweep. */
  issue: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ result: detailResultSchema }),
  },

  /**
   * Every mutating control renders **enabled** and fails in a sentence.
   * Rendering them disabled before any refusal has happened would be a claim
   * the plugin cannot substantiate — Linear does not expose a key's scopes —
   * and hiding them would make a read-only key look like a broken build.
   */
  /**
   * Every field the mutation layer can patch, and no more.
   *
   * `undefined` means "not part of this patch" and `null` means "clear it" —
   * unassigning an issue and not touching its assignee are different
   * intentions and both have to be expressible, which a plain optional cannot
   * do on its own.
   *
   * Labels are **add and remove**, never a replacement set. `labelIds` would
   * overwrite the whole set, so a patch built from a read taken thirty seconds
   * ago silently deletes whatever somebody added in between — and the person
   * who lost the label has no way to know, because nothing failed.
   */
  updateIssue: {
    input: z
      .object({
        id: z.string().min(1),
        stateId: z.string().optional(),
        assigneeId: z.string().nullable().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        estimate: z.number().nullable().optional(),
        /** `TimelessDate` — `YYYY-MM-DD`, a calendar fact rather than an
         *  instant. Never converted, because converting picks a timezone on
         *  somebody's behalf and is wrong by a day for half the planet. */
        dueDate: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
        cycleId: z.string().nullable().optional(),
        milestoneId: z.string().nullable().optional(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        addLabelIds: z.array(z.string()).optional(),
        removeLabelIds: z.array(z.string()).optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  /**
   * What an issue's pickers can offer: this team's people, labels, states,
   * priorities, projects, cycles and estimate scale.
   *
   * A separate call rather than fields on `detailViewSchema`, and fetched when
   * a picker opens rather than with the issue. The lists are large, they change
   * on a completely different clock from the issue, and every detail read would
   * otherwise carry two hundred labels nobody is about to look at.
   */
  editorOptions: {
    input: z.object({ issueId: z.string().min(1) }).strict(),
    output: z.object({
      states: z.array(stateOptionSchema),
      members: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          initials: z.string(),
          avatarUrl: z.string().nullable(),
          isMe: z.boolean(),
        }),
      ),
      labels: z.array(
        z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }),
      ),
      priorities: z.array(z.object({ priority: z.number(), label: z.string() })),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
      cycles: z.array(z.object({ id: z.string(), name: z.string() })),
      /** Empty when the team does not use estimates, which is most teams. */
      estimates: z.array(z.object({ value: z.number(), label: z.string() })),
    }),
  },

  comment: {
    input: z.object({ issueId: z.string().min(1), body: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  /**
   * Start a bb thread from an issue.
   *
   * Returns a sentence rather than a boolean, because "started, but bb named
   * the branch" and "started" are different outcomes and the difference is
   * exactly what a user would otherwise discover an hour later.
   */
  startThread: {
    input: z
      .object({
        issueId: z.string().min(1),
        projectId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      threadId: z.string().nullable(),
      message: z.string(),
      note: z.string().nullable(),
    }),
  },

  /**
   * The Working set — the panel's default segment, and its argument for
   * existing. Five questions the browser tab you already have open cannot
   * answer at all.
   */
  workingSet: {
    input: z.object({ team: z.string().nullable() }).strict(),
    output: z.object({ view: workingSetSchema, notice: panelNoticeSchema.nullable() }),
  },

  /** The Inbox segment, and the count every other surface echoes. */
  inbox: {
    input: z.object({ markSeen: z.boolean().optional() }).strict(),
    output: inboxViewSchema,
  },

  /** Badge and toast data only. The always-mounted segment control must not
   * serialise two hundred inbox rows merely to draw one number. */
  inboxSummary: {
    input: z.null(),
    output: inboxSummarySchema,
  },

  dismissInbox: {
    input: z.object({ keys: z.array(z.string()), all: z.boolean().optional() }).strict(),
    output: z.object({ ok: z.boolean(), dismissed: z.number() }),
  },

  /** Everything the composer banner and the thread header chip draw, for one
   *  thread. Both surfaces mount per thread, so this is deliberately one call
   *  rather than two. */
  /**
   * Turn identifiers scraped out of a chat message into real issues.
   *
   * The message action parses text with no team list and no store — it runs in
   * a registration callback, which has neither — so it is deliberately loose
   * and this is where the strictness lives. Anything that is not a real issue
   * this project can read simply does not come back, which is why a message
   * mentioning `UTF-8` opens the thread's own issue rather than an error.
   *
   * Scope is enforced here like everywhere else: an identifier belonging to a
   * team this project is not bound to resolves to nothing.
   */
  resolveIdentifiers: {
    input: z
      .object({
        identifiers: z.array(z.string().min(1)).max(24),
        threadId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ issues: z.array(issueRowViewSchema) }),
  },

  /** The thread side-panel tab. Opened deliberately, so it can cost more than
   *  the chip that is always mounted. */
  threadPanel: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadPanelSchema,
  },

  threadIssue: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadIssueSchema,
  },

  /** The link between the current thread and an issue. */
  linkThread: {
    input: z
      .object({ threadId: z.string().min(1), issueId: z.string().nullable() })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  /**
   * Disconnect, and it means it: every mirror table and every kv row this
   * plugin owns.
   *
   * `bb plugin remove` does **not** do this — the host deletes settings rows
   * and the secrets directory, and its own comment states that kv rows and
   * `data.db` are plugin data that survive a remove/reinstall cycle. So this
   * is the only thing that removes a workspace's issue data from the machine.
   */
  /**
   * The account-wide half of the panel's chrome, which is sort and only sort.
   *
   * A preference for "priority over updated" is a working style worth carrying
   * between machines. The team filter, the grouping and the group-collapse
   * state are not: a phone mid-triage and a desktop must not fight over one
   * synced collapse state, so those stay in browser storage.
   */
  preferences: {
    input: z.null(),
    output: z.object({ sort: z.string().nullable() }),
  },

  setSort: {
    // The enum at write time too, not just at panel-read time — the kv row
    // should never hold a value the panel would refuse.
    input: z.object({ sort: sortSchema }).strict(),
    output: z.object({ ok: z.boolean() }),
  },

  /**
   * Archive an issue. `issueArchive`, which is reversible in Linear's own UI
   * — never `issueDelete`, which is not.
   *
   * The only destructive-shaped action any surface offers on an issue, and the
   * only one behind a confirmation dialog. No agent tool wraps it at any
   * setting: a person reading a sentence is the whole safeguard.
   */
  archiveIssue: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },

  disconnect: {
    input: z.object({ confirm: z.literal(true) }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },

  /** The Sync now button. Returns a sentence rather than a boolean, because
   *  "nothing changed" and "read 14 issues" are different answers and both are
   *  worth seeing. */
  syncNow: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});

export type LinearRpcContract = typeof rpcContract;
