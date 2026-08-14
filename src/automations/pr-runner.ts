import { describeError } from "../linear/errors.js";
import type { LinearClient } from "../linear/client.js";
import { identifierFromBranch } from "../git/remote.js";
import { updateIssue, type MutationDeps } from "../mutations.js";
import type { IssueRow } from "../store/rows.js";
import type { Store } from "../store/store.js";
import {
  decideTransition,
  noAutomationMessage,
  type AutomationState,
  type PullRequestOutcome,
} from "./pr-transition.js";

/**
 * The impure half of automation 2: resolve the branch, read the team's
 * automation, ask bb about the pull request, and apply what the pure decision
 * function decided.
 *
 * **The host capability this rests on is `gh pr view` and nothing else**, so
 * this fires on GitHub and not on GitLab, Bitbucket, Gitea or Azure DevOps.
 * That is stated in the README rather than discovered, and the probe below is
 * what keeps a non-GitHub shop from getting an apology attached to every
 * linked thread.
 */

/** The one probe key. A single successful lookup clears it forever. */
export const GH_PROBE_KEY = "pull-request-lookup";

/** A branch that resolves to nothing is cached as such for a day, so a `main`
 *  checkout is not re-queried every tick forever. */
export const NEGATIVE_CACHE_MS = 86_400_000;

export interface PrRunnerDeps {
  /**
   * Every configured key, in slot order.
   *
   * A branch name says nothing about which workspace owns the issue it
   * belongs to, and only the key that can see that workspace can resolve it —
   * so this one is a list, tried in order, and for the single-key install
   * everyone has it is one entry and one request.
   */
  readonly clients: readonly LinearClient[];
  /** The key that can reach a given issue. */
  readonly clientForIssue: (issueId: string) => LinearClient;
  readonly store: Store;
  readonly mutations: MutationDeps;
  readonly now: () => number;
  readonly log?: (level: "debug" | "info" | "warn", message: string) => void;
  /** `bb.sdk.environments.pullRequest`, narrowed to the three outcomes. */
  readonly lookupPullRequest: (environmentId: string) => Promise<
    | {
        outcome: "available";
        pullRequest: {
          number: number;
          title: string;
          state: "draft" | "open" | "merged" | "closed";
          url: string;
          baseRefName: string;
          attention: string;
        };
      }
    | { outcome: "absent" }
    | { outcome: "unavailable"; message: string }
  >;
}

export type RunOutcome =
  | { readonly kind: "moved"; readonly identifier: string; readonly stateName: string | null; readonly because: string }
  | { readonly kind: "held"; readonly reason: string; readonly detail: string }
  | { readonly kind: "skipped"; readonly why: string };

/**
 * Resolve a branch to an issue, Linear's way first.
 *
 * `issueVcsBranchSearch` already understands the workspace's own
 * `gitBranchFormat`, its magic-word suffixes and any custom convention. The
 * regex is the fallback, and its result is recorded as `regex` so the UI can
 * be less confident about it.
 */
export async function resolveBranch(
  deps: PrRunnerDeps,
  environmentId: string,
  branchName: string,
): Promise<IssueRow | null> {
  const cached = deps.store.branchLink(environmentId);
  if (cached !== null && cached.branchName === branchName) {
    if (cached.issueId !== null) return deps.store.issue(cached.issueId);
    // A negative cache with a TTL: `main` should not be re-queried every tick
    // for the rest of time.
    if (deps.now() - cached.resolvedAt < NEGATIVE_CACHE_MS) return null;
  }

  for (const candidate of deps.clients) {
    try {
      const result = await candidate.branchSearch(branchName, { initiator: "background" });
      const found = result.issueVcsBranchSearch;
      if (found !== null) {
        deps.store.putBranchLink({
          environmentId,
          branchName,
          issueId: found.id,
          resolution: "linear",
          resolvedAt: deps.now(),
        });
        return deps.store.issue(found.id);
      }
    } catch (error) {
      // One workspace not answering must not stop the others being asked: a
      // revoked second key would otherwise silently disable branch linking
      // for the first.
      deps.log?.("debug", `Branch lookup failed: ${describeError(error)}`);
    }
  }

  // Linear said no. The fallback, recorded as such.
  const identifier = identifierFromBranch(branchName);
  const guess = identifier === null ? null : deps.store.issueByIdentifier(identifier);
  deps.store.putBranchLink({
    environmentId,
    branchName,
    issueId: guess?.id ?? null,
    resolution: guess === null ? "none" : "regex",
    resolvedAt: deps.now(),
  });
  return guess;
}

function toAutomationStates(rows: ReturnType<Store["gitAutomation"]>): AutomationState[] {
  return rows
    .filter((row): row is typeof row & { event: AutomationState["event"] } =>
      ["draft", "merge", "mergeable", "review", "start"].includes(row.event),
    )
    .map((row) => ({
      event: row.event,
      stateId: row.stateId,
      stateName: row.stateName,
      targetBranchPattern: row.targetBranchPattern,
      targetBranchIsRegex: row.targetBranchIsRegex,
    }));
}

/**
 * One environment, one decision.
 *
 * Ordered so the expensive and the destructive come last: the branch resolves
 * from cache where possible, the pull-request lookup is a shell-out and
 * happens once, and the mutation only runs when a pure function has already
 * said it should.
 */
export async function runPrTransition(
  deps: PrRunnerDeps,
  input: {
    readonly environmentId: string;
    readonly branchName: string | null;
    readonly enabled: boolean;
    readonly canWrite: (teamId: string) => boolean;
    readonly completedStateId: (teamId: string) => string | null;
  },
): Promise<RunOutcome> {
  if (!input.enabled) return { kind: "skipped", why: "pull-request transitions are off" };
  if (input.branchName === null || input.branchName === "") {
    return { kind: "skipped", why: "this environment has no branch" };
  }

  const issue = await resolveBranch(deps, input.environmentId, input.branchName);
  if (issue === null) return { kind: "skipped", why: "this branch belongs to no issue" };

  const lookup = await deps.lookupPullRequest(input.environmentId);

  // The probe: the first `unavailable` records that this host has never
  // produced a working lookup. A single success clears it forever.
  if (lookup.outcome === "available") {
    deps.store.putProbe(GH_PROBE_KEY, "available", deps.now());
  } else if (lookup.outcome === "unavailable" && deps.store.probe(GH_PROBE_KEY) === null) {
    deps.store.putProbe(GH_PROBE_KEY, "unavailable", deps.now());
  }

  const outcome: PullRequestOutcome =
    lookup.outcome === "available"
      ? {
          outcome: "available",
          state: lookup.pullRequest.state,
          baseRefName: lookup.pullRequest.baseRefName,
          number: lookup.pullRequest.number,
        }
      : { outcome: lookup.outcome };

  // Recorded whatever the decision, because the panel's second line reads
  // `pr_state` and never makes a fresh git-host call per row.
  const existing = deps.store.prState(input.environmentId);
  deps.store.putPrState({
    environmentId: input.environmentId,
    issueId: issue.id,
    prNumber: lookup.outcome === "available" ? lookup.pullRequest.number : null,
    prUrl: lookup.outcome === "available" ? lookup.pullRequest.url : null,
    prState: lookup.outcome === "available" ? lookup.pullRequest.state : null,
    prAttention: lookup.outcome === "available" ? lookup.pullRequest.attention : null,
    appliedStateId: null,
    appliedAt: null,
    lastSeenAt: deps.now(),
  });

  const state = issue.stateId === null ? null : deps.store.workflowState(issue.stateId);
  const decision = decideTransition({
    pullRequest: outcome,
    automationStates: toAutomationStates(deps.store.gitAutomation(issue.teamId)),
    issueStateType: state?.type ?? "unknown",
    issueStateId: issue.stateId,
    applied:
      existing?.prState != null && existing.appliedStateId != null
        ? { prState: existing.prState, stateId: existing.appliedStateId }
        : null,
    completedStateId: input.completedStateId(issue.teamId),
  });

  if (!decision.move) {
    if (decision.reason === "no-automation") {
      const team = deps.store.team(issue.teamId);
      deps.log?.(
        "info",
        noAutomationMessage({
          teamName: team?.name ?? "This team",
          identifier: issue.identifier,
        }),
      );
    }
    return { kind: "held", reason: decision.reason, detail: decision.detail };
  }

  if (!input.canWrite(issue.teamId)) {
    return {
      kind: "held",
      reason: "read-only-binding",
      detail: `This project can read ${issue.identifier}'s team but not write to it.`,
    };
  }

  try {
    await updateIssue(
      deps.mutations,
      issue.id,
      { stateId: decision.stateId },
      `${issue.identifier} wasn't moved`,
    );
  } catch (error) {
    return { kind: "held", reason: "write-failed", detail: describeError(error) };
  }

  // Applied once, never again — recorded before anything else can run.
  deps.store.putPrState({
    environmentId: input.environmentId,
    issueId: issue.id,
    prNumber: lookup.outcome === "available" ? lookup.pullRequest.number : null,
    prUrl: lookup.outcome === "available" ? lookup.pullRequest.url : null,
    prState: lookup.outcome === "available" ? lookup.pullRequest.state : null,
    prAttention: lookup.outcome === "available" ? lookup.pullRequest.attention : null,
    appliedStateId: decision.stateId,
    appliedAt: deps.now(),
    lastSeenAt: deps.now(),
  });

  // Record the pull request on the issue — but probe first. Linear's own
  // GitHub integration may have linked it already, possibly to a different
  // issue, and `attachmentCreate`'s documented idempotency on `(issueId, url)`
  // cannot see that. Only the probe can tell the plugin to do nothing at all.
  if (lookup.outcome === "available") {
    await linkPullRequest(deps, issue.id, lookup.pullRequest.url, lookup.pullRequest.title);
  }

  return {
    kind: "moved",
    identifier: issue.identifier,
    stateName: decision.stateName,
    because: decision.because,
  };
}

export async function linkPullRequest(
  deps: Pick<PrRunnerDeps, "clientForIssue" | "log">,
  issueId: string,
  url: string,
  title: string,
): Promise<"linked" | "already" | "failed"> {
  try {
    const owner = deps.clientForIssue(issueId);
    const existing = await owner.attachmentsForUrl(url, { initiator: "background" });
    if (existing.attachmentsForURL.nodes.length > 0) return "already";
    await owner.attachPullRequest({ issueId, url, title }, { initiator: "background" });
    return "linked";
  } catch (error) {
    // A failed attachment must never undo a successful transition.
    deps.log?.("debug", `Couldn't link the pull request: ${describeError(error)}`);
    return "failed";
  }
}

/**
 * Whether the per-thread banner row may render at all.
 *
 * While the probe says this host has **never once** produced an `available`
 * lookup, it may not: otherwise a GitLab shop gets a permanent apology
 * attached to every linked thread, which violates the rule that a row says
 * nothing when it has nothing to say. The fact lives in exactly two places
 * instead — the settings section and `bb linear doctor`.
 */
export function mayShowLookupFailure(probe: { outcome: string } | null): boolean {
  return probe !== null && probe.outcome === "available";
}
