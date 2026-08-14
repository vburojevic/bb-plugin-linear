import type { BbPluginApi, PluginMentionItem } from "@bb/plugin-sdk";
import { scopeFor } from "./bindings.js";
import { truncate } from "./format.js";
import type { BindingRow } from "./store/rows.js";
import type { Store } from "./store/store.js";
import { issueDetailText, type IssueContext } from "./tools-format.js";

/**
 * `#` mention providers, served **entirely from the local FTS mirror**.
 *
 * `search` is time-boxed to two seconds and failure-isolated — a slow provider
 * silently contributes an empty list — so it must never be the plugin's first
 * network call. Nothing here reaches Linear at all.
 *
 * **`projectId: null` returns zero rows**, exactly like an unbound project.
 * `null` is the *normal* state on the new-thread compose surface, and falling
 * through to "all bound teams" there would leak another team's issue titles to
 * someone who has not yet chosen a project — precisely the leak the scoping
 * model exists to prevent. It is tempting to treat it as a convenience, which
 * is why there is a test for it next to the unbound case.
 */

export interface MentionDeps {
  readonly store: Store;
  readonly bindings: () => readonly BindingRow[];
}

const SEARCH_LIMIT = 12;

export function registerMentionProviders(bb: BbPluginApi, deps: MentionDeps): void {
  bb.ui.registerMentionProvider({
    id: "issue",
    label: "Linear issues",
    triggers: ["#"],

    search({ query, projectId }): PluginMentionItem[] {
      if (projectId === null) return [];
      const scope = scopeFor(projectId, deps.bindings());
      if (scope.readTeamIds.length === 0) return [];

      const issues = deps.store.queryIssues({
        teamIds: scope.readTeamIds,
        // An empty query lists what was touched most recently, which is what
        // somebody typing `#` and pausing is almost always reaching for.
        ...(query.trim() === "" ? {} : { text: query }),
        sort: "updated",
        limit: SEARCH_LIMIT,
      });

      const states = new Map(
        scope.readTeamIds
          .flatMap((teamId) => deps.store.workflowStates(teamId))
          .map((state) => [state.id, state]),
      );

      return issues.map((issue) => {
        const state = issue.stateId === null ? undefined : states.get(issue.stateId);
        return {
          id: issue.id,
          title: `${issue.identifier} · ${truncate(issue.title, 70)}`,
          ...(state === undefined ? {} : { subtitle: state.name }),
        };
      });
    },

    /**
     * Resolve runs once per unique item **at send time** and receives only the
     * item id — no project, no thread. **It must never throw for an ordinary
     * miss**, because a throw blocks the send with a visible error and the
     * user loses the message they were writing.
     *
     * Scoping still holds without a project id: the mirror only ever contains
     * bound teams' issues, so an id that resolves here was already in scope
     * when it was offered.
     */
    resolve(itemId) {
      const issue = deps.store.issue(itemId) ?? deps.store.issueByIdentifier(itemId);
      if (issue === null) {
        return {
          context: `(A Linear issue was mentioned, but it is no longer in bb's local copy of the workspace.)`,
        };
      }

      const context: IssueContext = {
        states: new Map(
          deps.store
            .teams()
            .flatMap((team) => deps.store.workflowStates(team.id))
            .map((state) => [state.id, state]),
        ),
        members: new Map(deps.store.members().map((member) => [member.id, member])),
        labels: new Map(deps.store.labels([]).map((label) => [label.id, label])),
        priorityLabels: new Map(
          deps.store.priorityValues().map((value) => [value.priority, value.label]),
        ),
        teams: new Map(deps.store.teams().map((team) => [team.id, team])),
      };

      return {
        context: issueDetailText(issue, context, {
          // The last few comments, not all of them: this text is attached to
          // every send that mentions the issue, and an issue with two hundred
          // replies would otherwise cost the model its whole context window
          // for one mention.
          comments: deps.store.comments(issue.id).slice(-5),
        }),
      };
    },
  });
}
