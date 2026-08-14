import {
  compareTitles,
  daysBetweenDates,
  formatRelativeCompact,
  formatTimelessDate,
  joinSentence,
  pluralize,
} from "../format.js";
import type {
  AssigneeView,
  BbFact,
  Grouping,
  IssueGroup,
  IssueRowView,
  LeadKind,
  PanelNotice,
  PanelState,
  PanelView,
  SecondLine,
} from "../contract.js";
import type { IssueRow, MemberRow, TeamRow, WorkflowStateRow } from "../store/rows.js";
import { priorityMark, toneForStateType, type Tone } from "./tone.js";

/* Re-exported so a reader of this file — where the reasoning lives — does not
   have to know that the wire schemas are what declare them. */
export type {
  AssigneeView,
  BbFact,
  Grouping,
  IssueGroup,
  IssueRowView,
  LeadKind,
  PanelNotice,
  PanelState,
  PanelView,
  SecondLine,
};

/**
 * Pure projection: mirror rows in, exactly what the panel renders out.
 *
 * This is the file the UI is tested through. Components under `app/` are thin
 * switches over these unions and hold no logic of their own, which is what
 * makes the panel verifiable in a fork's CI — `@bb/plugin-sdk/testing/app` is
 * part of a package that is not on npm, so a DOM test here would be a test
 * only the author can run, and a UI only the author can verify is a UI that
 * regresses.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Rows                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────── */
/* The second line                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SecondLineFacts {
  /** A pull request that is failing or waiting on a human. Populated only
   *  from the mirror's `pr_state`, never from a fresh git-host call per row. */
  readonly pr: { readonly number: number; readonly attention: string } | null;
  readonly dueDate: string | null;
  /** `YYYY-MM-DD` in the reader's own timezone. */
  readonly today: string;
  readonly blockedBy: readonly string[];
  readonly subIssues: { readonly done: number; readonly total: number } | null;
  readonly cycleName: string | null;
  /** Only when the current filter spans cycles. Inside a single-cycle view the
   *  cycle name is the same on every row, which makes it decoration. */
  readonly showCycle: boolean;
}

/**
 * A second line appears **only when it earns it**, and there is at most one.
 *
 * The order is what changes what you do next. A pull request leads because it
 * is the only item naming an action someone else is waiting on — a parent
 * issue whose PR just failed must not be showing a fraction instead. Sub-issue
 * arithmetic is near the bottom because "3 of 7 done" has never once caused
 * anybody to do anything differently in the next minute.
 *
 * One line rather than the two a sibling plugin allows, because this row
 * already spends a fixed-width identifier column — roughly a third of the
 * width — so two lines here read as a card, and forty cards is a wall.
 */
export function selectSecondLine(facts: SecondLineFacts): SecondLine | null {
  if (facts.pr !== null && PR_ATTENTION_TEXT[facts.pr.attention] !== undefined) {
    return {
      kind: "pr",
      text: `#${facts.pr.number} ${PR_ATTENTION_TEXT[facts.pr.attention]}`,
      tone: PR_ATTENTION_TONE[facts.pr.attention] ?? "unknown",
    };
  }

  if (facts.dueDate !== null) {
    const days = daysBetweenDates(facts.today, facts.dueDate);
    if (days !== null && days <= 3) {
      const text =
        days < 0
          ? `Due ${formatTimelessDate(facts.dueDate)} — ${Math.abs(days)} ${pluralize(Math.abs(days), "day", "days")} overdue`
          : days === 0
            ? "Due today"
            : `Due in ${days} ${pluralize(days, "day", "days")}`;
      return { kind: "due", text, tone: days <= 0 ? "triage" : "unstarted" };
    }
  }

  if (facts.blockedBy.length > 0) {
    return {
      kind: "blocked",
      text: `Blocked by ${joinSentence([...facts.blockedBy])}`,
      tone: "triage",
    };
  }

  if (facts.subIssues !== null && facts.subIssues.total > 0) {
    return {
      kind: "sub-issues",
      text: `${facts.subIssues.done} of ${facts.subIssues.total} done`,
      tone: "unknown",
    };
  }

  if (facts.showCycle && facts.cycleName !== null) {
    return { kind: "cycle", text: facts.cycleName, tone: "unknown" };
  }

  return null;
}

/**
 * The pull-request vocabulary is **borrowed, not minted.**
 *
 * These are bb's own resolved `attention` values, straight off
 * `environments.pullRequest`, and the words are the words a sibling PR plugin
 * already uses. A user running both must not meet two vocabularies for one
 * pull request fifteen pixels apart. States that are not asking anything of
 * anybody — `none`, `merged`, `draft` — deliberately have no entry, so they
 * produce no second line at all.
 */
const PR_ATTENTION_TEXT: Record<string, string> = {
  checks_failed: "checks failed",
  conflicts: "has conflicts",
  changes_requested: "changes requested",
  review_requested: "waiting for review",
  blocked: "blocked",
  ready_to_merge: "ready to merge",
};

const PR_ATTENTION_TONE: Record<string, Tone> = {
  checks_failed: "canceled",
  conflicts: "canceled",
  changes_requested: "triage",
  review_requested: "triage",
  blocked: "triage",
  ready_to_merge: "completed",
};

/* ────────────────────────────────────────────────────────────────────────── */
/* One row                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RowContext {
  readonly states: ReadonlyMap<string, WorkflowStateRow>;
  readonly members: ReadonlyMap<string, MemberRow>;
  readonly priorityLabels: ReadonlyMap<number, string>;
  readonly now: number;
  readonly today: string;
  readonly lead: LeadKind;
}

export function selectRow(
  issue: IssueRow,
  context: RowContext,
  facts: Partial<SecondLineFacts> = {},
  bbFact: BbFact = "none",
): IssueRowView {
  const state = issue.stateId === null ? undefined : context.states.get(issue.stateId);
  const tone = toneForStateType(state?.type);
  const member = issue.assigneeId === null ? undefined : context.members.get(issue.assigneeId);
  const mark = priorityMark(issue.priority);
  // Always the workspace's own string, in the workspace's own language. The
  // fallback is only reachable before the bootstrap has landed.
  const priorityLabel = context.priorityLabels.get(issue.priority) ?? "";

  const secondLine = selectSecondLine({
    pr: facts.pr ?? null,
    dueDate: issue.dueDate,
    today: context.today,
    blockedBy: facts.blockedBy ?? [],
    subIssues: facts.subIssues ?? null,
    cycleName: facts.cycleName ?? null,
    showCycle: facts.showCycle ?? false,
  });

  const assignee: AssigneeView | null =
    member === undefined
      ? null
      : {
          id: member.id,
          name: member.displayName,
          initials: initialsOf(member.displayName || member.name),
          avatarUrl: member.avatarUrl,
        };

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    stateName: state?.name ?? "Unknown state",
    tone,
    lead: context.lead,
    bbFact,
    assignee,
    priority: issue.priority,
    priorityLabel,
    priorityMark: mark,
    updatedAt: issue.updatedAt,
    age: formatRelativeCompact(issue.updatedAt, context.now),
    secondLine,
    accessibleName: accessibleName({
      identifier: issue.identifier,
      title: issue.title,
      stateName: state?.name ?? "unknown state",
      assignee: assignee?.name ?? null,
      priorityLabel: mark === null ? null : priorityLabel,
      secondLine: secondLine?.text ?? null,
    }),
    struckThrough: tone === "canceled",
  };
}

/**
 * The row, in words.
 *
 * Every icon-only control needs its own accessible name — the host supplies
 * none — and no state in this panel is encoded by tone alone. This is the
 * other half of that rule: the glyph's shape and colour say "In Progress" to
 * the eye and this string says it to everything else.
 */
function accessibleName(input: {
  identifier: string;
  title: string;
  stateName: string;
  assignee: string | null;
  priorityLabel: string | null;
  secondLine: string | null;
}): string {
  const parts = [`${input.identifier}, ${input.title}`, input.stateName];
  if (input.priorityLabel !== null && input.priorityLabel !== "") parts.push(input.priorityLabel);
  if (input.assignee !== null) parts.push(`assigned to ${input.assignee}`);
  if (input.secondLine !== null) parts.push(input.secondLine);
  return parts.join(", ");
}

/** Two glyphs at most: an avatar slot is 20px and three initials do not fit
 *  at a legible size. Grapheme-aware so a name starting with an emoji or an
 *  astral-plane character does not produce half a surrogate pair. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const firstOf = (word: string) => [...word][0] ?? "";
  const initials =
    words.length === 1 ? firstOf(words[0]!) : `${firstOf(words[0]!)}${firstOf(words[1]!)}`;
  return initials.toUpperCase();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Grouping                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export interface GroupingContext {
  readonly grouping: Grouping;
  readonly states: ReadonlyMap<string, WorkflowStateRow>;
  readonly members: ReadonlyMap<string, MemberRow>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly cycleNames: ReadonlyMap<string, string>;
}

export function groupRows(
  issues: readonly IssueRow[],
  views: readonly IssueRowView[],
  context: GroupingContext,
): IssueGroup[] {
  if (context.grouping === "none") {
    return [{ key: "all", label: "", count: views.length, tone: "unknown", rows: [...views] }];
  }

  const buckets = new Map<
    string,
    { label: string; tone: Tone; order: number; rows: IssueRowView[] }
  >();

  issues.forEach((issue, index) => {
    const view = views[index];
    if (view === undefined) return;
    const bucket = bucketFor(issue, context);
    const existing = buckets.get(bucket.key);
    if (existing === undefined) {
      buckets.set(bucket.key, { ...bucket, rows: [view] });
      return;
    }
    existing.rows.push(view);
  });

  return [...buckets.entries()]
    .sort((a, b) =>
      a[1].order === b[1].order
        ? compareTitles(a[1].label, b[1].label)
        : a[1].order - b[1].order,
    )
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      count: bucket.rows.length,
      tone: bucket.tone,
      rows: bucket.rows,
    }));
}

/**
 * Ordering within a grouping.
 *
 * State groups sort by `type` first and then by `position` inside it, which is
 * Linear's own ordering and the only one that puts Triage above Backlog above
 * In Progress rather than alphabetically. Everything without a natural order —
 * no project, no cycle, unassigned — sorts last, because an "unassigned" group
 * at the top pushes the work with owners off the screen.
 */
const TYPE_ORDER: Record<string, number> = {
  triage: 0,
  started: 1,
  unstarted: 2,
  backlog: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

function bucketFor(
  issue: IssueRow,
  context: GroupingContext,
): { key: string; label: string; tone: Tone; order: number } {
  switch (context.grouping) {
    case "state": {
      const state = issue.stateId === null ? undefined : context.states.get(issue.stateId);
      const type = state?.type ?? "unknown";
      return {
        key: state?.id ?? "no-state",
        label: state?.name ?? "No state",
        tone: toneForStateType(state?.type),
        order: (TYPE_ORDER[type] ?? 9) * 1000 + (state?.position ?? 0),
      };
    }
    case "project": {
      if (issue.projectId === null) {
        return { key: "no-project", label: "No project", tone: "unknown", order: 1_000_000 };
      }
      return {
        key: issue.projectId,
        label: context.projectNames.get(issue.projectId) ?? "Unknown project",
        tone: "unknown",
        order: 0,
      };
    }
    case "cycle": {
      if (issue.cycleId === null) {
        return { key: "no-cycle", label: "No cycle", tone: "unknown", order: 1_000_000 };
      }
      return {
        key: issue.cycleId,
        label: context.cycleNames.get(issue.cycleId) ?? "Unknown cycle",
        tone: "unknown",
        order: 0,
      };
    }
    case "assignee": {
      if (issue.assigneeId === null) {
        return { key: "unassigned", label: "Unassigned", tone: "unknown", order: 1_000_000 };
      }
      const member = context.members.get(issue.assigneeId);
      return {
        key: issue.assigneeId,
        label: member?.displayName ?? "Unknown",
        tone: "unknown",
        // The viewer's own work first. It is the group they came to look at.
        order: member?.isMe === true ? -1 : 0,
      };
    }
    case "none":
      return { key: "all", label: "", tone: "unknown", order: 0 };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The panel                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export interface PanelInput {
  readonly hasCredential: boolean;
  readonly boundTeams: readonly TeamRow[];
  /** The team the header selector currently names, or `null` for "All bound
   *  teams". */
  readonly selectedTeam: TeamRow | null;
  /** Whether anything at all has ever been written to the mirror for this
   *  scope. Distinguishes "still reading" from "there is nothing". */
  readonly hasEverSynced: boolean;
  readonly issues: readonly IssueRow[];
  readonly views: readonly IssueRowView[];
  readonly grouping: GroupingContext;
  /** Post-filter total for the current scope; `shown` is what fits the render
   *  window. */
  readonly total: number;
  /** Count with every facet cleared, for the "see all 214" sentence. */
  readonly totalWithoutFilters: number;
  readonly activeFacets: readonly string[];
  readonly notice: PanelNotice | null;
}

export function selectPanelState(input: PanelInput): PanelView {
  const notice = input.notice;

  if (!input.hasCredential) return { notice, state: { kind: "no-credential" } };
  if (input.boundTeams.length === 0) return { notice, state: { kind: "no-binding" } };

  const teamName = input.selectedTeam?.name ?? null;

  if (input.views.length > 0) {
    return {
      notice,
      state: {
        kind: "rows",
        groups: groupRows(input.issues, input.views, input.grouping),
        shown: input.views.length,
        total: input.total,
      },
    };
  }

  // Order matters here and it is the whole point of this function. "Still
  // reading" must be checked before "nothing matches", and "nothing matches
  // your filter" before "this team has no open issues" — the three read
  // differently on purpose, and getting the order wrong makes the plugin
  // confidently wrong at the exact moment a stranger is deciding whether to
  // keep it.
  if (!input.hasEverSynced) return { notice, state: { kind: "first-sync", teamName } };

  if (input.activeFacets.length > 0) {
    return {
      notice,
      state: {
        kind: "empty-filter",
        facets: [...input.activeFacets],
        totalWithoutFilters: input.totalWithoutFilters,
      },
    };
  }

  return {
    notice,
    state: { kind: "empty-team", teamName: teamName ?? "These teams" },
  };
}
