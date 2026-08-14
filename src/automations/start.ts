import type { BbPluginApi } from "@bb/plugin-sdk";
import { scopeFor } from "../bindings.js";
import { describeError } from "../linear/errors.js";
import type { LinearClient } from "../linear/client.js";
import { updateIssue, type MutationDeps } from "../mutations.js";
import type { BindingRow, IssueRow } from "../store/rows.js";
import type { Store } from "../store/store.js";
import { applyIssueDetail } from "../sync/apply.js";
import {
  buildSpawnRequest,
  startedStateFor,
  toSpawnIssue,
  type SpawnBranchMode,
  type SpawnPreconditions,
} from "./spawn.js";

/**
 * The impure half of "start a thread from an issue": the preconditions bb has
 * to be asked about, the spawn, the link, and the status move.
 *
 * Split from `spawn.ts` so the decisions — which environment, which title,
 * which fallback and why — stay pure and testable, and this file is only the
 * sequence.
 *
 * **Every failure mode still does the useful half.** A key that cannot write
 * still gets a thread; the row just says the issue was not moved and why.
 */

export interface StartResult {
  readonly ok: boolean;
  readonly threadId: string | null;
  readonly message: string;
  /** A branch-mode fallback, or a status move that did not happen. Shown
   *  rather than swallowed. */
  readonly note: string | null;
}

export interface StartDeps {
  readonly bb: BbPluginApi;
  /** The key that can reach a given issue. A Linear key is scoped to one
   *  workspace, and this bb may hold several. */
  readonly clientForIssue: (issueId: string) => LinearClient;
  /** Resolve one issue through only the credentials represented by the
   *  selected project's read scope. */
  readonly refreshIssue: (
    idOrIdentifier: string,
    readTeamIds: readonly string[],
  ) => Promise<IssueRow | null>;
  readonly store: Store;
  readonly mutations: MutationDeps;
  readonly bindings: () => readonly BindingRow[];
  readonly branchMode: () => SpawnBranchMode;
  readonly movesStatus: () => boolean;
  readonly now: () => number;
  readonly publish: () => void;
}

/**
 * Ask bb what it knows about this project's branches.
 *
 * `branchesTruncated` is the field that matters: a branch absent from a
 * truncated list is not a branch that does not exist. The issue's own branch
 * name goes in as `query` so the filtered answer is small enough to be
 * complete, and a truncated answer is reported as "could not confirm" rather
 * than as "missing".
 */
async function checkPreconditions(
  deps: StartDeps,
  projectId: string,
  branchName: string,
): Promise<SpawnPreconditions> {
  const project = await deps.bb.sdk.projects.get({ projectId });
  const hostId = project.sources?.find((source) => source.isDefault)?.hostId ?? null;
  const path = project.sources?.find((source) => source.isDefault)?.path ?? null;

  if (hostId === null) {
    return {
      branchExists: false,
      branchListComplete: true,
      treeClean: false,
      hostId: null,
      workspacePath: null,
    };
  }

  const branches = await deps.bb.sdk.projects.branches({
    projectId,
    hostId,
    query: branchName,
  });

  return {
    branchExists: branches.branches.includes(branchName),
    branchListComplete: !branches.branchesTruncated,
    treeClean: !branches.hasUncommittedChanges,
    hostId,
    workspacePath: path,
  };
}

export async function startThreadFromIssue(
  deps: StartDeps,
  input: { readonly issueId: string; readonly projectId?: string },
): Promise<StartResult> {
  const bindings = deps.bindings();

  // Resolve only after a bb project establishes the read scope. An identifier
  // such as ENG-42 is not globally unique once two Linear workspaces are
  // connected; singular lookup before this point lets SQLite pick which
  // company's issue gets a thread — and, optionally, a status move.
  const exact = deps.store.issue(input.issueId);
  const matches = exact === null ? deps.store.issuesByIdentifier(input.issueId) : [exact];
  let projectId = input.projectId;
  if (projectId === undefined) {
    const matchingTeamIds = new Set(matches.map((row) => row.teamId));
    const candidates = [
      ...new Set(
        bindings
          .filter((row) => matches.length === 0 || matchingTeamIds.has(row.teamId))
          .map((row) => row.projectId),
      ),
    ];
    if (candidates.length === 0) {
      return {
        ok: false,
        threadId: null,
        message: "No bb project is bound to a readable Linear team. Bind one first.",
        note: null,
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        threadId: null,
        message: "More than one bb project could own this issue. Say which one.",
        note: null,
      };
    }
    projectId = candidates[0]!;
  }

  const scope = scopeFor(projectId, bindings);
  const inScope = matches.filter((row) => scope.readTeamIds.includes(row.teamId));
  if (inScope.length > 1) {
    return {
      ok: false,
      threadId: null,
      message: `${input.issueId} exists more than once in this project's Linear scope. Use the issue id or URL.`,
      note: null,
    };
  }
  let issue: IssueRow | null = inScope[0] ?? null;
  if (issue === null) {
    issue = await deps.refreshIssue(input.issueId, scope.readTeamIds);
  }
  if (issue === null || !scope.readTeamIds.includes(issue.teamId)) {
    return {
      ok: false,
      threadId: null,
      message: `No issue called ${input.issueId} is readable by that project.`,
      note: null,
    };
  }

  const detail = await deps.clientForIssue(issue.id).issueDetail(issue.id, {
    initiator: "user",
  });
  // The issue may have moved teams since the mirror row was written. Check
  // the fresh team before persisting any returned title, description or
  // comments, then re-read the row used by every downstream action.
  if (!scope.readTeamIds.includes(detail.issue.team.id)) {
    return {
      ok: false,
      threadId: null,
      message: `${input.issueId} moved outside that project's Linear scope.`,
      note: null,
    };
  }
  applyIssueDetail(deps.store, detail.issue, deps.now());
  issue = deps.store.issue(detail.issue.id);
  if (issue === null) {
    return {
      ok: false,
      threadId: null,
      message: `Couldn't read ${input.issueId}.`,
      note: null,
    };
  }

  const mode = deps.branchMode();
  const preconditions =
    mode === "exact"
      ? await checkPreconditions(deps, projectId, detail.issue.branchName)
      : {
          branchExists: false,
          branchListComplete: true,
          treeClean: true,
          hostId: null,
          workspacePath: null,
        };

  const states = deps.store.workflowStates(issue.teamId);
  const plan = buildSpawnRequest({
    issue: toSpawnIssue(detail.issue, {
      memberName: (id) =>
        deps.store.members([issue.teamId]).find((member) => member.id === id)?.displayName ?? null,
      labelName: (id) => deps.store.labels([issue.teamId]).find((label) => label.id === id)?.name ?? null,
      stateName: (id) => states.find((state) => state.id === id)?.name ?? null,
    }),
    projectId,
    mode,
    preconditions,
  });

  const thread = await deps.bb.sdk.threads.spawn(plan.request as never);

  // Written before the spawn call's result reaches any surface, so the
  // composer banner and the thread header chip are correct on the thread's
  // first paint rather than one poll later.
  deps.store.linkThread({
    threadId: thread.id,
    issueId: issue.id,
    teamId: issue.teamId,
    projectId,
    createdAt: deps.now(),
    origin: "spawn",
  });
  deps.publish();

  const notes = plan.note === null ? [] : [plan.note];

  // The status move is the part that can fail on its own, and its failure
  // must not take the thread with it: the useful half already happened.
  if (deps.movesStatus() && scope.writeTeamIds.includes(issue.teamId)) {
    const started = startedStateFor(states);
    if (started === null) {
      notes.push(
        `${deps.store.team(issue.teamId)?.name ?? "This team"} has no started state, so ${issue.identifier} wasn't moved.`,
      );
    } else if (issue.stateId !== started.id) {
      try {
        await updateIssue(
          deps.mutations,
          issue.id,
          { stateId: started.id },
          `${issue.identifier} wasn't moved`,
        );
        notes.push(`${issue.identifier} → ${started.name}`);
      } catch (error) {
        notes.push(`Couldn't move ${issue.identifier}: ${describeError(error)}`);
      }
    }
  }

  return {
    ok: true,
    threadId: thread.id,
    message: `Started a thread on ${issue.identifier}.`,
    note: notes.length === 0 ? null : notes.join(" "),
  };
}

/** Link or unlink the current thread. `issueId: null` unlinks. */
export function setThreadLink(
  deps: Pick<StartDeps, "store" | "now" | "publish">,
  input: { threadId: string; issue: IssueRow | null; projectId: string | null },
): void {
  if (input.issue === null) {
    deps.store.unlinkThread(input.threadId);
  } else {
    deps.store.linkThread({
      threadId: input.threadId,
      issueId: input.issue.id,
      teamId: input.issue.teamId,
      projectId: input.projectId,
      createdAt: deps.now(),
      origin: "manual",
    });
  }
  deps.publish();
}
