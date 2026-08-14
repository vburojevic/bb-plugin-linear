import { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { crossTeamRefusal, scopeFor, type Scope } from "./bindings.js";
import type { LinearClient } from "./linear/client.js";
import { describeError } from "./linear/errors.js";
import {
  attachUrl,
  clientId,
  createIssue,
  postComment,
  relateIssues,
  updateIssue,
  type MutationDeps,
} from "./mutations.js";
import type { AgentWrites } from "./settings.js";
import { UNTRUSTED_LINEAR_POLICY } from "./security-boundaries.js";
import type { BindingRow, IssueRow, TeamRow } from "./store/rows.js";
import type { Store } from "./store/store.js";
import {
  changeSummary,
  issueDetailText,
  listSummary,
  teamContextText,
  type IssueContext,
} from "./tools-format.js";

/**
 * Agent tools, namespaced `linear_*`.
 *
 * The namespace is not decoration: a cross-plugin name collision **silently
 * drops the registration** and puts the reason in this plugin's status detail,
 * where nobody is looking. `linear_search` cannot collide with anything;
 * `search` certainly can.
 *
 * Three rules hold for all of them.
 *
 * **They read from the mirror.** No tool waits on Linear unless it is writing
 * or explicitly asked to (`remote: true` on search). An agent that stalls for
 * a round trip per lookup is an agent that stops using the tool.
 *
 * **They are scoped by the calling thread's project binding**, and a
 * cross-team request gets a named refusal rather than an empty list. A filter
 * artefact teaches a model that the issue does not exist; a refusal teaches it
 * the actual rule, which it can then explain to the human.
 *
 * **They are withheld rather than degraded.** An unbound project gets no
 * Linear tools at all plus one sentence saying why — an agent is never handed
 * a capability it will then be refused.
 */

export interface ToolDeps {
  readonly store: Store;
  /** Pre-warmed, because `configure` and `contributeInstructions` are
   *  **synchronous** and run on the thread-start path. Reading bindings from
   *  SQLite there would put a query on every thread start; reaching the
   *  network would be worse. */
  readonly bindings: () => readonly BindingRow[];
  readonly agentWrites: () => AgentWrites;
  readonly mutations: MutationDeps;
  /** Fetch one issue from Linear into the mirror, for the case where an agent
   *  names an issue the poller has not seen. */
  readonly refreshIssue: (
    idOrIdentifier: string,
    readTeamIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<IssueRow | null>;
  /** Manifest skill names to select. An **unknown** name rejects this
   *  plugin's whole selection for the resolution, so this is supplied by the
   *  caller that knows which skills actually shipped rather than assumed
   *  here. */
  readonly skills: () => string[];
  /** The key that can write to a given team. A Linear key is scoped to one
   *  workspace, and this bb may hold several. */
  readonly clientForTeam: (teamId: string) => LinearClient;
  /** Linear's own search, scoped to the given teams. Null when it could not be
   *  reached — the caller falls back to the local answer and says so. */
  readonly searchRemote: (
    query: string,
    teamIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<IssueRow[] | null>;
  /** Run a saved view server-side at Linear. Null when there is no such view.
   *  `filterData` is opaque, so this is the only way to honour one. */
  readonly runView: (
    viewId: string,
    readTeamIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<{ name: string; issues: IssueRow[] } | null>;
  /** Injected rather than imported so the tool layer stays testable without a
   *  bb server. */
  readonly startThread: (input: {
    issueId: string;
    projectId: string;
  }) => Promise<{ ok: boolean; message: string; note: string | null }>;
  /** The calling thread's own binding, as a sentence an agent can act on —
   *  the one fact no Linear MCP can know, because only bb holds the link. */
  readonly threadIssue: (threadId: string) => string;
  /** Bind (an id or identifier) or unbind (null) the calling thread. */
  readonly bindThread: (
    threadId: string,
    idOrIdentifier: string | null,
    projectId: string,
  ) => Promise<{ ok: boolean; message: string | null }>;
  readonly now: () => number;
}

/** Read tools are always available on a bound project. The thread tools sit
 *  here even though `linear_thread_bind` writes — it writes bb's own link
 *  table, never Linear, so `agentWrites: "off"` correctly still allows it. */
const READ_TOOLS = [
  "linear_team_context",
  "linear_search",
  "linear_issue_get",
  "linear_issue_list",
  "linear_project_list",
  "linear_cycle_get",
  "linear_view_run",
  "linear_thread_issue",
  "linear_thread_bind",
] as const;

/** `agentWrites: "comment"` — the default — adds only this one. */
const COMMENT_TOOLS = ["linear_comment"] as const;

/** `agentWrites: "full"`. Starting a thread is here rather than with the
 *  comment tools because it spends real resources — an environment, a
 *  worktree, a provider session — and an agent that can do that on a misread
 *  is a worse trade than one that has to ask. */
const WRITE_TOOLS = [
  "linear_issue_update",
  "linear_issue_create",
  "linear_issue_relate",
  "linear_issue_attach",
  "linear_thread_start",
] as const;

export function toolsFor(writes: AgentWrites): string[] {
  if (writes === "off") return [...READ_TOOLS];
  if (writes === "comment") return [...READ_TOOLS, ...COMMENT_TOOLS];
  return [...READ_TOOLS, ...COMMENT_TOOLS, ...WRITE_TOOLS];
}

export const UNBOUND_INSTRUCTION =
  "This project isn't bound to a Linear team, so Linear tools are unavailable here. Bind it from the Linear plugin's settings.";

export function registerTools(bb: BbPluginApi, deps: ToolDeps): void {
  const context = (
    teamIds: readonly string[],
    issues: readonly IssueRow[] = [],
    extraMemberIds: readonly string[] = [],
  ): IssueContext => ({
    states: new Map(
      teamIds
        .map((teamId) => deps.store.team(teamId))
        .filter((team): team is TeamRow => team !== null)
        .flatMap((team) => deps.store.workflowStates(team.id))
        .map((state) => [state.id, state]),
    ),
    members: new Map(
      deps.store
        .membersByIds([
          ...issues
            .map((issue) => issue.assigneeId)
            .filter((id): id is string => id !== null),
          ...extraMemberIds,
        ])
        .map((member) => [member.id, member]),
    ),
    labels: new Map(deps.store.labels(teamIds).map((label) => [label.id, label])),
    priorityLabels: new Map(
      deps.store.priorityValues(teamIds).map((value) => [value.priority, value.label]),
    ),
    teams: new Map(
      teamIds
        .map((teamId) => deps.store.team(teamId))
        .filter((team): team is TeamRow => team !== null)
        .map((team) => [team.id, team]),
    ),
  });

  const scope = (projectId: string): Scope => scopeFor(projectId, deps.bindings());

  /**
   * Resolve a team the caller named, or fall back to the binding's primary.
   *
   * A team outside the declared set is refused **by name**, on both read and
   * write, which is where the scoping rule is taught rather than merely
   * enforced.
   */
  function resolveTeam(
    current: Scope,
    teamKey: string | undefined,
    action: "read" | "write",
  ): TeamRow {
    const allowed = (action === "write" ? current.writeTeamIds : current.readTeamIds)
      .map((id) => deps.store.team(id))
      .filter((team): team is TeamRow => team !== null);

    if (teamKey === undefined) {
      const primary = current.primaryTeamId === null ? null : deps.store.team(current.primaryTeamId);
      if (primary === null) {
        throw new Error(UNBOUND_INSTRUCTION);
      }
      return primary;
    }

    // Resolve only inside the project scope. Consulting the global mirror to
    // improve an error message would disclose another workspace's team name.
    const lowered = teamKey.toLowerCase();
    const inScope = allowed.filter((team) => team.key.toLowerCase() === lowered);
    if (inScope.length === 1) return inScope[0]!;

    if (inScope.length === 0) {
      throw new Error(
        `No team with key ${teamKey} is in this project's Linear scope. Bound teams: ${
          allowed.map((team) => team.key).join(", ") || "none"
        }.`,
      );
    }
    if (inScope.length > 1) {
      const sides = inScope
        .map(
          (team) =>
            `${team.name} in ${deps.store.workspaceForTeam(team.id)?.name ?? "an unknown workspace"}`,
        )
        .join(" and ");
      throw new Error(
        `${teamKey} exists in more than one connected workspace — ${sides}. Say which team you mean by name, or ask the human to disambiguate.`,
      );
    }
    return inScope[0]!;
  }

  /**
   * Find an issue the caller named, and check it is in scope.
   *
   * `Query.issue` accepts a human identifier as well as a UUID, and a
   * user-typed string can silently resolve to something real — so the team is
   * checked *before* anything is written, from the mirror where possible and
   * from one small fetch where not.
   */
  async function resolveIssue(
    current: Scope,
    idOrIdentifier: string,
    action: "read" | "write",
    signal?: AbortSignal,
  ): Promise<IssueRow> {
    // Prefer an in-scope match, then refuse genuine ambiguity. ENG-42 can
    // exist in two connected workspaces, and an agent write that inherits
    // whichever row the index favours lands on the other company's board.
    const permitted = action === "write" ? current.writeTeamIds : current.readTeamIds;
    let local = deps.store.issue(idOrIdentifier);
    if (local !== null && !permitted.includes(local.teamId)) local = null;
    if (local === null) {
      const matches = deps.store.issuesByIdentifier(idOrIdentifier);
      const inScope = matches.filter((row) => permitted.includes(row.teamId));
      if (inScope.length > 1) {
        const sides = inScope
          .map(
            (row) =>
              `"${row.title}" in ${
                deps.store.workspaceForTeam(row.teamId)?.name ?? "an unknown workspace"
              }`,
          )
          .join(" and ");
        throw new Error(
          `${idOrIdentifier} exists in more than one connected workspace — ${sides}. Nothing was changed; use the issue's id or URL instead of its identifier, or ask the human which they mean.`,
        );
      }
      local = inScope[0] ?? null;
    }
    const issue = local ?? (await deps.refreshIssue(idOrIdentifier, permitted, signal));
    if (issue === null) {
      throw new Error(`No issue called ${idOrIdentifier}.`);
    }

    if (!permitted.includes(issue.teamId)) {
      const team = deps.store.team(issue.teamId);
      const allowed = permitted
        .map((id) => deps.store.team(id))
        .filter((entry): entry is TeamRow => entry !== null)
        .map((entry) => ({ name: entry.name, key: entry.key }));
      throw new Error(
        crossTeamRefusal({
          identifier: issue.identifier,
          targetTeam: { name: team?.name ?? "another team", key: team?.key ?? "?" },
          allowed,
          action,
        }),
      );
    }
    return issue;
  }

  /* ── Read ──────────────────────────────────────────────────────────────── */

  bb.agents.registerTool({
    name: "linear_team_context",
    description:
      "The bound Linear team's own vocabulary: its workflow states with their ids and types, its labels, its people, its priority names and its estimate scale. Call this before writing anything to Linear.",
    instructions:
      "Never guess a Linear state, label or priority name. Call linear_team_context first — a team's column may be called anything, in any language, and the `type` beside each state is what carries the meaning.",
    parameters: z.object({
      teamKey: z
        .string()
        .optional()
        .describe("Team key such as ENG. Defaults to this project's primary team."),
    }),
    experimental_statusLabels: {
      pending: "Reading the Linear team's setup",
      completed: "Read the Linear team's setup",
    },
    execute: ({ teamKey }, ctx) => {
      const current = scope(ctx.projectId);
      const team = resolveTeam(current, teamKey, "read");
      return teamContextText({
        team,
        states: deps.store.workflowStates(team.id),
        labels: deps.store.labels([team.id]),
        members: deps.store.assignableMembers([team.id]),
        priorities: deps.store.priorityValues([team.id]),
      });
    },
  });

  bb.agents.registerTool({
    name: "linear_search",
    description:
      "Search Linear issues by text. Answers instantly from bb's local copy of the bound teams' issues. Set remote to search Linear itself, which also finds closed and older issues the local copy does not hold.",
    parameters: z.object({
      query: z.string().min(1).describe("Words to look for in identifiers, titles and bodies."),
      limit: z.number().int().min(1).max(50).optional(),
      remote: z
        .boolean()
        .optional()
        .describe(
          "Ask Linear directly instead of the local copy. Slower and rate limited; use it only when the local search found nothing and you have reason to think the issue exists.",
        ),
    }),
    execute: async ({ query, limit, remote }, ctx) => {
      const current = scope(ctx.projectId);
      if (current.readTeamIds.length === 0) return UNBOUND_INSTRUCTION;

      const local = deps.store.queryIssues({
        teamIds: current.readTeamIds,
        text: query,
        sort: "updated",
        limit: limit ?? 20,
      });

      // Local first, always: it answers in a millisecond and costs nothing.
      // The escalation is opt-in because Linear's search is rate limited to 30
      // requests a minute *separately* from the hourly budget, and an agent
      // that reached for it by default would exhaust that in one loop.
      if (remote !== true) {
        return listSummary(
          local,
          context(current.readTeamIds, local),
          "the teams this project is bound to",
        );
      }

      const found = await deps.searchRemote(query, current.readTeamIds, ctx.signal);
      if (found === null) {
        return `${listSummary(local, context(current.readTeamIds, local), "the teams this project is bound to")}\n\nLinear's own search could not be reached, so this is the local copy only.`;
      }
      return listSummary(
        found,
        context(current.readTeamIds, found),
        "Linear's own search of the bound teams",
      );
    },
  });

  bb.agents.registerTool({
    name: "linear_issue_get",
    description:
      "Read one Linear issue in full: its state, properties, description, sub-issues and recent comments.",
    parameters: z.object({
      issue: z.string().min(1).describe("An identifier such as ENG-42, or an issue id."),
    }),
    experimental_statusLabels: {
      pending: "Reading a Linear issue",
      completed: "Read a Linear issue",
    },
    execute: async ({ issue }, ctx) => {
      const current = scope(ctx.projectId);
      const row = await resolveIssue(current, issue, "read", ctx.signal);
      const children = deps.store.childIssues(row.id, 50);
      const comments = deps.store.comments(row.id);
      const issueContext = context(
        [row.teamId],
        [row],
        comments
          .map((comment) => comment.userId)
          .filter((id): id is string => id !== null),
      );
      const states = issueContext.states;
      return issueDetailText(row, issueContext, {
        comments,
        subIssues: children.map((child) => {
          const type = child.stateId === null ? "" : (states.get(child.stateId)?.type ?? "");
          return {
            identifier: child.identifier,
            title: child.title,
            done: type === "completed" || type === "canceled",
          };
        }),
      });
    },
  });

  bb.agents.registerTool({
    name: "linear_issue_list",
    description:
      "List Linear issues from the bound teams, optionally filtered by state type, assignee or team.",
    parameters: z.object({
      teamKey: z.string().optional(),
      stateType: z
        .string()
        .optional()
        .describe(
          'One of triage, backlog, unstarted, started, completed, canceled, duplicate — the state TYPE, not its name.',
        ),
      assignee: z.enum(["me", "anyone", "unassigned"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    execute: ({ teamKey, stateType, assignee, limit }, ctx) => {
      const current = scope(ctx.projectId);
      if (current.readTeamIds.length === 0) return UNBOUND_INSTRUCTION;
      const team = teamKey === undefined ? null : resolveTeam(current, teamKey, "read");
      const teamIds = team === null ? current.readTeamIds : [team.id];
      const viewerIds = deps.store.viewers(teamIds).map((viewer) => viewer.id);

      const issues = assignee === "me" && viewerIds.length === 0 ? [] : deps.store.queryIssues({
        teamIds,
        ...(stateType === undefined ? {} : { stateTypes: [stateType] }),
        ...(assignee === "me" ? { assigneeIds: viewerIds } : {}),
        includeCompleted: stateType === "completed" || stateType === "canceled",
        sort: "updated",
        limit: limit ?? 30,
      });

      const filtered =
        assignee === "unassigned" ? issues.filter((issue) => issue.assigneeId === null) : issues;
      return listSummary(
        filtered,
        context(teamIds, filtered),
        team === null ? "the bound teams" : team.name,
      );
    },
  });

  bb.agents.registerTool({
    name: "linear_project_list",
    description:
      "List the Linear projects the bound teams work on, with their status, lead, dates and how far along they are.",
    parameters: z.object({}),
    execute: (_params, ctx) => {
      const current = scope(ctx.projectId);
      if (current.readTeamIds.length === 0) return UNBOUND_INSTRUCTION;
      const projects = deps.store.projects(current.readTeamIds);
      if (projects.length === 0) return "The bound teams have no projects.";

      const statuses = new Map(deps.store.projectStatuses(current.readTeamIds).map((entry) => [entry.id, entry.name]));
      const members = new Map(
        deps.store
          .membersByIds(
            projects
              .map((project) => project.leadId)
              .filter((id): id is string => id !== null),
          )
          .map((entry) => [entry.id, entry]),
      );
      return projects
        .map((entry) => {
          const parts = [
            entry.statusId === null ? null : (statuses.get(entry.statusId) ?? null),
            entry.leadId === null ? null : (members.get(entry.leadId)?.displayName ?? null),
            // A TimelessDate stays a string: it is a calendar fact, and
            // converting it picks a timezone on somebody's behalf.
            entry.targetDate === null ? null : `target ${entry.targetDate}`,
            entry.progress === null ? null : `${String(Math.round(entry.progress * 100))}%`,
          ].filter((part): part is string => part !== null && part !== "");
          return `${entry.name}${parts.length === 0 ? "" : ` — ${parts.join(", ")}`}`;
        })
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "linear_cycle_get",
    description:
      "The bound team's current cycle: when it ends, and what is in it. Answers that the team does not use cycles when it does not.",
    parameters: z.object({ teamKey: z.string().optional() }),
    execute: ({ teamKey }, ctx) => {
      const current = scope(ctx.projectId);
      const team = resolveTeam(current, teamKey, "read");
      if (!team.cyclesEnabled) {
        return `${team.name} does not use cycles.`;
      }

      const cycle = deps.store.cycles(team.id).find((entry) => entry.isActive);
      if (cycle === undefined) return `${team.name} has no cycle running right now.`;

      const issues = deps.store
        .queryIssues({ teamIds: [team.id], includeCompleted: true, sort: "priority", limit: 100 })
        .filter((issue) => issue.cycleId === cycle.id);

      const name = cycle.name ?? `Cycle ${String(cycle.number)}`;
      const ends =
        cycle.endsAt === null ? "" : ` — ends ${new Date(cycle.endsAt).toISOString().slice(0, 10)}`;
      return `${name}${ends}\n\n${listSummary(issues, context([team.id], issues), name)}`;
    },
  });

  bb.agents.registerTool({
    name: "linear_view_run",
    description:
      "Run one of the workspace's saved Linear views and list what it returns. Linear runs the filter itself, so the answer matches what the view shows in Linear.",
    instructions:
      "A saved view's filter is opaque to bb — it is stored in Linear's internal dialect. Never try to reproduce one with linear_issue_list; run the view.",
    parameters: z.object({
      viewId: z.string().min(1).describe("The saved view's id."),
    }),
    execute: async ({ viewId }, ctx) => {
      const current = scope(ctx.projectId);
      if (current.readTeamIds.length === 0) return UNBOUND_INSTRUCTION;
      const result = await deps.runView(viewId, current.readTeamIds, ctx.signal);
      if (result === null) return `No saved view with id ${viewId}, or it could not be read.`;

      // Filtered *after* Linear runs it: a saved view is workspace-wide and can
      // reach teams this project is not bound to. Dropping those here is the
      // same scoping promise every other read makes.
      const inScope = result.issues.filter((issue) => current.readTeamIds.includes(issue.teamId));
      const dropped = result.issues.length - inScope.length;
      const summary = listSummary(
        inScope,
        context(current.readTeamIds, inScope),
        result.name,
      );
      return dropped === 0
        ? summary
        : `${summary}\n\n${String(dropped)} more ${
            dropped === 1 ? "issue is" : "issues are"
          } in that view but belong to teams this project is not bound to.`;
    },
  });

  /* ── Write ─────────────────────────────────────────────────────────────── */

  bb.agents.registerTool({
    name: "linear_comment",
    description: "Post a comment on a Linear issue.",
    parameters: z.object({
      issue: z.string().min(1).describe("An identifier such as ENG-42, or an issue id."),
      body: z.string().min(1).describe("Markdown."),
    }),
    experimental_statusLabels: {
      pending: "Commenting on a Linear issue",
      completed: "Commented on a Linear issue",
    },
    execute: async ({ issue, body }, ctx) => {
      const current = scope(ctx.projectId);
      const row = await resolveIssue(current, issue, "write", ctx.signal);
      try {
        await postComment(deps.mutations, {
          issueId: row.id,
          body,
          clientId: clientId(),
        });
        return `Commented on ${row.identifier}.`;
      } catch (error) {
        return { content: [{ type: "text", text: describeError(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "linear_issue_update",
    description:
      "Change a Linear issue's state, assignee, priority, estimate or labels. Call linear_team_context first to get the ids — a state's name is not its id, and matching on a name is matching on English.",
    parameters: z.object({
      issue: z.string().min(1),
      stateId: z.string().optional().describe("From linear_team_context."),
      assigneeId: z.string().nullable().optional().describe("null unassigns."),
      priority: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe("0 is No priority, 1 Urgent, 4 Low."),
      estimate: z.number().nullable().optional(),
      dueDate: z
        .string()
        .nullable()
        .optional()
        .describe("A calendar date as YYYY-MM-DD. null clears it."),
      projectId: z.string().nullable().optional(),
      cycleId: z.string().nullable().optional(),
      title: z.string().min(1).optional(),
      description: z.string().optional().describe("Markdown. Replaces the whole description."),
      addLabelIds: z.array(z.string()).optional(),
      removeLabelIds: z.array(z.string()).optional(),
    }),
    experimental_statusLabels: {
      pending: "Updating a Linear issue",
      completed: "Updated a Linear issue",
    },
    execute: async (params, ctx) => {
      const current = scope(ctx.projectId);
      const row = await resolveIssue(current, params.issue, "write", ctx.signal);
      const changed: string[] = [];
      if (params.stateId !== undefined) changed.push("state");
      if (params.assigneeId !== undefined) changed.push("assignee");
      if (params.priority !== undefined) changed.push("priority");
      if (params.estimate !== undefined) changed.push("estimate");
      if (params.dueDate !== undefined) changed.push("due date");
      if (params.projectId !== undefined) changed.push("project");
      if (params.cycleId !== undefined) changed.push("cycle");
      if (params.title !== undefined) changed.push("title");
      if (params.description !== undefined) changed.push("description");
      if (params.addLabelIds !== undefined || params.removeLabelIds !== undefined) {
        changed.push("labels");
      }

      try {
        await updateIssue(
          deps.mutations,
          row.id,
          {
            ...(params.stateId === undefined ? {} : { stateId: params.stateId }),
            ...(params.assigneeId === undefined ? {} : { assigneeId: params.assigneeId }),
            ...(params.priority === undefined ? {} : { priority: params.priority }),
            ...(params.estimate === undefined ? {} : { estimate: params.estimate }),
            ...(params.dueDate === undefined ? {} : { dueDate: params.dueDate }),
            ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
            ...(params.cycleId === undefined ? {} : { cycleId: params.cycleId }),
            ...(params.title === undefined ? {} : { title: params.title }),
            ...(params.description === undefined ? {} : { description: params.description }),
            ...(params.addLabelIds === undefined ? {} : { addLabelIds: params.addLabelIds }),
            ...(params.removeLabelIds === undefined
              ? {}
              : { removeLabelIds: params.removeLabelIds }),
          },
          `Couldn't update ${row.identifier}`,
        );
        const updated = deps.store.issue(row.id) ?? row;
        return changeSummary(updated, context([row.teamId], [updated]), changed);
      } catch (error) {
        return { content: [{ type: "text", text: describeError(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "linear_issue_create",
    description:
      "Create a Linear issue in the bound team. Call linear_team_context first if you want to set a state, assignee or labels — a state's name is not its id.",
    instructions:
      "Create an issue when the human asked for one, or when you found something that genuinely needs tracking and said so. Filing issues nobody asked for fills somebody's tracker with your notes.",
    parameters: z.object({
      title: z.string().min(1),
      description: z.string().optional().describe("Markdown."),
      teamKey: z.string().optional().describe("Defaults to this project's primary team."),
      stateId: z.string().optional().describe("From linear_team_context."),
      assigneeId: z.string().optional(),
      priority: z.number().int().min(0).max(4).optional(),
      parent: z.string().optional().describe("An identifier such as ENG-42 to file this under."),
      labelIds: z.array(z.string()).optional(),
    }),
    experimental_statusLabels: {
      pending: "Creating a Linear issue",
      completed: "Created a Linear issue",
    },
    execute: async (params, ctx) => {
      const current = scope(ctx.projectId);
      const team = resolveTeam(current, params.teamKey, "write");
      const parent =
        params.parent === undefined
          ? null
          : await resolveIssue(current, params.parent, "write", ctx.signal);

      try {
        const issue = await createIssue(deps.mutations, (teamId) => deps.clientForTeam(teamId), {
          teamId: team.id,
          title: params.title,
          ...(params.description === undefined ? {} : { description: params.description }),
          ...(params.stateId === undefined ? {} : { stateId: params.stateId }),
          ...(params.assigneeId === undefined ? {} : { assigneeId: params.assigneeId }),
          ...(params.priority === undefined ? {} : { priority: params.priority }),
          ...(parent === null ? {} : { parentId: parent.id }),
          ...(params.labelIds === undefined ? {} : { labelIds: params.labelIds }),
          clientId: clientId(),
        });
        return `Created ${issue.identifier} — ${issue.title}${
          issue.url === null ? "" : `\n${issue.url}`
        }`;
      } catch (error) {
        return { content: [{ type: "text", text: describeError(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "linear_issue_relate",
    description:
      "Record that one Linear issue blocks, duplicates or relates to another. Direction matters: the first issue is the one doing the blocking.",
    parameters: z.object({
      issue: z.string().min(1).describe("An identifier such as ENG-42."),
      relatedIssue: z.string().min(1),
      type: z
        .enum(["blocks", "related", "duplicate", "similar"])
        .describe("blocks means the first issue blocks the second."),
    }),
    experimental_statusLabels: {
      pending: "Relating two Linear issues",
      completed: "Related two Linear issues",
    },
    execute: async ({ issue, relatedIssue, type }, ctx) => {
      const current = scope(ctx.projectId);
      const from = await resolveIssue(current, issue, "write", ctx.signal);
      const to = await resolveIssue(current, relatedIssue, "write", ctx.signal);
      try {
        await relateIssues(deps.mutations, {
          issueId: from.id,
          relatedIssueId: to.id,
          type,
        });
        return type === "blocks"
          ? `${from.identifier} now blocks ${to.identifier}.`
          : `${from.identifier} is now marked ${type} to ${to.identifier}.`;
      } catch (error) {
        return { content: [{ type: "text", text: describeError(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "linear_issue_attach",
    description:
      "Attach a link to a Linear issue — a pull request, a document, a dashboard. Linear turns a recognised URL into a rich attachment with live status.",
    parameters: z.object({
      issue: z.string().min(1),
      url: z.string().url(),
      title: z.string().optional(),
    }),
    experimental_statusLabels: {
      pending: "Attaching a link to a Linear issue",
      completed: "Attached a link to a Linear issue",
    },
    execute: async ({ issue, url, title }, ctx) => {
      const current = scope(ctx.projectId);
      const row = await resolveIssue(current, issue, "write", ctx.signal);
      try {
        const result = await attachUrl(deps.mutations, {
          issueId: row.id,
          url,
          title: title ?? null,
        });
        return result.alreadyThere
          ? `That link is already on ${row.identifier}.`
          : `Attached to ${row.identifier}.`;
      } catch (error) {
        return { content: [{ type: "text", text: describeError(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "linear_thread_start",
    description:
      "Start a bb thread from a Linear issue, in the project this thread belongs to. The new thread gets the issue's description, comments and acceptance criteria as context, and the issue moves to the team's started state.",
    parameters: z.object({
      issue: z.string().min(1).describe("An identifier such as ENG-42, or an issue id."),
    }),
    experimental_statusLabels: {
      pending: "Starting a thread from a Linear issue",
      completed: "Started a thread from a Linear issue",
    },
    execute: async ({ issue }, ctx) => {
      const current = scope(ctx.projectId);
      const row = await resolveIssue(current, issue, "read", ctx.signal);
      const result = await deps.startThread({ issueId: row.id, projectId: ctx.projectId });
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true };
      }
      return result.note === null ? result.message : `${result.message} ${result.note}`;
    },
  });

  /*
   * The two tools no Linear MCP can have: they read and write the link
   * between THIS bb thread and its issue, which exists only in bb.
   */
  bb.agents.registerTool({
    name: "linear_thread_issue",
    description:
      "Which Linear issue this bb thread is working on — the bound issue with its state and how the binding was made, or the plugin's best suggestion when nothing is bound yet.",
    instructions:
      "Prefer linear_thread_issue over searching when the question is about 'the issue for this work' — the binding is authoritative and search is a guess.",
    parameters: z.object({}),
    experimental_statusLabels: {
      pending: "Reading this thread's Linear issue",
      completed: "Read this thread's Linear issue",
    },
    execute: (_input, ctx) => {
      if (ctx.threadId === null || ctx.threadId === undefined) {
        return "This context has no thread, so there is no thread issue to read.";
      }
      return deps.threadIssue(ctx.threadId);
    },
  });

  bb.agents.registerTool({
    name: "linear_thread_bind",
    description:
      "Bind this bb thread to a Linear issue (or unbind it). The binding drives the thread's header chip, the side panel, and the context every future turn receives. It writes bb's own link only — never Linear.",
    parameters: z.object({
      issue: z
        .string()
        .min(1)
        .nullable()
        .describe("An identifier such as ENG-42, an issue id, or null to unbind."),
    }),
    experimental_statusLabels: {
      pending: "Binding this thread to a Linear issue",
      completed: "Bound this thread to a Linear issue",
    },
    execute: async ({ issue }, ctx) => {
      if (ctx.threadId === null || ctx.threadId === undefined) {
        return {
          content: [{ type: "text", text: "This context has no thread to bind." }],
          isError: true,
        };
      }
      const result = await deps.bindThread(ctx.threadId, issue, ctx.projectId);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.message ?? "The binding was refused." }],
          isError: true,
        };
      }
      return result.message ?? "Done.";
    },
  });

  /*
   * `configure` is **synchronous** and runs on the thread-start path, so it
   * reads a pre-warmed in-memory binding table and never touches the network
   * or SQLite. An unbound project gets no Linear tools at all — withholding
   * beats degrading, because an agent handed a tool it will then be refused
   * spends a turn discovering that.
   */
  bb.agents.configure((ctx) => {
    const current = scopeFor(ctx.project.id, deps.bindings());
    if (current.primaryTeamId === null) {
      return { tools: [], skills: [], instructions: UNBOUND_INSTRUCTION };
    }
    return {
      tools: toolsFor(deps.agentWrites()),
      skills: deps.skills(),
      instructions: UNTRUSTED_LINEAR_POLICY,
    };
  });
}
