import type { LinearClient } from "../linear/client.js";
import { TEAM_PAGE_SIZE } from "../linear/documents.js";
import type { Store } from "../store/store.js";
import { describeError } from "../linear/errors.js";
import { applyBootstrap, applyBreadth, applyIssues, applyTeamGraph } from "./apply.js";

/**
 * What runs when a key first verifies, and again when a project is bound to a
 * team the mirror has never seen.
 *
 * **The first run does not backfill history.** Open issues only, capped at
 * five page-walks. Fetching five years of closed issues to fill a sidebar
 * spends a stranger's whole hourly budget on their first afternoon, to
 * populate a list nobody scrolls to the bottom of — and it is the behaviour
 * that gets a plugin uninstalled before it has done anything useful.
 *
 * The cap is 500 rows because that is roughly two screens of every grouping
 * the panel offers, and because the delta poller picks up anything newer
 * within one tick anyway. A workspace larger than that is not under-served; it
 * is served the part of itself that is moving.
 */

/** Five pages of 100. See the header comment for why this number and not a
 *  bigger one. */
export const BACKFILL_PAGE_LIMIT = 5;

export interface BackfillReport {
  readonly teams: number;
  readonly issues: number;
  readonly truncated: boolean;
  /** Pages whose `hasNextPage` was true when the cap ran out — reported so
   *  the caller can say so rather than implying completeness. */
  readonly moreAvailable: boolean;
}

export interface BackfillDeps {
  readonly client: LinearClient;
  /** Which settings slot this client's key came from. Recorded on every
   *  workspace and team it discovers, so a later write goes out over the key
   *  that can actually see the target. */
  readonly slot: string;
  readonly store: Store;
  readonly now: () => number;
  readonly log?: (level: "debug" | "info" | "warn", message: string) => void;
  readonly signal?: AbortSignal;
}

/**
 * Fetch the workspace's slow-moving graph.
 *
 * Teams page: `pageInfo.hasNextPage` is followed rather than assumed away,
 * because a large organisation genuinely has more than one page and a picker
 * missing the second page is a picker that cannot bind half the company.
 */
export async function discoverWorkspace(deps: BackfillDeps): Promise<{ teams: number }> {
  let after: string | null = null;
  let teams = 0;
  // A bound loop rather than `while (hasNextPage)`: a cursor that fails to
  // advance — a server-side bug, a filter interaction — would otherwise spin
  // against the request budget until the hour ran out.
  for (let page = 0; page < 20; page += 1) {
    if (deps.signal?.aborted) break;
    const result = await deps.client.bootstrap(after, { initiator: "background" });
    applyBootstrap(deps.store, result, deps.now(), deps.slot);
    teams += result.teams.nodes.length;
    const next = result.teams.pageInfo.hasNextPage ? (result.teams.pageInfo.endCursor ?? null) : null;
    if (next === null || next === after) break;
    after = next;
  }
  if (teams >= TEAM_PAGE_SIZE * 20) {
    deps.log?.("warn", "Stopped listing teams after 20 pages.");
  }
  return { teams };
}

/**
 * The bound teams' own vocabulary — their workflow states, their labels, their
 * assignable people — and nothing else.
 *
 * One request, separable from the issue backfill because the two go stale on
 * completely different clocks. Replacing the API key changes which workspace's
 * columns these *are*; it does not necessarily change a single issue. `bb
 * linear refresh` wants this and not the several hundred requests a full
 * backfill can be.
 */
export async function refreshTeamVocabulary(
  deps: BackfillDeps,
  teamIds: readonly string[],
): Promise<void> {
  if (teamIds.length === 0) return;
  const graph = await deps.client.teamGraph(teamIds, { initiator: "background" });
  applyTeamGraph(deps.store, graph, teamIds, deps.now());

  // A truncated page is stated rather than swallowed. A workspace with more
  // than 150 labels would otherwise get a label picker that is quietly missing
  // some, which looks like a bug in the picker.
  if (graph.issueLabels.pageInfo.hasNextPage) {
    deps.log?.("warn", "This workspace has more labels than one page holds; some are missing from pickers.");
  }
  if (graph.users.pageInfo.hasNextPage) {
    deps.log?.("warn", "This workspace has more members than one page holds; some are missing from pickers.");
  }

  // Who can actually be assigned. A failure here is not a failure of the
  // vocabulary: the assignee picker falls back to the workspace list, which is
  // what it offered before membership was read at all.
  try {
    const membership = await deps.client.teamMembers(teamIds, { initiator: "background" });
    for (const team of membership.teams.nodes) {
      deps.store.replaceTeamMembers(
        team.id,
        team.members.nodes.map((member) => member.id),
      );
      if (team.members.pageInfo.hasNextPage) {
        deps.log?.("warn", `Team ${team.id} has more members than one page holds.`);
      }
    }
  } catch (error) {
    deps.log?.("debug", `Could not read team membership: ${describeError(error)}`);
  }
}

/**
 * Fetch the bound teams' vocabulary and their open issues.
 *
 * Runs on bind, and on the first successful connect for anything already
 * bound. It is deliberately not part of the tick: a backfill is a bounded,
 * user-initiated event with a beginning and an end, while the tick is a
 * steady-state delta, and conflating them is how a poller ends up re-walking
 * a workspace every ten seconds.
 */
export async function backfillTeams(
  deps: BackfillDeps,
  teamIds: readonly string[],
): Promise<BackfillReport> {
  if (teamIds.length === 0) {
    return { teams: 0, issues: 0, truncated: false, moreAvailable: false };
  }

  await refreshTeamVocabulary(deps, teamIds);

  // Projects, milestones and cycles are the slow-moving half of what the
  // detail pane renders. Fetched once alongside the vocabulary rather than
  // per-issue: an issue's project name is the same name for every issue in it.
  try {
    const breadth = await deps.client.breadth(teamIds, { initiator: "background" });
    applyBreadth(deps.store, breadth, deps.now());
  } catch (error) {
    // Breadth is decoration on top of the issue list. Failing to read it must
    // not fail the backfill that fills the panel.
    deps.log?.("debug", `Couldn't read projects and cycles: ${String(error)}`);
  }

  let after: string | null = null;
  let issues = 0;
  let moreAvailable = false;
  let pages = 0;

  for (; pages < BACKFILL_PAGE_LIMIT; pages += 1) {
    if (deps.signal?.aborted) break;
    const result = await deps.client.backfillIssues(teamIds, after, { initiator: "background" });
    const applied = applyIssues(deps.store, result.issues.nodes, deps.now());
    issues += applied.written;

    if (!result.issues.pageInfo.hasNextPage) break;
    const next = result.issues.pageInfo.endCursor ?? null;
    if (next === null || next === after) break;
    after = next;
    moreAvailable = true;
  }

  const truncated = pages >= BACKFILL_PAGE_LIMIT && moreAvailable;
  if (truncated) {
    deps.log?.(
      "info",
      `Stopped after ${issues} open issues. The rest arrive as they are updated.`,
    );
  }

  return { teams: teamIds.length, issues, truncated, moreAvailable: truncated };
}
