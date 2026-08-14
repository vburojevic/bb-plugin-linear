import type {
  CommentView,
  DetailView,
  PropertyView,
  StateOption,
  SubIssueView,
} from "../contract.js";
import { formatTimelessDate, pluralize } from "../format.js";
import type { CommentRow, LabelRow, MemberRow, TeamRow, WorkflowStateRow } from "../store/rows.js";
import type { IssueRow } from "../store/rows.js";
import { toneForStateType, type Tone } from "./tone.js";

/**
 * The detail pane, as data.
 *
 * Ordered by what you need when you open an issue, with controls after
 * content: identifier and state first, then the description, then the
 * properties, then sub-issues, relations, attachments, comments, and last the
 * facts nobody needs first — created, updated, creator, previous identifiers.
 */

export type { CommentView, DetailView, PropertyView, StateOption, SubIssueView };

export interface DetailContext {
  readonly issue: IssueRow;
  readonly team: TeamRow | null;
  readonly states: readonly WorkflowStateRow[];
  readonly members: ReadonlyMap<string, MemberRow>;
  readonly labels: ReadonlyMap<string, LabelRow>;
  readonly priorityLabels: ReadonlyMap<number, string>;
  readonly comments: readonly CommentRow[];
  readonly commentsTruncated: boolean;
  readonly subIssues: readonly { id: string; identifier: string; title: string; type: string }[];
  readonly projectName: string | null;
  readonly cycleName: string | null;
  readonly milestoneName: string | null;
}

/** Linear's own grouping order for a state picker. */
const TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

/**
 * `Team.issueEstimationType` is one of `notUsed | exponential | fibonacci |
 * linear | tShirt`, and **estimates are not "points"**. Rendering "3 points"
 * on a t-shirt team is wrong in a way that makes the whole panel look like it
 * does not know the workspace it is looking at.
 */
export function formatEstimate(value: number | null, estimationType: string): string | null {
  if (value === null) return null;
  if (estimationType === "notUsed") return null;
  if (estimationType === "tShirt") {
    return T_SHIRT[value] ?? `${value}`;
  }
  return `${value} ${pluralize(value, "point", "points")}`;
}

/** Linear's t-shirt scale, in its own order. Index 0 is "no estimate" and
 *  never renders, because `formatEstimate` is only reached with a value. */
const T_SHIRT: Record<number, string> = {
  1: "XS",
  2: "S",
  3: "M",
  5: "L",
  8: "XL",
  13: "XXL",
};

/**
 * The values a team's estimate scale actually offers.
 *
 * Linear does not expose the scale as data — only the *name* of the scale on
 * `Team.issueEstimationType` — so these are the sequences Linear's own picker
 * uses, reproduced. Offering a free number field instead would let somebody
 * set 7 on a fibonacci team, which Linear accepts and then renders as a value
 * that is not on the board.
 *
 * `estimationAllowZero` decides whether "no estimate" is a choice or just the
 * absence of one, and `estimationExtended` adds the tail Linear adds. Both come
 * straight off the team.
 */
export function estimateScale(
  estimationType: string,
  options: { allowZero: boolean; extended: boolean },
): number[] {
  const base = ESTIMATE_SCALES[estimationType];
  if (base === undefined) return [];
  const values = options.extended ? base.extended : base.standard;
  return options.allowZero ? [0, ...values] : [...values];
}

const ESTIMATE_SCALES: Record<string, { standard: number[]; extended: number[] }> = {
  exponential: { standard: [1, 2, 4, 8, 16], extended: [1, 2, 4, 8, 16, 32, 64] },
  fibonacci: { standard: [1, 2, 3, 5, 8], extended: [1, 2, 3, 5, 8, 13, 21] },
  linear: { standard: [1, 2, 3, 4, 5], extended: [1, 2, 3, 4, 5, 6, 7] },
  tShirt: { standard: [1, 2, 3, 5, 8], extended: [1, 2, 3, 5, 8, 13] },
};

/** What one scale value is called. The t-shirt scale is the reason this is not
 *  just the number: a team on t-shirts never wants to read "5". */
export function estimateLabel(value: number, estimationType: string): string {
  if (value === 0) return "No estimate";
  return formatEstimate(value, estimationType) ?? `${String(value)}`;
}

export function selectDetail(context: DetailContext): DetailView {
  const { issue } = context;
  const state = context.states.find((entry) => entry.id === issue.stateId) ?? null;
  const tone = toneForStateType(state?.type);
  const assignee = issue.assigneeId === null ? null : context.members.get(issue.assigneeId);
  const creator = issue.creatorId === null ? null : context.members.get(issue.creatorId);
  const estimationType = context.team?.estimationType ?? "notUsed";

  const properties: PropertyView[] = [];
  const push = (key: string, label: string, value: string | null, propertyTone?: Tone) => {
    // A property with no value does not render. A detail pane full of
    // "Assignee: —" rows is a pane that has to be read past rather than read.
    if (value === null || value === "") return;
    properties.push(propertyTone === undefined ? { key, label, value } : { key, label, value, tone: propertyTone });
  };

  push("assignee", "Assignee", assignee?.displayName ?? null);
  push("priority", "Priority", context.priorityLabels.get(issue.priority) ?? null);
  push(
    "estimate",
    "Estimate",
    estimationType === "notUsed" ? null : formatEstimate(issue.estimate, estimationType),
  );
  push("project", "Project", context.projectName);
  push("milestone", "Milestone", context.milestoneName);
  push("cycle", "Cycle", context.cycleName);
  push(
    "due",
    "Due",
    issue.dueDate === null ? null : formatTimelessDate(issue.dueDate),
    issue.dueDate === null ? undefined : "triage",
  );

  const fields: DetailView["fields"] = {
    assignee:
      assignee === undefined || assignee === null
        ? null
        : {
            id: assignee.id,
            name: assignee.displayName || assignee.name,
            initials: initials(assignee.displayName || assignee.name),
            avatarUrl: assignee.avatarUrl,
          },
    priority: issue.priority,
    priorityLabel: context.priorityLabels.get(issue.priority) ?? "",
    estimate: issue.estimate,
    estimateLabel: estimationType === "notUsed" ? null : formatEstimate(issue.estimate, estimationType),
    dueDate: issue.dueDate,
    dueDateLabel: issue.dueDate === null ? null : formatTimelessDate(issue.dueDate),
    projectId: issue.projectId,
    projectName: context.projectName,
    cycleId: issue.cycleId,
    cycleName: context.cycleName,
  };

  const footnotes: PropertyView[] = [];
  if (creator !== undefined && creator !== null) {
    footnotes.push({ key: "creator", label: "Created by", value: creator.displayName });
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description,
    stateId: issue.stateId,
    stateName: state?.name ?? "Unknown state",
    tone,
    struckThrough: tone === "canceled",
    fields,
    stateOptions: [...context.states]
      .sort((a, b) =>
        (TYPE_ORDER[a.type] ?? 9) === (TYPE_ORDER[b.type] ?? 9)
          ? a.position - b.position
          : (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9),
      )
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        tone: toneForStateType(entry.type),
      })),
    properties,
    labels: issue.labelIds
      .map((id) => context.labels.get(id))
      .filter((label): label is LabelRow => label !== undefined)
      .map((label) => ({ id: label.id, name: label.name, color: label.color })),
    subIssues: context.subIssues.map((child) => ({
      id: child.id,
      identifier: child.identifier,
      title: child.title,
      tone: toneForStateType(child.type),
      done: child.type === "completed" || child.type === "canceled",
    })),
    comments: context.comments.map((comment) => {
      const author = comment.userId === null ? undefined : context.members.get(comment.userId);
      const name = author?.displayName ?? "Someone";
      return {
        id: comment.id,
        body: comment.body,
        author: name,
        authorInitials: initials(name),
        avatarUrl: author?.avatarUrl ?? null,
        createdAt: comment.createdAt,
        edited: comment.editedAt !== null,
        parentId: comment.parentId,
        url: comment.url,
      };
    }),
    commentsTruncated: context.commentsTruncated,
    footnotes,
    teamKey: context.team?.key ?? "",
    teamName: context.team?.name ?? "",
    usesEstimates: estimationType !== "notUsed",
    branchName: issue.branchName,
  };
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...(words[0] ?? "")][0] ?? "";
  const second = words.length > 1 ? ([...(words[1] ?? "")][0] ?? "") : "";
  return `${first}${second}`.toUpperCase();
}
