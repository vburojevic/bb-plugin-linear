import type { IssueRowView } from "../contract.js";
import type { IssueRow } from "../store/rows.js";

/**
 * The Working set — the panel's argument for existing.
 *
 * The rejected alternative is mirroring Linear's own board: group by state,
 * sort by priority, filter by cycle. It loses on its own terms. That is
 * linear.app's left rail reimplemented without drag, without its keyboard
 * model, without realtime, behind a ten-second poller — and it answers no
 * question faster than the browser tab you already have open.
 *
 * These five buckets answer five questions the browser tab **cannot answer at
 * all**, because only bb knows about threads, worktrees and pull requests.
 * They are ordered by what you would do next, and the order is the whole
 * design: the top of this list should be the next thing you touch.
 *
 * State, project and cycle grouping survive as a lens on *All issues*, where
 * they belong.
 */

export type WorkingBucketId =
  | "running"
  | "started-no-pr"
  | "pr-needs-you"
  | "assigned-unstarted"
  | "blocked";

export interface WorkingBucket {
  readonly id: WorkingBucketId;
  readonly label: string;
  /** One line saying why this bucket is empty, shown instead of the rows. A
   *  bucket with nothing in it says nothing at all unless every bucket is
   *  empty. */
  readonly emptyHint: string;
  readonly issueIds: readonly string[];
}

export interface WorkingFacts {
  /** Issue ids with a live bb thread. */
  readonly running: ReadonlySet<string>;
  /** Issue ids with any thread at all, running or not. */
  readonly threaded: ReadonlySet<string>;
  /** Issue ids with an environment branch resolved to them. */
  readonly branched: ReadonlySet<string>;
  /** Issue id → the pull request's resolved `attention`, from `pr_state`. */
  readonly pullRequests: ReadonlyMap<string, { readonly attention: string }>;
  /** Issue id → identifiers of the open issues blocking it. */
  readonly blockers: ReadonlyMap<string, readonly string[]>;
  readonly viewerId: string | null;
  /** Issue id → its state's `type`. Never its name. */
  readonly stateTypes: ReadonlyMap<string, string>;
}

/**
 * bb's own resolved attention values that mean *somebody is waiting on you or
 * on this*.
 *
 * Borrowed rather than minted, and deliberately not every value: `none`,
 * `merged` and `draft` are pull requests that are not asking for anything, and
 * a bucket called "PR needs you" containing a merged pull request would be a
 * bucket nobody trusts twice.
 */
const NEEDS_ATTENTION: ReadonlySet<string> = new Set([
  "checks_failed",
  "changes_requested",
  "review_requested",
  "conflicts",
  "blocked",
  "ready_to_merge",
]);

/**
 * Every issue lands in **at most one** bucket, and the first one it qualifies
 * for wins.
 *
 * That is what stops the same issue appearing three times under three
 * headings, which is how a "what should I do next" list becomes a list you
 * have to de-duplicate in your head before it is useful.
 */
export function selectWorkingSet(
  issues: readonly IssueRow[],
  facts: WorkingFacts,
): WorkingBucket[] {
  const claimed = new Set<string>();
  const take = (predicate: (issue: IssueRow) => boolean): string[] => {
    const ids: string[] = [];
    for (const issue of issues) {
      if (claimed.has(issue.id)) continue;
      if (!predicate(issue)) continue;
      claimed.add(issue.id);
      ids.push(issue.id);
    }
    return ids;
  };

  const isFinished = (issue: IssueRow): boolean => {
    const type = issue.stateId === null ? null : (facts.stateTypes.get(issue.stateId) ?? null);
    return type === "completed" || type === "canceled";
  };

  const isStarted = (issue: IssueRow): boolean => {
    const type = issue.stateId === null ? null : (facts.stateTypes.get(issue.stateId) ?? null);
    return type === "started";
  };

  const mine = (issue: IssueRow): boolean =>
    facts.viewerId !== null && issue.assigneeId === facts.viewerId;

  return [
    {
      id: "running",
      label: "Running",
      emptyHint: "No bb thread is running on one of these issues right now.",
      issueIds: take((issue) => facts.running.has(issue.id)),
    },
    {
      id: "pr-needs-you",
      label: "PR needs you",
      emptyHint: "No pull request is waiting on a human.",
      // Above "started, no PR" because it is the only bucket naming an action
      // somebody else is already waiting on.
      issueIds: take((issue) => {
        const pr = facts.pullRequests.get(issue.id);
        return pr !== undefined && NEEDS_ATTENTION.has(pr.attention);
      }),
    },
    {
      id: "started-no-pr",
      label: "In progress, no PR",
      emptyHint: "Nothing in progress is without a pull request.",
      /*
       * Three ways in, and the third one was missing until a live install
       * found it.
       *
       * A thread or a branch qualifies whatever the assignee says, because
       * work is demonstrably happening on this machine. **And an issue you are
       * assigned that is in a started state qualifies too** — which is the
       * single most common thing there is: somebody moves an issue to In
       * Progress in Linear and has not opened bb yet. Requiring a branch meant
       * that issue appeared in no bucket at all, so the Working set answered
       * "nothing needs you right now" while the thing you had just started
       * sat invisible.
       */
      issueIds: take(
        (issue) =>
          !isFinished(issue) &&
          !facts.pullRequests.has(issue.id) &&
          (facts.branched.has(issue.id) ||
            facts.threaded.has(issue.id) ||
            (mine(issue) && isStarted(issue))),
      ),
    },
    {
      id: "blocked",
      label: "Blocked",
      emptyHint: "Nothing assigned to you is blocked.",
      // Before "never started", because a blocked issue you were about to
      // start is worth knowing about before you start it.
      issueIds: take(
        (issue) => mine(issue) && !isFinished(issue) && (facts.blockers.get(issue.id)?.length ?? 0) > 0,
      ),
    },
    {
      id: "assigned-unstarted",
      label: "Assigned to you, never started",
      emptyHint: "Nothing is waiting for you to pick it up.",
      issueIds: take(
        (issue) =>
          mine(issue) &&
          !isFinished(issue) &&
          !isStarted(issue) &&
          !facts.threaded.has(issue.id) &&
          !facts.branched.has(issue.id),
      ),
    },
  ];
}

/** Whether the whole set is empty — which is the only case that gets a
 *  sentence of its own, because five empty headings is a wall of nothing. */
export function isWorkingSetEmpty(buckets: readonly WorkingBucket[]): boolean {
  return buckets.every((bucket) => bucket.issueIds.length === 0);
}

/** A bucket with nothing in it does not render. The hints exist for the one
 *  case where the whole set is empty and the panel should say which five
 *  questions it was asking. */
export function nonEmpty(buckets: readonly WorkingBucket[]): WorkingBucket[] {
  return buckets.filter((bucket) => bucket.issueIds.length > 0);
}

export type { IssueRowView };
