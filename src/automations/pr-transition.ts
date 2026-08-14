/**
 * Should this pull request move this issue, and where to?
 *
 * The decision is a **pure function with no I/O and no clock**, because it is
 * the one piece of this plugin that can silently do the wrong thing to
 * somebody else's board. Every branch of it is table-tested.
 *
 * Two rules run through all of it.
 *
 * **`unavailable` is not `absent`.** bb's `environments.pullRequest` returns a
 * three-outcome union and its own doc comment says why: "'unavailable' means
 * the lookup itself failed (gh missing, not authenticated, timeout,
 * unreachable workspace), so callers must not render it as 'no PR exists'."
 * They are separate cases here and named separately, so nobody can collapse
 * them later without deleting a test.
 *
 * **The target state comes from the team, never from a name.** Linear's own
 * `gitAutomationStates` *is* the user's configuration of exactly this
 * automation, including per-target-branch variants. Reading it means the
 * plugin matches a workspace's existing behaviour on day one in a workspace it
 * has never seen. Where a team has configured nothing, the plugin **holds and
 * says so** rather than falling back to a state whose *name* looks review-ish
 * — that heuristic matches English, and a workspace whose states are
 * "Überprüfung", "レビュー" or "En revisión" would silently resolve to the
 * lowest-position started state and move In Progress to In Progress with no
 * error to search for.
 */

/** `GitAutomationStates` is a real enum: `draft | merge | mergeable | review |
 *  start`. Matching on these is safe in a way matching a state name is not. */
export type GitAutomationEvent = "draft" | "merge" | "mergeable" | "review" | "start";

export interface AutomationState {
  readonly event: GitAutomationEvent;
  /** `GitAutomationState.state` is nullable — a configured event with no state
   *  is a real row and means "do nothing". */
  readonly stateId: string | null;
  readonly stateName: string | null;
  readonly targetBranchPattern: string | null;
  readonly targetBranchIsRegex: boolean;
}

export type PullRequestOutcome =
  | { readonly outcome: "available"; readonly state: "draft" | "open" | "merged" | "closed"; readonly baseRefName: string; readonly number: number }
  | { readonly outcome: "absent" }
  | { readonly outcome: "unavailable" };

export interface TransitionInput {
  readonly pullRequest: PullRequestOutcome;
  readonly automationStates: readonly AutomationState[];
  /** The issue's current state type, from its own team's rows. */
  readonly issueStateType: string;
  readonly issueStateId: string | null;
  /** What this plugin last applied for this environment, so an applied
   *  transition is never applied twice. */
  readonly applied: { readonly prState: string; readonly stateId: string } | null;
  /** A per-binding override for the merge event, chosen by the user when
   *  their team has configured no automation. */
  readonly completedStateId: string | null;
}

export type TransitionDecision =
  | { readonly move: true; readonly stateId: string; readonly stateName: string | null; readonly because: string }
  | { readonly move: false; readonly reason: TransitionHoldReason; readonly detail: string };

export type TransitionHoldReason =
  | "lookup-unavailable"
  | "no-pull-request"
  | "closed-not-merged"
  | "issue-finished"
  | "already-applied"
  | "no-automation"
  | "no-state-configured";

/**
 * Compile a target-branch pattern, safely.
 *
 * A user-authored regex reaches this from Linear's own settings, so it can be
 * anything: invalid, catastrophically backtracking, or a novel. It is compiled
 * inside a try/catch with a length cap, and a pattern that throws is **skipped
 * rather than crashing the service** — one bad row in one team's settings must
 * not stop the automation for every other team.
 */
export function matchesTargetBranch(
  state: AutomationState,
  baseRefName: string,
): boolean {
  if (state.targetBranchPattern === null || state.targetBranchPattern === "") return true;
  if (state.targetBranchPattern.length > 256) return false;

  if (!state.targetBranchIsRegex) {
    return state.targetBranchPattern === baseRefName;
  }
  const pattern = safeBranchPattern(state.targetBranchPattern);
  return pattern === null ? false : wildcardMatch(pattern, baseRefName);
}

type SafePatternToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "wildcard" };

/** Linear calls this field a regex, but arbitrary backtracking syntax cannot
 * run on bb's event loop. Support the useful deterministic subset: anchors,
 * literals, escaped literals, and `.*`. Everything else is refused. */
function safeBranchPattern(raw: string): readonly SafePatternToken[] | null {
  let pattern = raw;
  const anchoredStart = pattern.startsWith("^");
  const anchoredEnd = pattern.endsWith("$") && !pattern.endsWith("\\$");
  if (anchoredStart) pattern = pattern.slice(1);
  if (anchoredEnd) pattern = pattern.slice(0, -1);

  const tokens: SafePatternToken[] = [];
  if (!anchoredStart) tokens.push({ kind: "wildcard" });
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return null;
      // Letter/digit escapes carry regex semantics (\d, \w, backrefs,
      // unicode escapes). Reading them as the final character can silently
      // select an automation for the wrong branch, so this subset refuses them.
      if (/^[A-Za-z0-9]$/.test(escaped)) return null;
      tokens.push({ kind: "literal", value: escaped });
      index += 1;
      continue;
    }
    if (char === "." && pattern[index + 1] === "*") {
      if (tokens.at(-1)?.kind !== "wildcard") tokens.push({ kind: "wildcard" });
      index += 1;
      continue;
    }
    if (".^$+?()[]{}|*".includes(char)) return null;
    tokens.push({ kind: "literal", value: char });
  }
  if (!anchoredEnd && tokens.at(-1)?.kind !== "wildcard") tokens.push({ kind: "wildcard" });
  return tokens;
}

/** Glob-style dynamic programming. Runtime is bounded by pattern × branch
 * length and never depends on a regex engine's backtracking choices. */
function wildcardMatch(tokens: readonly SafePatternToken[], value: string): boolean {
  let previous = new Array<boolean>(value.length + 1).fill(false);
  previous[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(value.length + 1).fill(false);
    if (token.kind === "wildcard") {
      next[0] = previous[0]!;
      for (let index = 1; index <= value.length; index += 1) {
        next[index] = previous[index]! || next[index - 1]!;
      }
    } else {
      for (let index = 1; index <= value.length; index += 1) {
        next[index] = previous[index - 1]! && value[index - 1] === token.value;
      }
    }
    previous = next;
  }
  return previous[value.length]!;
}

function findAutomation(
  states: readonly AutomationState[],
  event: GitAutomationEvent,
  baseRefName: string,
): AutomationState | null {
  const candidates = states.filter((state) => state.event === event);
  if (candidates.length === 0) return null;
  // A pattern that names this base branch beats the catch-all, which is what
  // makes per-target-branch configuration mean anything.
  const specific = candidates.find(
    (state) =>
      state.targetBranchPattern !== null &&
      state.targetBranchPattern !== "" &&
      matchesTargetBranch(state, baseRefName),
  );
  if (specific !== undefined) return specific;
  return (
    candidates.find(
      (state) => state.targetBranchPattern === null || state.targetBranchPattern === "",
    ) ?? null
  );
}

export function decideTransition(input: TransitionInput): TransitionDecision {
  const { pullRequest } = input;

  // Never a transition. "The lookup failed" and "there is no pull request" are
  // different facts and only one of them is a reason to act.
  if (pullRequest.outcome === "unavailable") {
    return {
      move: false,
      reason: "lookup-unavailable",
      detail: "bb couldn't reach the git host, so nothing was moved.",
    };
  }

  // No pull request is not a reason to move anything backwards.
  if (pullRequest.outcome === "absent") {
    return { move: false, reason: "no-pull-request", detail: "This branch has no pull request." };
  }

  // Somebody finished it by hand. Do not drag it back.
  if (input.issueStateType === "completed" || input.issueStateType === "canceled") {
    return {
      move: false,
      reason: "issue-finished",
      detail: "The issue is already finished, so nothing was moved.",
    };
  }

  // Closed without merging means neither done nor cancelled, and guessing
  // either is worse than silence.
  if (pullRequest.state === "closed") {
    return {
      move: false,
      reason: "closed-not-merged",
      detail: "The pull request was closed without merging, so nothing was moved.",
    };
  }

  const event: GitAutomationEvent = pullRequest.state === "merged" ? "merge" : pullRequest.state === "draft" ? "draft" : "review";
  const automation = findAutomation(input.automationStates, event, pullRequest.baseRefName);

  // A configured event whose state is null is a deliberate "do nothing", and
  // it is a different answer from "nothing is configured".
  if (automation !== null && automation.stateId === null) {
    return {
      move: false,
      reason: "no-state-configured",
      detail: "This team's git automation has no state for that event.",
    };
  }

  let targetId = automation?.stateId ?? null;
  let targetName = automation?.stateName ?? null;

  // The one fallback, and only for merge. A completed state is identifiable by
  // `type` rather than by name, so this one is safe in any language — which is
  // exactly why the review event has no equivalent.
  if (targetId === null && event === "merge" && input.completedStateId !== null) {
    targetId = input.completedStateId;
  }

  if (targetId === null) {
    return {
      move: false,
      reason: "no-automation",
      detail: "This team has no git automation configured in Linear for that event.",
    };
  }

  // Applied once, never again — so a user who moves the issue back by hand
  // afterwards is not overruled on the next tick. Keyed on the pair, so a
  // *different* pull-request state still transitions.
  if (
    input.applied !== null &&
    input.applied.prState === pullRequest.state &&
    input.applied.stateId === targetId
  ) {
    return {
      move: false,
      reason: "already-applied",
      detail: "This transition has already been applied.",
    };
  }

  if (input.issueStateId === targetId) {
    return {
      move: false,
      reason: "already-applied",
      detail: "The issue is already in that state.",
    };
  }

  return {
    move: true,
    stateId: targetId,
    stateName: targetName,
    because: `when #${pullRequest.number} ${describeEvent(pullRequest.state)}`,
  };
}

function describeEvent(state: "draft" | "open" | "merged" | "closed"): string {
  switch (state) {
    case "merged":
      return "merged";
    case "draft":
      return "was opened as a draft";
    case "open":
      return "opened";
    case "closed":
      return "closed";
  }
}

/**
 * The sentence a team with no configuration reads.
 *
 * Named rather than silent, and once rather than every tick: a no-op the user
 * cannot see is indistinguishable from a broken plugin.
 */
export function noAutomationMessage(input: {
  readonly teamName: string;
  readonly identifier: string;
}): string {
  return (
    `${input.teamName} has no git automation configured in Linear, so bb isn't moving ` +
    `${input.identifier} for its pull request. Set it up in Linear, or choose a review state for this binding.`
  );
}
