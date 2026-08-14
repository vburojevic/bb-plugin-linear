/**
 * The declared settings, in one place so `server.ts` and the tests read the
 * same descriptors.
 *
 * Two rules govern this file and neither is negotiable.
 *
 * **A key is never renamed after release.** A secret setting's key *is* the
 * filename it is stored under (`<dataDir>/plugins/linear/secrets/<key>`), so
 * renaming `apiKey` orphans the file and silently un-configures the plugin on
 * upgrade — the user sees a working install become "needs configuration" with
 * no explanation and a key they cannot find. The migration, if one is ever
 * genuinely needed, is: add the new key, read-old-write-new for one release,
 * keep the old descriptor visible, remove it in a major.
 *
 * **The plugin never writes its own settings.** Not once, anywhere. When a
 * plugin's status is `needs-configuration`, the host's `updateSettings`
 * *awaits* a dispose-then-load cycle inline, and a dispose waits up to five
 * seconds for in-flight invocations to settle — and an rpc handler is an
 * in-flight invocation. A plugin that saves its own key from its own handler
 * therefore stalls for five seconds, has its database handles closed and its
 * `bb` handle invalidated while the handler is still running, and then throws
 * `PluginContextStaleError` from a detached continuation, which takes down the
 * whole bb server. There is no plugin-side workaround, and there does not need
 * to be one: the host already renders a `secret: true` descriptor as a
 * password field with a `[not set]` placeholder, and renders that form for
 * `needs-configuration` plugins precisely so this can work. A CI grep asserts
 * the absence of `updateSettings` in this repository.
 */

import type { PluginSettingDescriptors, PluginSettingsValues } from "@bb/plugin-sdk";

export const SETTING_DESCRIPTORS = {
  apiKey: {
    type: "string",
    label: "Linear API key",
    secret: true,
    description:
      "Create one in Linear under Settings → Account → Security & access → Personal API keys. Read access is enough to browse; write access is needed to change anything. Stored in bb's secret storage on this machine (a 0600 file), never shown again, and never given to an agent.",
  },

  /*
   * Slots two, three and four. Empty for almost everyone.
   *
   * A Linear personal API key is scoped to one workspace, so a second
   * workspace genuinely needs a second key — there is no permission that makes
   * one key reach two. Declared up front and never renamed, for the same
   * reason `apiKey` is: a secret setting's key is the filename it lives in.
   */
  apiKey2: {
    type: "string",
    label: "Linear API key — second workspace",
    secret: true,
    description:
      "Only if you work in more than one Linear workspace. Create the key in that workspace, the same way. Its teams appear in the team list alongside the first workspace's, tagged with which workspace they came from.",
  },
  apiKey3: {
    type: "string",
    label: "Linear API key — third workspace",
    secret: true,
    description: "As above. Leave empty unless you need it.",
  },
  apiKey4: {
    type: "string",
    label: "Linear API key — fourth workspace",
    secret: true,
    description: "As above. Leave empty unless you need it.",
  },

  oauthClientId: {
    type: "string",
    label: "OAuth client ID",
    default: "",
    description:
      "Only for an organisation that registered its own private Linear OAuth application. Leave empty to use a personal API key, which is what almost everyone should do.",
  },
  oauthClientSecret: {
    type: "string",
    label: "OAuth client secret",
    secret: true,
    description:
      "The secret for your own Linear OAuth application. Unused unless a client ID is set.",
  },

  webhookUrl: {
    type: "string",
    label: "Webhook URL",
    default: "",
    description:
      "A public HTTPS URL that reaches this bb from the internet. Leave it empty and the plugin polls, which always works. Creating a webhook also needs a Linear workspace admin, and a bb connect share link will not work — it is session-gated, so Linear's delivery bot gets the sign-in page.",
  },

  syncProfile: {
    type: "select",
    label: "Sync cadence",
    options: ["responsive", "balanced", "frugal"],
    default: "balanced",
    description:
      "How eagerly to poll Linear. Balanced polls a running thread's issue every 10 seconds and idles down to 10 minutes when nothing is happening. Responsive halves every interval, frugal doubles them.",
  },

  spawnBranchMode: {
    type: "select",
    label: "Branch naming",
    options: ["title", "exact"],
    default: "title",
    description:
      "Title puts the issue identifier at the front of the thread title and lets bb name the branch — Linear's autolink matches on the identifier, so the link survives. Exact checks out the branch name Linear generated, but only when that branch already exists and the working tree is clean; otherwise it falls back to title and says so.",
  },
  spawnMovesStatus: {
    type: "boolean",
    label: "Move the issue when a thread starts",
    default: true,
    description:
      "Move the issue into your team's own started state when you start a thread from it.",
  },

  /*
   * The master consent switch, and deliberately the only one that matters.
   *
   * Off means the plugin cannot change anything in Linear — not an issue, not
   * a comment, not a webhook registration — no matter what any other setting,
   * tool, command, automation or UI control says. The enforcement lives in
   * the transport (the one door every mutation leaves through), so a surface
   * added later is gated the day it is written. Reads are untouched.
   */
  allowWrites: {
    type: "boolean",
    label: "Allow changes to Linear",
    default: false,
    description:
      "Off by default: the plugin reads freely (issues, inbox, search all work) but refuses every change to Linear — issue edits, comments, new issues, attachments, webhook registration — until you turn this on. The refusal always names this switch. Agent write access (below) only applies once this is on.",
  },

  prTransitions: {
    type: "boolean",
    label: "Move the issue when its pull request moves",
    default: false,
    description:
      "Follow the git automation your team already configured in Linear, using the team's own target states. OFF by default: agents with a Linear connection often drive states themselves, and two writers fighting over one card is worse than either alone. Needs the GitHub CLI (gh) authenticated on the machine running bb; nothing else in this plugin does.",
  },
  threadMovesStatus: {
    type: "boolean",
    label: "Move the issue when a bound thread starts working",
    default: false,
    description:
      "When a thread bound to an issue becomes active, lift the issue from backlog/triage/unstarted into the team's started state — never backwards, and only when this project's binding can write to that team. OFF by default, for the same reason as pull-request moves.",
  },

  notifyAssigned: {
    type: "boolean",
    label: "Tell me when an issue is assigned to me",
    default: true,
  },
  notifyComments: {
    type: "boolean",
    label: "Tell me about comments, replies and mentions",
    default: true,
  },
  notifyBlocked: {
    type: "boolean",
    label: "Tell me when one of my issues is blocked",
    default: true,
  },

  includeSubTeams: {
    type: "boolean",
    label: "Include sub-teams",
    default: false,
    description:
      "When a bound team has sub-teams, also pull their issues. Off by default: a parent binding that silently drags in six children's issues is the kind of surprise this plugin's scoping rules exist to prevent.",
  },

  agentWrites: {
    type: "select",
    label: "What agents may change in Linear",
    options: ["off", "comment", "full"],
    default: "comment",
    description:
      "Read and comment. Choose Full to let agents create issues and change states, assignees and labels; choose Off to withhold every writing tool. Agents never get delete, archive or workspace administration at any setting.",
  },

  pushPluginId: {
    type: "string",
    label: "Push plugin",
    default: "",
    description:
      "bb has no plugin notification API, so notifications land in bb. If you run a push plugin that implements the contract in docs/push-contract.md, put its plugin id here and they reach your phone too. Nothing is auto-detected — calling a guessed method on somebody else's plugin is not detection.",
  },

  linkBackComment: {
    type: "boolean",
    label: "Comment on the issue when a thread starts",
    default: false,
    description:
      "Post a comment on the Linear issue saying a bb thread has started. Off, because writing into someone else's tracker uninvited is rude.",
  },
} as const satisfies PluginSettingDescriptors;

export type LinearSettings = PluginSettingsValues<typeof SETTING_DESCRIPTORS>;

export type SyncProfile = "responsive" | "balanced" | "frugal";
export type SpawnBranchMode = "title" | "exact";
export type AgentWrites = "off" | "comment" | "full";

/**
 * `select` descriptors type as plain `string`, so every read that needs the
 * narrower type goes through one of these rather than a cast. A value that is
 * somehow not a member — a hand-edited settings row, a descriptor changed in a
 * later release — falls back to the declared default instead of reaching a
 * `switch` that has no branch for it.
 */
export function readSyncProfile(value: string | undefined): SyncProfile {
  return value === "responsive" || value === "frugal" ? value : "balanced";
}

export function readSpawnBranchMode(value: string | undefined): SpawnBranchMode {
  return value === "exact" ? "exact" : "title";
}

export function readAgentWrites(value: string | undefined): AgentWrites {
  return value === "off" || value === "full" ? value : "comment";
}

/**
 * The message a user reads in `bb plugin list` and in the plugin's status
 * detail when no key is set. It names both routes because the two audiences
 * are different: someone in the app wants the field, someone in a terminal
 * wants the command.
 *
 * It deliberately does not recite a navigation breadcrumb. bb shows plugin
 * management under Extensions only when that collection is enabled and
 * otherwise under Settings → Plugins, so any breadcrumb this plugin printed
 * would be wrong for some installs — which is exactly what the sidebar footer
 * button is for.
 */
export const NEEDS_CONFIGURATION_MESSAGE =
  "Add your Linear API key in this plugin's settings, or run: bb plugin config linear set apiKey <key>";
