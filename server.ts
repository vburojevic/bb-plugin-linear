import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import {
  type BbFact,
  type ConnectionState,
  type DetailResult,
  type PanelNotice,
  type ThreadIssueView,
  type ThreadPanelView,
  type WriteRefusal,
} from "./src/contract.js";
import { buildBindingsView, expandTeams, type ProjectSummary } from "./src/bindings.js";
import { CLI_COMMANDS, createCliRunner, type CliEnvironment } from "./src/cli.js";
import { createVersionedStore, KV } from "./src/kv.js";
import { patFromSetting } from "./src/linear/credential.js";
import {
  configuredSlots,
  duplicateSlots,
  isCredentialSlot,
  slotLabel,
  PRIMARY_SLOT,
  type CredentialSlot,
  type SlotCredential,
} from "./src/credentials.js";
import { describeError, forgetSecrets, isLinearError, redact } from "./src/linear/errors.js";
import {
  createLinearClient,
  unwrapMutation,
  type LinearClient,
  type LinearClientFactory,
} from "./src/linear/client.js";
import {
  archiveIssue,
  attachUrl,
  clientId,
  createIssue,
  postComment,
  updateIssue,
  type MutationDeps,
} from "./src/mutations.js";
import {
  buildFacets,
  buildPanelView,
  buildRowViews,
  buildWorkingSet,
  type PanelDeps,
} from "./src/panel.js";
import type { IssueRow } from "./src/store/rows.js";
import { estimateLabel, estimateScale, selectDetail } from "./src/select/detail.js";
import { initialsOf } from "./src/select/panel.js";
import { toneForStateType } from "./src/select/tone.js";
import { issueDetailText } from "./src/tools-format.js";
import { registerMentionProviders } from "./src/mentions.js";
import { registerTools } from "./src/tools.js";
import { runPrTransition, type PrRunnerDeps } from "./src/automations/pr-runner.js";
import { startThreadFromIssue, type StartDeps } from "./src/automations/start.js";
import { applyIssueDetail, toIssueInput } from "./src/sync/apply.js";
import type { IssueNode } from "./src/linear/types.js";
import { resolveBinding, type LadderDeps } from "./src/binding.js";
import { crossTeamRefusal, scopeFor } from "./src/bindings.js";
import {
  classifyVerificationFailure,
  connectedState,
  describeConnection,
} from "./src/select/connection.js";
import type { DoctorCheck, StatusReport } from "./src/select/status.js";
import { createLifetime } from "./src/safe.js";
import {
  NEEDS_CONFIGURATION_MESSAGE,
  readAgentWrites,
  readSpawnBranchMode,
  readSyncProfile,
  SETTING_DESCRIPTORS,
} from "./src/settings.js";
import { serverRpcContract } from "./src/rpc.js";
import { createStore, type Store } from "./src/store/store.js";
import { MIGRATIONS } from "./src/store/migrations.js";
import {
  backfillTeams,
  discoverWorkspace,
  refreshTeamVocabulary,
} from "./src/sync/backfill.js";
import { cadenceFor, runTick } from "./src/sync/service.js";
import { inboxInterval } from "./src/sync/tiers.js";
import { classify, deliveryKey, shouldSend } from "./src/notify/classify.js";
import { RESOURCE_TYPES, verifyWebhook, webhookDeliveryKey } from "./src/webhook.js";
import {
  checkWebhookUrl,
  describeDemotion,
  newNonce,
  newSigningSecret,
  planRegistration,
  runSelfTest,
  webhookHealth,
} from "./src/webhook-register.js";
import { selectInboxItem, toInboxRow } from "./src/notify/inbox.js";
import { claimAndSend, deliverToPeer } from "./src/notify/deliver.js";
import { budgetPressure, type BudgetSnapshot } from "./src/linear/budget.js";
import { sleep } from "./src/safe.js";
import { watermarkSchema } from "./src/sync/watermark.js";
import { joinSentence, pluralize } from "./src/format.js";
import { table } from "./src/cli-format.js";

/**
 * Wiring only.
 *
 * Everything with a decision in it lives under `src/`, behind an injected
 * dependency, because CI has no Linear workspace, no bb server and no
 * `@bb/plugin-sdk` — so the architecture *is* the test plan. `createPlugin`
 * takes the client factory; a test passes one that answers from a fixture and
 * nothing below it opens a socket.
 *
 * The factory must also succeed **offline**. It defines settings, runs
 * migrations, registers surfaces and reads stored values, and it makes no
 * Linear call at all — a flaky connection during an upgrade would otherwise
 * turn into a failed activation, and bb rolls a failed activation back to the
 * previous plugin version, which then runs old code against the new schema.
 */

export { serverRpcContract as rpcContract } from "./src/rpc.js";
export type { LinearRpcContract } from "./src/contract.js";

/** Kept for one minute. The Connection section renders on every visit to the
 *  plugin's settings page, and a workspace lookup per visit is a request spent
 *  on something nobody asked for. **Check again** sends `recheck`. */
const CONNECTION_CACHE_MS = 60_000;

const verifiedRecordSchema = z.object({
  v: z.literal(1),
  at: z.number(),
  workspaceId: z.string(),
});

const writeRefusalRecordSchema = z.object({
  v: z.literal(1),
  at: z.number(),
  what: z.string(),
});

const installWatermarkSchema = z.object({ v: z.literal(1), at: z.number() });
const webhookRecordSchema = z.object({ v: z.literal(1), id: z.string(), url: z.string() });

/** Server-local by nature, so the multi-machine rule does not apply. */
const WEBHOOK_SECRET_KEY = "webhook-signing-secret";
const sortPreferenceSchema = z.object({ v: z.literal(1), sort: z.string() });
const backfilledSchema = z.object({ v: z.literal(1), at: z.number(), issues: z.number() });

export function createPlugin(makeClient: LinearClientFactory = createLinearClient) {
  return async function linearPlugin(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);
    const kv = createVersionedStore(bb.storage.kv);

    const lifetime = createLifetime({
      log: (level, message) => {
        bb.log[level](redact(message));
      },
    });

    const database = bb.storage.database();
    bb.storage.migrate(database, MIGRATIONS);
    const store: Store = createStore(database);

    const now = () => Date.now();

    /* ── Credentials ─────────────────────────────────────────────────────── */
    /*
     * Read fresh inside every handler and `.trim()`ed at every read: the
     * host's `readSecret` is a raw `readFile` with no trim, so a key pasted
     * with a trailing newline persists with one and every request 401s in a
     * way that reads exactly like a revoked key. Never captured into module
     * scope — a key replaced while bb is running must take effect on the next
     * request, not the next reload.
     *
     * **Plural, because a Linear personal API key is scoped to one
     * workspace.** Someone in two workspaces needs two keys; there is no
     * permission that makes one key reach both. Each slot gets its own client,
     * and therefore its own rate-limit budget and its own circuit breaker,
     * because Linear tracks both per key — sharing either across workspaces
     * would let a throttled key stall a healthy one.
     */
    async function credentialFor(slot: CredentialSlot) {
      const values = await settings.get();
      return patFromSetting(values[slot]);
    }

    /**
     * The configured slots, last time anyone asked.
     *
     * Settings are async and a few callers are not — `PrRunnerDeps` is built
     * once at load and its branch lookup runs on a thread event. This is
     * refreshed by every `activeSlots()` call, which happens on each discovery
     * pass and each notification cycle, so it is never stale for long and is
     * never wrong in a way that loses data: a missing slot means one branch
     * lookup does not consult one workspace until the next tick.
     */
    let liveSlots: CredentialSlot[] = [PRIMARY_SLOT];

    async function activeSlots(): Promise<SlotCredential[]> {
      const found = configuredSlots(await settings.get());
      liveSlots = found.length === 0 ? [PRIMARY_SLOT] : found.map((entry) => entry.slot);
      return found;
    }

    const clients = new Map<CredentialSlot, LinearClient>();

    function clientForSlot(slot: CredentialSlot): LinearClient {
      const existing = clients.get(slot);
      if (existing !== undefined) return existing;
      const made = makeClient({
        getCredential: () => credentialFor(slot),
        log: (level, message) => lifetime.log(level, message),
        signal: lifetime.signal,
        now,
      });
      clients.set(slot, made);
      return made;
    }

    /**
     * The client that can actually see a given team.
     *
     * Falls back to the primary slot for a team recorded before workspaces
     * were plural, which is where it came from. A wrong answer here is a 404
     * from Linear rather than a leak: a key cannot read another workspace's
     * team no matter who asks it to.
     */
    function clientForTeam(teamId: string): LinearClient {
      const workspace = store.workspaceForTeam(teamId);
      return clientForSlot(
        workspace !== null && isCredentialSlot(workspace.slot) ? workspace.slot : PRIMARY_SLOT,
      );
    }

    /** For everything not scoped to a team: the primary key, which is the one
     *  virtually every install has and the only one most have. */
    const client: LinearClient = clientForSlot(PRIMARY_SLOT);

    /* ── Realtime ────────────────────────────────────────────────────────── */
    /*
     * A bare `{ at }` signal and nothing else; the frontend refetches over
     * rpc. Payloads never travel over realtime, and the floor is not optional:
     * every mounted banner, header chip and panel refetches on publish, and
     * several of those refetches come straight back through the plugin. A
     * bulk label edit is exactly the shape that fans out into a full round of
     * UI reloads per event.
     */
    const publishers = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();
    const PUBLISH_FLOOR_MS = 1_000;

    function publish(channel: "linear:data" | "linear:inbox"): void {
      if (lifetime.disposed) return;
      const state = publishers.get(channel) ?? { last: 0, timer: null };
      publishers.set(channel, state);
      const since = now() - state.last;
      if (since >= PUBLISH_FLOOR_MS) {
        state.last = now();
        lifetime.run("publish", () => {
          if (channel === "linear:data") rebuildAllInstructions();
          bb.realtime.publish(channel, { at: state.last });
        });
        return;
      }
      // Trailing rather than dropping: the last event in a burst is the one
      // whose data the UI most needs, so it must not be the one thrown away.
      if (state.timer !== null) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        state.last = now();
        lifetime.run("publish", () => {
          if (channel === "linear:data") rebuildAllInstructions();
          bb.realtime.publish(channel, { at: state.last });
        });
      }, PUBLISH_FLOOR_MS - since);
    }

    /* ── Connection ──────────────────────────────────────────────────────── */

    /** One cache entry per slot, keyed on the key's fingerprint so a replaced
     *  key is never answered from the previous key's result. */
    const cachedStates = new Map<
      CredentialSlot,
      { fingerprint: string; state: ConnectionState; at: number }
    >();

    /** Kept as a single name because everything downstream of a *failed*
     *  verification wants to invalidate everything, not one slot. */
    let cached: { at: number } | null = null;

    async function readWriteRefusal(): Promise<WriteRefusal | null> {
      const record = await kv.readOptional(KV.writeRefusal, writeRefusalRecordSchema);
      return record === undefined ? null : { at: record.at, what: record.what };
    }

    async function verifySlot(
      entry: SlotCredential,
      recheck: boolean,
    ): Promise<ConnectionState> {
      const previous = cachedStates.get(entry.slot);
      if (
        !recheck &&
        cached !== null &&
        previous !== undefined &&
        previous.fingerprint === entry.fingerprint &&
        now() - previous.at < CONNECTION_CACHE_MS
      ) {
        return previous.state;
      }

      const verifiedKey = KV.verified(entry.fingerprint);
      const slotClient = clientForSlot(entry.slot);
      try {
        const result = await slotClient.verify({ initiator: "user" });
        await kv.write(verifiedKey, {
          v: 1,
          at: now(),
          workspaceId: result.viewer.organization.id,
        });
        // The install watermark is set on the *first* successful connect and
        // never again. Notifications older than it are suppressed, which is
        // what stops a stranger's first run delivering three hundred pings
        // about last quarter.
        const existing = await kv.readOptional(KV.installWatermark, installWatermarkSchema);
        if (existing === undefined) {
          await kv.write(KV.installWatermark, { v: 1, at: now() });
        }

        const state = connectedState({
          result,
          budget: slotClient.budget(),
          writeRefusal: await readWriteRefusal(),
          checkedAt: now(),
        });
        cachedStates.set(entry.slot, { fingerprint: entry.fingerprint, state, at: now() });
        cached = { at: now() };
        return state;
      } catch (error) {
        const seen = await kv.readOptional(verifiedKey, verifiedRecordSchema);
        const state = classifyVerificationFailure({
          error,
          hasVerifiedBefore: seen !== undefined,
        });
        cachedStates.set(entry.slot, { fingerprint: entry.fingerprint, state, at: now() });
        cached = { at: now() };
        return state;
      }
    }

    /**
     * Every configured slot, verified.
     *
     * Sequential rather than parallel: the transport is single-flight per
     * client, but the *user* is waiting, and four keys verified at once is four
     * simultaneous round trips for a settings page that renders one line each.
     */
    async function slotStates(
      recheck: boolean,
    ): Promise<{ slot: CredentialSlot; label: string; state: ConnectionState }[]> {
      const slots = await activeSlots();
      const states: { slot: CredentialSlot; label: string; state: ConnectionState }[] = [];
      for (const entry of slots) {
        states.push({
          slot: entry.slot,
          label: slotLabel(entry.slot),
          state: await verifySlot(entry, recheck),
        });
      }
      return states;
    }

    /**
     * The plugin's single answer to "are we connected".
     *
     * **Connected if any slot is.** A second workspace whose key was revoked
     * must not make the first workspace's issues disappear, and a plugin that
     * reported the worst slot would do exactly that.
     */
    async function connectionState(recheck: boolean): Promise<ConnectionState> {
      const states = await slotStates(recheck);
      if (states.length === 0) {
        cachedStates.clear();
        cached = null;
        return { kind: "no-credential" };
      }

      const connected = states.find((entry) => entry.state.kind === "connected");
      if (connected !== undefined) return connected.state;

      // Nothing connected. A rejected key is a configuration problem, and
      // saying so in the plugin's own status is what makes the host re-run the
      // load when the user saves a replacement — no manual reload, no restart.
      const rejected = states.find(
        (entry) => entry.state.kind === "revoked" || entry.state.kind === "invalid-key",
      );
      if (rejected !== undefined) {
        lifetime.run("status", () =>
          bb.status.needsConfiguration(
            states.length === 1
              ? "Linear rejected the API key — it may have been revoked. Save a new one in the Linear API key field."
              : `Linear rejected the ${slotLabel(rejected.slot)} — it may have been revoked. Save a new one, or clear the field.`,
          ),
        );
      }
      return states[0]!.state;
    }

    /* ── Discovery and backfill ──────────────────────────────────────────── */

    /** The shared half of every `BackfillDeps`. The slot and its client are
     *  the half that varies. */
    function backfillDepsFor(slot: CredentialSlot) {
      return {
        client: clientForSlot(slot),
        slot,
        store,
        now,
        log: (level: "debug" | "info" | "warn", message: string) => lifetime.log(level, message),
        signal: lifetime.signal,
      };
    }

    /**
     * Group team ids by the key that can see them.
     *
     * The single most important function in the multi-workspace change: send a
     * team's id over the wrong key and Linear answers with nothing, which reads
     * exactly like an empty team. A team recorded before workspaces were plural
     * has no workspace and falls to the primary slot, which is where it came
     * from.
     */
    function teamsBySlot(teamIds: readonly string[]): Map<CredentialSlot, string[]> {
      const grouped = new Map<CredentialSlot, string[]>();
      for (const teamId of teamIds) {
        const workspace = store.workspaceForTeam(teamId);
        const slot =
          workspace !== null && isCredentialSlot(workspace.slot) ? workspace.slot : PRIMARY_SLOT;
        const list = grouped.get(slot) ?? [];
        list.push(teamId);
        grouped.set(slot, list);
      }
      return grouped;
    }

    let discovering: Promise<void> | null = null;

    /** Single-flight. Two surfaces mounting at once must not both walk the
     *  team list, and a backfill triggered while one is running must join it
     *  rather than start a second. */
    function discoverOnce(): Promise<void> {
      discovering ??= (async () => {
        try {
          // One walk per configured key, because each reaches a different
          // workspace. Sequentially, so four keys do not become four
          // concurrent multi-page walks against four separate budgets the
          // moment someone opens the settings page.
          for (const entry of await activeSlots()) {
            if (lifetime.signal.aborted) break;
            try {
              await discoverWorkspace(backfillDepsFor(entry.slot));
            } catch (error) {
              // One workspace failing must not hide the others. A revoked
              // second key is a line in the settings section, not an outage.
              lifetime.log(
                "warn",
                `Could not read the ${slotLabel(entry.slot)}'s workspace: ${describeError(error)}`,
              );
            }
          }
          await forgetRemovedWorkspaces();
          publish("linear:data");
        } finally {
          discovering = null;
        }
      })();
      return discovering;
    }

    /**
     * Drop the workspaces whose key is no longer in settings.
     *
     * Clearing a key is the only way to say "I am done with this workspace",
     * and leaving its teams in the picker afterwards would offer bindings that
     * can never sync. Issues are left to the ordinary reconcile: a key pasted
     * back a minute later should not cost a full re-read.
     */
    async function forgetRemovedWorkspaces(): Promise<void> {
      const live = new Set((await activeSlots()).map((entry) => entry.slot));
      for (const workspace of store.workspaces()) {
        if (live.has(workspace.slot as CredentialSlot)) continue;
        lifetime.log("info", `Forgetting ${workspace.name}: its API key is no longer set.`);
        store.forgetWorkspace(workspace.id);
      }
    }

    let backfilling: Promise<void> | null = null;

    async function backfillBoundTeams(force: boolean): Promise<{ issues: number }> {
      const values = await settings.get();
      const bound = store.boundTeamIds();
      const teamIds = expandTeams(bound, store.teams(), values.includeSubTeams);
      if (teamIds.length === 0) return { issues: 0 };

      const pending: string[] = [];
      for (const teamId of teamIds) {
        const done = await kv.readOptional(KV.backfilled(teamId), backfilledSchema);
        if (force || done === undefined) pending.push(teamId);
      }
      if (pending.length === 0) return { issues: 0 };

      // One backfill per workspace. Teams from different workspaces cannot
      // share a request: `teamIds` goes into a filter that only one key can
      // resolve.
      let issues = 0;
      for (const [slot, group] of teamsBySlot(pending)) {
        const report = await backfillTeams(backfillDepsFor(slot), group);
        issues += report.issues;
        for (const teamId of group) {
          await kv.write(KV.backfilled(teamId), { v: 1, at: now(), issues: report.issues });
        }
      }
      publish("linear:data");
      return { issues };
    }

    /** Serialised the same way, and for the same reason. */
    function backfillOnce(force: boolean): Promise<{ issues: number }> {
      if (backfilling !== null && !force) {
        return backfilling.then(() => ({ issues: 0 }));
      }
      const run = backfillBoundTeams(force);
      backfilling = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

    async function backfilledTeamIds(): Promise<Set<string>> {
      const done = new Set<string>();
      for (const teamId of store.boundTeamIds()) {
        const record = await kv.readOptional(KV.backfilled(teamId), backfilledSchema);
        if (record !== undefined) done.add(teamId);
      }
      return done;
    }

    /* ── What bb knows that Linear cannot ────────────────────────────────── */
    /*
     * Which threads are running right now, kept in memory from the six thread
     * lifecycle events. This is the half of the picture linear.app cannot
     * draw, and it is what the panel's lead column carries when the list is
     * grouped by state.
     *
     * In memory rather than in a table because it is per-load truth: a thread
     * that was running when bb stopped is not running now, and a stale "active"
     * row would be a lie the panel could not detect.
     */
    const activeThreads = new Set<string>();

    bb.events.on("thread.active", ({ thread }) => {
      activeThreads.add(thread.id);
      if (store.threadLink(thread.id) !== null) publish("linear:data");
      lifetime.detach("binding", async () => {
        await evaluateThreadBinding(thread.id, []);
        // After the ladder, so a binding this very event created (a fresh
        // branch checkout, say) triggers the move in the same beat.
        await moveStartedForThread(thread.id);
        await runTransitionForThread(thread.id);
      });
    });
    bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
      activeThreads.delete(thread.id);
      if (store.threadLink(thread.id) !== null) publish("linear:data");
      // The idle event carries the last assistant text for free — the one
      // message most likely to say which issue the work turned out to be.
      lifetime.detach("binding", async () => {
        await evaluateThreadBinding(thread.id, lastAssistantText === null ? [] : [lastAssistantText]);
        await runTransitionForThread(thread.id);
      });
    });
    for (const event of ["thread.failed", "thread.archived", "thread.deleted"] as const) {
      bb.events.on(event, ({ thread }) => {
        activeThreads.delete(thread.id);
        if (store.threadLink(thread.id) !== null) publish("linear:data");
        if (event !== "thread.failed") {
          suggestions.delete(thread.id);
          instructionCache.delete(thread.id);
        }
      });
    }

    function bbFactsFor(issueIds: readonly string[]): Map<string, BbFact> {
      const facts = new Map<string, BbFact>();
      // A pull request is the strongest fact bb has about an issue, so it is
      // written first and the thread facts below only fill gaps.
      for (const row of store.prStatesByIssue(issueIds)) {
        if (row.issueId === null) continue;
        facts.set(row.issueId, row.prNumber === null ? "branch" : "pull-request");
      }
      for (const link of store.threadLinksForIssues(issueIds)) {
        // A running thread wins over an idle one: the same issue can have
        // several threads, and the one that is working is the one worth
        // showing.
        // A running thread outranks even a pull request: it is the thing
        // happening *now*.
        if (activeThreads.has(link.threadId)) {
          facts.set(link.issueId, "thread-running");
          continue;
        }
        if (!facts.has(link.issueId)) facts.set(link.issueId, "thread-idle");
      }
      return facts;
    }

    /* ── Panel plumbing ──────────────────────────────────────────────────── */

    async function panelDeps(): Promise<PanelDeps> {
      const values = await settings.get();
      const hasCredential = values.apiKey !== undefined && values.apiKey.trim() !== "";
      return {
        store,
        now,
        hasCredential,
        boundTeamIds: expandTeams(store.boundTeamIds(), store.teams(), values.includeSubTeams),
        backfilledTeamIds: await backfilledTeamIds(),
        notice: panelNotice(),
        bbFacts: bbFactsFor(
          store
            .queryIssues({
              teamIds: expandTeams(store.boundTeamIds(), store.teams(), values.includeSubTeams),
              includeCompleted: true,
              sort: "updated",
              limit: 500,
            })
            .map((issue) => issue.id),
        ),
      };
    }

    /**
     * Failure-first: one clock per row, always naming what failed, when it
     * retries, and how old what you are looking at is. This never replaces the
     * list — a failed load must not blank a panel that already has rows.
     */
    function panelNotice(): PanelNotice | null {
      // The worst breaker across every key. One workspace being unreachable is
      // worth saying even when another is fine — the panel shows both, so a
      // notice that only watched the primary would leave half the rows quietly
      // stale.
      const breaker = worstBreaker();
      if (breaker.open) {
        return {
          tone: "warn",
          message: `Linear isn't answering — ${breaker.lastError ?? "repeated failures"}. Showing the local copy; reads resume in under a minute.`,
        };
      }
      const budget = tightestBudget();
      if (
        budget !== null &&
        budget.requests.limit !== null &&
        budget.requests.remaining !== null &&
        budget.requests.remaining / budget.requests.limit < 0.05
      ) {
        return {
          tone: "warn",
          message: "Linear's request budget is nearly used up, so the plugin has slowed its polling. What you see may be a few minutes old.",
        };
      }
      return null;
    }

    async function projectSummaries(): Promise<ProjectSummary[]> {
      // `includePersonal` defaults to false, and omitting it strands the solo
      // developer who never created a project: every thread of theirs is in
      // the personal project, so every one would be unbound.
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        kind: project.kind,
      }));
    }

    /* ── Status ──────────────────────────────────────────────────────────── */

    async function statusReport(): Promise<StatusReport> {
      const values = await settings.get();
      const teams = store.teams();
      const bindings = store.bindings();
      const projects = await lifetime.runAsync("projects", projectSummaries, []);
      const view = buildBindingsView({
        projects,
        bindings,
        teams,
        workspaceName: store.workspace()?.name ?? null,
        workspaces: store.workspaces(),
      });

      return {
        connection: await connectionState(false),
        now: now(),
        teamsVisible: teams.length === 0 ? null : teams.length,
        bindings:
          bindings.length === 0
            ? null
            : view.bound.map((project) => ({
                projectName: project.projectName,
                primaryTeamKey: project.primary?.key ?? null,
                extra: [
                  ...project.write.map((team) => ({ key: team.key, role: "write" as const })),
                  ...project.read.map((team) => ({ key: team.key, role: "read" as const })),
                ],
              })),
        unboundProjects: view.unbound.length,
        sync:
          bindings.length === 0
            ? null
            : {
                profile: readSyncProfile(values.syncProfile),
                intervalMs: currentIntervalMs,
                lastTickAt,
                issues: store.countIssues({
                  teamIds: store.boundTeamIds(),
                  includeCompleted: true,
                  includeArchived: true,
                }),
                projects: 0,
                lastError: lastSyncError,
              },
        webhook: values.webhookUrl.trim() === "" ? "not configured (polling)" : null,
        writeRefusal: await readWriteRefusal(),
      };
    }

    async function doctorChecks(): Promise<DoctorCheck[]> {
      const values = await settings.get();
      const checks: DoctorCheck[] = [];

      const slots = configuredSlots(values);
      const hasKey = slots.length > 0;
      checks.push({
        label: "API key",
        status: hasKey ? "ok" : "fail",
        detail: hasKey
          ? slots.length === 1
            ? "set"
            : `${String(slots.length)} keys set, one per workspace`
          : "not set",
        ...(hasKey
          ? {}
          : {
              fix: "Add it in this plugin's settings (the field is called Linear API key), or run: bb plugin config linear set apiKey <key>",
            }),
      });

      // The same key in two slots verifies twice, reports the same workspace
      // twice, and splits one rate-limit budget two ways for nothing —
      // Linear's 2,500 requests an hour is per key, not per slot.
      const duplicates = duplicateSlots(slots);
      if (duplicates.length > 0) {
        checks.push({
          label: "Duplicate keys",
          status: "warn",
          detail: duplicates
            .map((group) => group.map(slotLabel).join(" and "))
            .join("; ")
            .concat(" hold the same key"),
          fix: "Clear all but one. Two slots with the same key reach the same workspace and share one hourly request budget between them.",
        });
      }

      if (hasKey) {
        // **Not** a forced recheck. The bb CLI gives a plugin command two
        // seconds, and a forced verify spends a network round trip inside
        // that — which is how `bb linear doctor` timed out the first time it
        // met a live workspace. A verification from the last minute is a
        // perfectly good diagnosis, and `bb linear status` refreshes it.
        const state = await connectionState(false);
        checks.push({
          label: "Linear",
          status: state.kind === "connected" ? "ok" : "fail",
          detail: describeConnection(state),
          ...(state.kind === "connected" || state.kind === "no-credential"
            ? {}
            : { fix: state.message }),
        });

        // Every *other* key that is set and not answering.
        //
        // `connectionState` reports connected when any key is, which is right:
        // a revoked second key must not blank the first workspace's panel. But
        // that is exactly what makes a broken second key invisible, and a
        // diagnostic command that hides a broken thing is not a diagnostic
        // command. A healthy extra key produces no row.
        if (slots.length > 1) {
          for (const entry of await slotStates(false)) {
            if (entry.slot === PRIMARY_SLOT || entry.state.kind === "connected") continue;
            checks.push({
              label: entry.label,
              status: "warn",
              detail:
                entry.state.kind === "no-credential"
                  ? "set but empty"
                  : entry.state.message,
              fix: `Save a working key for that workspace, or clear the ${entry.label} field — its teams are not being read.`,
            });
          }
        }

        // The tightest across keys: a workspace that has run out is the one
        // that will fail next, whatever the others have left.
        const budget = tightestBudget();
        if (budget !== null && budget.requests.limit !== null && budget.requests.remaining !== null) {
          const fraction = budget.requests.remaining / budget.requests.limit;
          checks.push({
            label: "Request budget",
            status: fraction < 0.05 ? "warn" : "ok",
            detail: `${budget.requests.remaining} of ${budget.requests.limit} left this hour`,
            ...(fraction < 0.05
              ? {
                  fix: "Background polling has already slowed itself down. If this keeps happening, switch the sync cadence to frugal.",
                }
              : {}),
          });
        }
      }

      const bound = store.boundTeamIds();
      checks.push({
        label: "Bindings",
        status: bound.length === 0 ? "warn" : "ok",
        detail:
          bound.length === 0
            ? "no bb project is bound to a Linear team"
            : `${bound.length} ${pluralize(bound.length, "team", "teams")} bound`,
        ...(bound.length === 0
          ? { fix: "Bind one in this plugin's settings, or run: bb linear bind <TEAM-KEY> --project <id>" }
          : {}),
      });

      // The pull-request probe check returns with the write-back automations
      // (M7); until then there is nothing on this machine to probe.

      const breaker = worstBreaker();
      if (breaker.open) {
        checks.push({
          label: "Reads",
          status: "warn",
          detail: `paused after repeated failures — ${breaker.lastError ?? "unknown"}`,
          fix: "This clears itself after a minute. The panel keeps rendering from the local copy in the meantime.",
        });
      }

      return checks;
    }

    /* ── Bindings snapshot ───────────────────────────────────────────────── */
    /*
     * `bb.agents.configure` and the mention providers are **synchronous** and
     * run on the thread-start path. Reading bindings from SQLite there would
     * put a query on every thread start, so the table is kept in memory and
     * refreshed whenever it changes.
     */
    let bindingSnapshot = store.bindings();

    /**
     * Webhook ids, one per bound team, kept in memory from kv.
     *
     * **Webhooks survive reloads.** `onDispose` takes no reason and cannot
     * distinguish an uninstall from a reload, a disable, an update or a
     * shutdown — so deleting them there would destroy them on every bb restart
     * and on every plugin update, and re-creating one needs workspace-admin
     * rights most users lack plus a fresh signed self-test. A non-admin's first
     * restart would silently and permanently demote them to polling after they
     * had proved webhooks worked.
     *
     * Deletion happens only on explicit user action: clearing the webhook URL,
     * `bb linear webhook disable`, or Disconnect.
     */
    const webhookIds = new Map<string, string>();

    /**
     * Nonces from signed self-test probes that have actually arrived here.
     *
     * In memory on purpose: a probe is only meaningful within the seconds of
     * the `enable` command that sent it, and a nonce that survived a reload
     * would let a stale proof authorise a registration against a URL that no
     * longer reaches this bb.
     */
    const selfTestArrivals = new Set<string>();

    /** When a signed delivery last actually arrived. A Linear-side failure
     *  older than this is history rather than a symptom. */
    let lastWebhookDeliveryAt: number | null = null;

    function refreshBindings(): void {
      bindingSnapshot = store.bindings();
    }

    /* ── Writes ──────────────────────────────────────────────────────────── */

    const mutations: MutationDeps = {
      clientFor: (issueId) => {
        const issue = store.issue(issueId);
        return issue === null ? client : clientForTeam(issue.teamId);
      },
      store,
      now,
      publish: () => {
        // A local write drops the poller to Hot for two minutes, which is what
        // catches the server-side automations a write can trigger — workflow
        // rules, SLA recalculation, auto-assignment — without re-sweeping the
        // team.
        lastMutationAt = now();
        lastChangeAt = now();
        publish("linear:data");
      },
      signal: lifetime.signal,
      onWriteRefused: async (what) => {
        lastMutationAt = now();
        // The only evidence there will ever be that this key cannot write:
        // Linear does not expose a key's scopes, so a refusal is discovered
        // and then remembered.
        await kv.write(KV.writeRefusal, { v: 1, at: now(), what });
        cached = null;
      },
    };

    /**
     * One targeted fetch for an issue the poller has not seen — a deep link, a
     * mention of something outside the backfill window, an agent naming an
     * identifier. Never a sweep: one click must not become a hundred requests.
     */
    async function refreshIssue(idOrIdentifier: string, signal?: AbortSignal) {
      // An identifier does not say which workspace it belongs to, and with
      // several keys configured only one of them can resolve it. Tried in slot
      // order, stopping at the first that answers — which for the one-key
      // install every user has is exactly one request.
      const slots = await activeSlots();
      const candidates = slots.length === 0 ? [PRIMARY_SLOT] : slots.map((entry) => entry.slot);
      for (const slot of candidates) {
        try {
          const result = await clientForSlot(slot).issueDetail(idOrIdentifier, {
            initiator: "user",
            ...(signal ? { signal } : {}),
          });
          applyIssueDetail(store, result.issue, now());
          publish("linear:data");
          return store.issue(result.issue.id);
        } catch (error) {
          // `Query.issue` is non-nullable, so "no such issue" arrives as a
          // GraphQL error rather than a null. Distinguishing that from a real
          // failure is what lets the caller say "no issue called ENG-999"
          // instead of "something went wrong" — and here it is also what says
          // "not in this workspace, try the next key".
          if (isLinearError(error) && error.code === "query") continue;
          throw error;
        }
      }

      return null;
    }

    async function detailFor(id: string): Promise<DetailResult> {
      let issue = store.issue(id) ?? store.issueByIdentifier(id);
      if (issue === null) {
        issue = await lifetime.runAsync("issue", () => refreshIssue(id), null);
      }
      if (issue === null) return { kind: "missing", identifier: id };

      // The one place in the UI where a stranger meets the scoping rule, and
      // where the rule teaches itself: both teams named, and a way out.
      const readable = new Set(store.boundTeamIds());
      if (!readable.has(issue.teamId)) {
        const team = store.team(issue.teamId);
        const allowed = [...readable]
          .map((teamId) => store.team(teamId))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        return {
          kind: "refused",
          message: crossTeamRefusal({
            identifier: issue.identifier,
            targetTeam: { name: team?.name ?? "another team", key: team?.key ?? "?" },
            allowed: allowed.map((entry) => ({ name: entry.name, key: entry.key })),
            action: "read",
          }),
        };
      }

      const team = store.team(issue.teamId);
      const children = store
        .queryIssues({
          teamIds: [issue.teamId],
          includeCompleted: true,
          sort: "manual",
          limit: 100,
        })
        .filter((child) => child.parentId === issue.id);
      const states = store.workflowStates(issue.teamId);

      return {
        kind: "issue",
        detail: selectDetail({
          issue,
          team,
          states,
          members: new Map(store.members().map((member) => [member.id, member])),
          labels: new Map(store.labels([issue.teamId]).map((label) => [label.id, label])),
          priorityLabels: new Map(
            store.priorityValues().map((value) => [value.priority, value.label]),
          ),
          comments: store.comments(issue.id),
          commentsTruncated: false,
          subIssues: children.map((child) => ({
            id: child.id,
            identifier: child.identifier,
            title: child.title,
            type:
              child.stateId === null
                ? ""
                : (states.find((entry) => entry.id === child.stateId)?.type ?? ""),
          })),
          projectName: issue.projectId === null ? null : (store.project(issue.projectId)?.name ?? null),
          cycleName:
            issue.cycleId === null
              ? null
              : (() => {
                  const cycle = store.cycle(issue.cycleId);
                  if (cycle === null) return null;
                  // A cycle's own name where it has one, its number where it
                  // does not — which is the common case, because most teams
                  // never name a cycle.
                  return cycle.name ?? `Cycle ${cycle.number}`;
                })(),
          milestoneName:
            issue.milestoneId === null ? null : (store.milestone(issue.milestoneId)?.name ?? null),
        }),
      };
    }

    /* ── The sync service ────────────────────────────────────────────────── */
    /*
     * One loop, and the whole real-time story. Webhooks (M9) are an optional
     * latency improvement layered on top and never a replacement: Linear
     * retries a bounded number of times and then gives up with no replay API,
     * so the floor has to keep running underneath.
     *
     * **Scope is the binding, not the workspace.** The poller only ever
     * touches teams bound to at least one bb project, which is what makes the
     * plugin behave the same for a solo developer with one team and an
     * organisation with forty: cost scales with *bound* teams, and a
     * workspace-wide sweep is never issued.
     */
    let lastPanelReadAt: number | null = null;
    let lastFrontendReadAt: number | null = null;
    let lastMutationAt: number | null = null;
    let lastChangeAt: number | null = null;
    let lastTickAt: number | null = null;
    let lastSyncError: string | null = null;
    let currentIntervalMs: number | null = null;

    /**
     * The primary slot keeps the scope name it had before workspaces were
     * plural. Renaming it would reset the watermark to zero on upgrade and
     * cost every existing install a full backfill to say nothing new.
     */
    function watermarkScope(slot: CredentialSlot): string {
      return slot === PRIMARY_SLOT ? "all" : slot;
    }

    /**
     * The budget the poller has to respect.
     *
     * Linear's 2,500 requests an hour is **per key**, so several keys mean
     * several independent budgets — but one loop drives all of them, so the
     * tightest one governs the cadence. Backing off on the healthy key too is
     * the conservative direction: the alternative is a loop that keeps its
     * pace and simply fails against the exhausted workspace every tick.
     */
    function tightestBudget(): BudgetSnapshot | null {
      let tightest: BudgetSnapshot | null = null;
      for (const [, entry] of clients) {
        const snapshot = entry.budget();
        if (snapshot === null) continue;
        if (
          tightest === null ||
          (snapshot.requests.remaining ?? Infinity) < (tightest.requests.remaining ?? Infinity)
        ) {
          tightest = snapshot;
        }
      }
      return tightest;
    }

    function worstBreaker(): ReturnType<LinearClient["breaker"]> {
      let worst = client.breaker();
      for (const [, entry] of clients) {
        const view = entry.breaker();
        if (view.open && !worst.open) worst = view;
      }
      return worst;
    }

    async function readWatermark(key: string): Promise<number> {
      const record = await kv.readOptional(key, watermarkSchema);
      return record?.at ?? 0;
    }

    bb.background.service("sync", {
      async start(signal) {
        let tickNumber = 0;
        let quietTicks = 0;
        let inboxQuietTicks = 0;
        let nextInboxAt = 0;

        while (!signal.aborted && !lifetime.disposed) {
          const values = await settings.get();
          const profile = readSyncProfile(values.syncProfile);

          const slots = configuredSlots(values);
          if (slots.length === 0) {
            // A service that throws NeedsConfigurationError flips the whole
            // plugin to `needs-configuration` and stops restarting until the
            // next load, which is exactly right: there is nothing to poll and
            // nothing to retry.
            throw Object.assign(new Error(NEEDS_CONFIGURATION_MESSAGE), {
              name: "NeedsConfigurationError",
            });
          }

          const teamIds = expandTeams(store.boundTeamIds(), store.teams(), values.includeSubTeams);
          const runningLinked = [...activeThreads].some(
            (threadId) => store.threadLink(threadId) !== null,
          );

          const cadence = cadenceFor(
            {
              now: now(),
              runningLinkedThread: runningLinked,
              lastMutationAt,
              lastPanelReadAt,
              lastFrontendReadAt,
              hasBinding: teamIds.length > 0,
              lastChangeAt,
              quietTicks,
            },
            profile,
            tightestBudget(),
            budgetPressure,
          );
          currentIntervalMs = cadence.baseMs;

          if (teamIds.length > 0) {
            // One tick per workspace. Teams from different workspaces cannot
            // share a request — the filter only resolves for the key that
            // issued it — and they cannot share a watermark either, because
            // one workspace's newer timestamps would skip straight past the
            // other's older changes.
            let anyChanged = false;
            let anyApplied = false;

            for (const [slot, group] of teamsBySlot(teamIds)) {
              if (signal.aborted) break;
              const scope = watermarkScope(slot);
              const issuesWatermark = await readWatermark(KV.watermark(scope, "issues"));
              const commentsWatermark = await readWatermark(KV.watermark(scope, "comments"));

              // A watermark of zero means nothing has ever been read, and the
              // bounded backfill — not a query for everything since 1970 — is
              // what fills that gap.
              if (issuesWatermark === 0) {
                await lifetime.runAsync("backfill", async () => {
                  await backfillOnce(false);
                });
                await kv.write(KV.watermark(scope, "issues"), { v: 1, at: now() - 60_000 });
                await kv.write(KV.watermark(scope, "comments"), { v: 1, at: now() - 60_000 });
                continue;
              }

              const outcome = await lifetime.runAsync(
                "tick",
                () =>
                  runTick(
                    {
                      client: clientForSlot(slot),
                      store,
                      now,
                      log: (level, message) => lifetime.log(level, message),
                      signal,
                    },
                    { teamIds: group, issuesWatermark, commentsWatermark, tickNumber },
                  ),
                null,
              );

              if (outcome !== null && outcome.applied) {
                anyApplied = true;
                if (outcome.issuesWatermark !== null) {
                  await kv.write(KV.watermark(scope, "issues"), {
                    v: 1,
                    at: outcome.issuesWatermark,
                  });
                }
                if (outcome.commentsWatermark !== null) {
                  await kv.write(KV.watermark(scope, "comments"), {
                    v: 1,
                    at: outcome.commentsWatermark,
                  });
                }
                if (outcome.changed) anyChanged = true;
              }
            }

            tickNumber += 1;
            lastTickAt = now();

            if (anyApplied) lastSyncError = null;
            if (anyChanged) {
              lastChangeAt = now();
              quietTicks = 0;
              publish("linear:data");
            } else {
              // Decay. Any observed change resets to the floor, which is what
              // stops a decayed poller taking a minute to notice that things
              // started happening again.
              quietTicks += 1;
            }
          }

          // The inbox runs on its own clock, independent of the tiers above:
          // a notification is worth knowing about whether or not the panel is
          // open. Sharing the one loop rather than starting a second service
          // keeps the transport's single-flight promise honest.
          if (now() >= nextInboxAt) {
            const sent = await lifetime.runAsync("notifications", pollNotifications, 0);
            if (sent !== null && sent > 0) {
              inboxQuietTicks = 0;
            } else {
              inboxQuietTicks += 1;
            }
            nextInboxAt = now() + inboxInterval({ quietTicks: inboxQuietTicks }, profile);
          }

          await sleep(cadence.delayMs, signal);
        }
      },
    });

    /*
     * Two schedules. Cron is **server-local time** — the README says "on the
     * machine running bb" rather than pretending to know a timezone.
     */
    bb.background.schedule("reconcile", "*/15 * * * *", async () => {
      // A hard delete leaves no tombstone, and archiving is invisible to a
      // delta poller unless `includeArchived` is set (it is). This sweep is
      // what catches the rest, within a bounded window.
      await lifetime.runAsync("reconcile", async () => {
        await backfillOnce(true);
      });
    });

    bb.background.schedule("prune", "17 4 * * *", async () => {
      lifetime.run("prune", () => {
        // An echo that has outlived any tick interval is a row nobody will
        // ever read again.
        const dropped = store.pruneEchoes(now() - 3_600_000);
        // Claims older than thirty days cannot affect anything: the
        // notifications they guard are long past the watermark.
        const claims = store.pruneDeliveries(now() - 30 * 86_400_000);
        if (dropped + claims > 0) {
          lifetime.log("debug", `Pruned ${dropped} echo rows and ${claims} delivery claims.`);
        }
      });
    });

    /* ── Webhooks ────────────────────────────────────────────────────────── */
    /*
     * The one sanctioned use of `auth: "none"` in this plugin, and the handler
     * earns it: the HMAC is verified before any work at all — before parsing,
     * before a database touch, before a log line that could carry
     * attacker-controlled text.
     *
     * **Returns 200 immediately and processes asynchronously.** A slow local
     * write must never become a Linear-side delivery failure: Linear retries at
     * most three times and then disables the webhook, with no replay API.
     */
    bb.http.route(
      "POST",
      // The leading slash is required — the host rejects a bare path at
      // registration, and a rejected registration fails the whole reload.
      // The doc comment's `/api/v1/plugins/<id>/http/<path>` reads as though
      // it were optional; it is not.
      "/webhook",
      async (context) => {
        // The RAW body text. Never parse-then-restringify — the signature is
        // over the bytes Linear sent, and a round trip reorders keys.
        const raw = await context.req.text();
        const verified = verifyWebhook({
          raw,
          signature: context.req.header("linear-signature") ?? null,
          secret: store.localSecret(WEBHOOK_SECRET_KEY),
          now: now(),
          organizationId: store.workspace()?.id ?? null,
          knownWebhookIds: new Set(webhookIds.values()),
          boundTeamIds: new Set(store.boundTeamIds()),
        });

        if (!verified.ok) {
          // Deliberately terse and deliberately not logged at warn: an
          // unauthenticated route that logs attacker-controlled text at volume
          // is its own denial of service, and `bb plugin logs` rotates at 5 MB.
          lifetime.log("debug", `Webhook rejected: ${verified.reason}`);
          return new Response("no", { status: verified.reason === "no-secret" ? 503 : 401 });
        }

        const body = verified.body;

        // A self-test probe is a proof of reachability and nothing else: it
        // carries no entity, so it must not enter the delivery pipeline. It is
        // signed with the same secret and verified by the same code path as a
        // real delivery, which is the whole point — a probe that took a
        // shortcut could pass while the real path failed.
        if (body.type === "SelfTest") {
          const nonce = body.data?.id;
          if (typeof nonce === "string") selfTestArrivals.add(nonce);
          return new Response("ok", { status: 200 });
        }

        lastWebhookDeliveryAt = now();
        lifetime.detach("webhook", async () => {
          // Through the **same** claim table as a polled notification. One
          // dedupe mechanism for both paths is what stops webhook mode
          // becoming a second, subtly different pipeline — and Linear retries,
          // so duplicates are expected by design.
          const key = webhookDeliveryKey(body);
          if (!store.claimDelivery(key, `webhook:${body.type}`, now())) return;
          store.markDelivered(key, now());

          // A webhook is a *latency improvement*, not a replacement: it tells
          // the poller something changed, and the poller is what reads it.
          // That keeps one apply path rather than two.
          lastChangeAt = now();
          publish("linear:data");
        });

        return new Response("ok", { status: 200 });
      },
      { auth: "none" },
    );

    /**
     * Turn webhooks on for the bound teams — **after** proving the URL reaches
     * this bb, never before.
     *
     * Registering against an unreachable URL is worse than not registering:
     * Linear retries three times over six hours, disables the webhook, and
     * tells nobody. The user then believes they are on webhooks and is on
     * nothing. So: check the URL, mint a secret, POST a signed probe to the
     * user's own endpoint, and only call `webhookCreate` if that probe comes
     * back through the handler above.
     */
    async function enableWebhooks(rawUrl: string): Promise<{ ok: boolean; text: string }> {
      const verdict = checkWebhookUrl(rawUrl);
      if (!verdict.ok) return { ok: false, text: `${verdict.why}\n` };
      const url = verdict.url;

      const teamIds = store.boundTeamIds();
      if (teamIds.length === 0) {
        return {
          ok: false,
          text: "No teams are bound yet, and a webhook is scoped to one team. Bind a team first — bb linear bind <TEAM>.\n",
        };
      }

      // Written before the probe is sent, because the handler verifies the
      // probe's signature against exactly this value. A secret generated after
      // a successful send would have nothing to verify against.
      const secret = store.localSecret(WEBHOOK_SECRET_KEY) ?? "";
      const signing = secret === "" ? newSigningSecret() : secret;
      store.putLocalSecret(WEBHOOK_SECRET_KEY, signing);

      const nonce = newNonce();
      const selfTest = await runSelfTest({
        url,
        secret: signing,
        nonce,
        now: now(),
        arrived: (value) => selfTestArrivals.has(value),
        sleep: (ms) => sleep(ms, lifetime.signal),
      });
      selfTestArrivals.delete(nonce);

      if (!selfTest.ok) {
        return {
          ok: false,
          text: `The self-test failed, so nothing was registered.\n\n  ${selfTest.why}\n\n  The plugin keeps polling, which always works.\n`,
        };
      }

      const existing = new Map<string, { id: string; url: string }>();
      for (const key of await kv.keys("webhook:")) {
        const record = await kv.readOptional(key, webhookRecordSchema);
        if (record !== undefined) {
          existing.set(key.slice("webhook:".length), { id: record.id, url: record.url });
        }
      }

      const plan = planRegistration(teamIds, existing, url);
      const created: string[] = [];
      const failed: string[] = [];

      for (const entry of plan.deleteIds) {
        try {
          await clientForTeam(entry.teamId).deleteWebhook(entry.id);
        } catch (error) {
          lifetime.log("debug", `Could not delete webhook ${entry.id}: ${describeError(error)}`);
        }
      }

      for (const teamId of plan.create) {
        const team = store.team(teamId);
        const label = `bb (${team?.key ?? teamId})`;
        try {
          const result = await clientForTeam(teamId).createWebhook({
            url,
            teamId,
            secret: signing,
            resourceTypes: RESOURCE_TYPES,
            label,
          });
          const webhook = unwrapMutation<{ id: string }>(
            result.webhookCreate,
            "webhook",
            "create the webhook",
          );
          await kv.write(`webhook:${teamId}`, { v: 1, id: webhook.id, url });
          webhookIds.set(teamId, webhook.id);
          created.push(team?.key ?? teamId);
        } catch (error) {
          failed.push(`${team?.key ?? teamId}: ${describeError(error)}`);
        }
      }

      if (created.length === 0 && failed.length > 0) {
        return {
          ok: false,
          text:
            `The URL works, but Linear refused to register the webhook.\n\n  ${failed.join("\n  ")}\n\n` +
            "  Creating a webhook needs a workspace-admin key. The plugin keeps polling, which always works.\n",
        };
      }

      const lines = [
        `Self-test passed — ${url} reaches this bb.`,
        created.length > 0 ? `Registered for ${created.join(", ")}.` : null,
        plan.keep.length > 0 ? `${String(plan.keep.length)} already registered.` : null,
        failed.length > 0 ? `Could not register: ${failed.join("; ")}` : null,
        "",
        "  The poller keeps running underneath. A webhook is a latency improvement,",
        "  not a replacement — Linear retries a failed delivery three times and then",
        "  gives up, with no replay API.",
        "",
      ].filter((line) => line !== null);

      return { ok: true, text: `${lines.join("\n")}\n` };
    }

    /**
     * Health, every five minutes, and only ever heard from when something is
     * wrong.
     *
     * Linear disables a webhook after three failed deliveries and does not say
     * so anywhere the user will look. This is the only thing standing between
     * "instant updates" and "silently no updates for a week" — and because the
     * poller never stopped, demotion is a latency regression rather than an
     * outage.
     */
    bb.background.schedule("webhook-health", "*/5 * * * *", async () => {
      if (webhookIds.size === 0) return;
      await lifetime.runAsync("webhook-health", async () => {
        for (const [teamId, id] of [...webhookIds]) {
          let health;
          try {
            const result = await clientForTeam(teamId).readWebhook(id, {
              initiator: "background",
            });
            health = webhookHealth({
              enabled: result.webhook.enabled,
              failures: result.webhook.failures,
              lastDeliveryAt: lastWebhookDeliveryAt,
              now: now(),
            });
          } catch (error) {
            // A key that cannot *read* webhooks says nothing about whether
            // deliveries are arriving, so this is not a demotion.
            lifetime.log("debug", `Webhook health unavailable for ${teamId}: ${describeError(error)}`);
            continue;
          }

          if (health.state === "healthy") continue;

          const message = describeDemotion(health, store.team(teamId)?.key ?? teamId);
          if (message !== null) lifetime.log("warn", message);

          // The record goes, so `webhook status` stops claiming a delivery
          // path that Linear has stopped honouring. The remote webhook is left
          // alone when Linear already disabled it, and deleted when it is
          // merely failing, so a later `enable` starts from a clean slate.
          if (health.state === "failing") {
            try {
              await clientForTeam(teamId).deleteWebhook(id, { initiator: "background" });
            } catch {
              // Best effort. The local record going is what matters.
            }
          }
          await kv.remove(`webhook:${teamId}`);
          webhookIds.delete(teamId);
          cached = null;
          publish("linear:data");
        }
      });
    });

    /* ── Notifications ───────────────────────────────────────────────────── */

    /**
     * The delivery ladder, run once per notification.
     *
     * Rung 1 is unconditional and never fails. Rungs 2 and 3 are guarded by
     * the claim, which is what makes delivery at-most-once across restarts —
     * a crash between the claim and the send loses one push, and losing one
     * push whose row is still sitting unseen in the panel is strictly better
     * than a duplicate buzz after every crash.
     */
    async function pollNotifications(): Promise<number> {
      // Every key has its own inbox, because a Linear notification belongs to
      // a viewer and each key is a different viewer. One workspace's quiet
      // afternoon must not advance another's cursor.
      let sent = 0;
      for (const entry of await activeSlots()) {
        if (lifetime.disposed) break;
        try {
          sent += await pollNotificationsFor(entry.slot);
        } catch (error) {
          lifetime.log(
            "debug",
            `Could not read the ${slotLabel(entry.slot)}'s inbox: ${describeError(error)}`,
          );
        }
      }
      return sent;
    }

    async function pollNotificationsFor(slot: CredentialSlot): Promise<number> {
      const values = await settings.get();
      const watermarkKey = KV.notificationWatermarkFor(slot);
      const since = await kv.readOptional(watermarkKey, watermarkSchema);
      const install = await kv.readOptional(KV.installWatermark, installWatermarkSchema);
      const installWatermark = install?.at ?? now();

      // A brand-new install starts its notification cursor at *now*, so a
      // stranger does not receive three hundred notifications about last
      // quarter on their first afternoon.
      const cursor = since?.at ?? installWatermark;

      const result = await clientForSlot(slot).notifications(new Date(cursor).toISOString(), {
        initiator: "background",
      });
      if (result.notifications.nodes.length === 0) return 0;

      const viewer = store.viewer();
      const boundTeamIds = new Set(store.boundTeamIds());
      const rows = result.notifications.nodes.map((node) => toInboxRow(node, now()));
      store.putInbox(rows);

      let sent = 0;
      for (const node of result.notifications.nodes) {
        const verdict = shouldSend({
          node,
          now: now(),
          viewerId: viewer?.id ?? null,
          installWatermark,
          boundTeamIds,
          isEcho: (entityId, updatedAt) => store.isEcho(entityId, updatedAt),
          settings: {
            assigned: values.notifyAssigned,
            comments: values.notifyComments,
            blocked: values.notifyBlocked,
          },
        });
        if (!verdict.send) continue;

        const key = deliveryKey(node);
        const kind = classify(node);
        const delivered = await claimAndSend(
          {
            claim: (k, ki, at) => store.claimDelivery(k, ki, at),
            markSent: (k, at) => store.markDelivered(k, at),
          },
          { key, kind, now: now() },
          async () => {
            // Rung 2: only if the user named a peer. No candidate list and no
            // auto-detection — "detection" could only mean calling a guessed
            // method on somebody else's plugin.
            await deliverToPeer(
              {
                listPlugins: async () => {
                  const { plugins } = await bb.sdk.plugins.list();
                  return plugins.map((entry) => ({
                    id: entry.id,
                    enabled: entry.enabled,
                    status: entry.status,
                  }));
                },
                callRpc: (args) => bb.sdk.plugins.callRpc(args as never),
                log: (level, message) => lifetime.log(level, message),
              },
              values.pushPluginId,
              {
                title: node.title,
                body: node.subtitle,
                url: node.inboxUrl,
                tag: key,
              },
            );
          },
        );
        if (delivered) sent += 1;
      }

      // Rung 3: the frontend raises the toast on this signal. The backend
      // never toasts.
      publish("linear:inbox");
      publish("linear:data");

      const newest = result.notifications.nodes
        .map((node) => Date.parse(node.createdAt))
        .filter((value) => Number.isFinite(value));
      if (newest.length > 0 && !result.notifications.pageInfo.hasNextPage) {
        await kv.write(watermarkKey, { v: 1, at: Math.max(...newest) });
      }
      return sent;
    }

    /* ── Write-back automations (M7) — OFF by default ────────────────────── */
    /*
     * Both automations are opt-in settings that default to false: agents with
     * a Linear connection often drive states themselves, and two writers
     * fighting over one card is worse than either alone. When on, targets
     * come from the team's own Linear git-automation configuration — fetched
     * here, cached in the mirror — so the plugin never invents a transition.
     */

    const automationFetched = new Set<string>();

    /** Fetch the team's git-automation config once per load, lazily, right
     *  before the first transition that would read it. A team with none
     *  configured still gets an (empty) row set, and the runner's typed
     *  fallbacks — merge ⇒ the earliest completed state — carry from there. */
    async function ensureAutomationConfig(teamId: string): Promise<void> {
      if (automationFetched.has(teamId)) return;
      automationFetched.add(teamId);
      try {
        const result = await clientForTeam(teamId).teamAutomation(teamId, {
          initiator: "background",
        });
        const states = result.team?.gitAutomationStates?.nodes ?? [];
        store.replaceGitAutomation(
          teamId,
          states.map((node) => ({
            id: node.id,
            teamId,
            event: node.event,
            stateId: node.state?.id ?? null,
            stateName: node.state?.name ?? null,
            targetBranchPattern: node.targetBranch?.branchPattern ?? null,
            targetBranchIsRegex: node.targetBranch?.isRegex ?? false,
          })),
        );
      } catch (error) {
        // Absent config is a working default, so a failed fetch must not
        // block the transition — it only costs fidelity, not correctness.
        automationFetched.delete(teamId);
        lifetime.log("debug", `Could not read git automation for ${teamId}: ${describeError(error)}`);
      }
    }

    async function prDepsNow(): Promise<PrRunnerDeps> {
      const slots = await activeSlots();
      return {
        clients: slots.map((entry) => clientForSlot(entry.slot)),
        clientForIssue: (issueId) => {
          const issue = store.issue(issueId);
          return issue === null ? client : clientForTeam(issue.teamId);
        },
        store,
        mutations,
        now,
        log: (level, message) => lifetime.log(level, message),
        lookupPullRequest: (environmentId) =>
          bb.sdk.environments.pullRequest({ environmentId }) as never,
      };
    }

    /** Runs on `thread.active` and `thread.idle` for threads whose
     *  environment has a branch. Never in a tight loop — the lookup shells
     *  out to `gh`. */
    async function runTransitionForThread(threadId: string): Promise<void> {
      const values = await settings.get();
      if (!values.prTransitions) return;

      const thread = await bb.sdk.threads.get({ threadId });
      const environmentId = thread.environmentId;
      if (environmentId === null || environmentId === undefined) return;

      const environment = await bb.sdk.environments.get({ environmentId });
      const projectId = thread.projectId ?? null;
      const scope = projectId === null ? null : scopeFor(projectId, bindingSnapshot);

      const link = store.threadLink(threadId);
      if (link !== null) await ensureAutomationConfig(link.teamId);

      const outcome = await runPrTransition(await prDepsNow(), {
        environmentId,
        branchName: environment.branchName ?? null,
        enabled: true,
        canWrite: (teamId) => scope !== null && scope.writeTeamIds.includes(teamId),
        // The completed state is identifiable by `type`, which is what makes
        // this fallback safe in any language.
        completedStateId: (teamId) =>
          store
            .workflowStates(teamId)
            .filter((state) => state.type === "completed")
            .sort((a, b) => a.position - b.position)[0]?.id ?? null,
      });

      if (outcome.kind === "moved") {
        lastMutationAt = now();
        lastChangeAt = now();
        publish("linear:data");
      }
    }

    /**
     * Bound + actively working ⇒ the team's started state.
     *
     * Lifts only forward, from triage/backlog/unstarted — a thread resuming
     * on an issue already in review must never demote it. The target is the
     * team's own `start` automation state where one is configured, else its
     * earliest started-type column.
     */
    async function moveStartedForThread(threadId: string): Promise<void> {
      const values = await settings.get();
      if (!values.threadMovesStatus) return;

      const link = store.threadLink(threadId);
      if (link === null) return;
      const issue = store.issue(link.issueId);
      if (issue === null) return;

      const scope = link.projectId === null ? null : scopeFor(link.projectId, bindingSnapshot);
      if (scope === null || !scope.writeTeamIds.includes(issue.teamId)) return;

      const states = store.workflowStates(issue.teamId);
      const current = states.find((state) => state.id === issue.stateId);
      if (
        current !== undefined &&
        current.type !== "triage" &&
        current.type !== "backlog" &&
        current.type !== "unstarted"
      ) {
        return;
      }

      await ensureAutomationConfig(issue.teamId);
      const configured = store
        .gitAutomation(issue.teamId)
        .find((row) => row.event === "start" && row.stateId !== null);
      const targetId =
        configured?.stateId ??
        states
          .filter((state) => state.type === "started")
          .sort((a, b) => a.position - b.position)[0]?.id ??
        null;
      if (targetId === null || targetId === issue.stateId) return;

      try {
        await updateIssue(
          mutations,
          issue.id,
          { stateId: targetId },
          `${issue.identifier} wasn't moved`,
        );
        lastMutationAt = now();
        lastChangeAt = now();
        publish("linear:data");
        lifetime.log("info", `${issue.identifier} → started: a bound thread began working on it.`);
      } catch (error) {
        lifetime.log("debug", `Thread-start move skipped: ${describeError(error)}`);
      }
    }

    /* ── Starting a thread from an issue (M8) ────────────────────────────── */

    const startDeps: StartDeps = {
      bb,
      clientForIssue: (issueId) => {
        const issue = store.issue(issueId);
        return issue === null ? client : clientForTeam(issue.teamId);
      },
      store,
      mutations,
      bindings: () => bindingSnapshot,
      branchMode: () => readSpawnBranchMode(initialSettings.spawnBranchMode),
      movesStatus: () => initialSettings.spawnMovesStatus,
      now,
      publish: () => publish("linear:data"),
    };

    /* ── The binding ladder (M3) ─────────────────────────────────────────── */

    /** The fuzzy rung's candidate per thread. In memory on purpose: a
     *  suggestion is a hint, and a hint that survives a restart outlives its
     *  evidence. */
    const suggestions = new Map<
      string,
      { issueId: string; identifier: string; title: string }
    >();

    /** What `contributeInstructions` serves. That hook is synchronous and on
     *  the thread-start path, so the strings are prebuilt here and only ever
     *  *read* there. */
    const instructionCache = new Map<string, string>();

    /**
     * Issues this thread said "not that one" to.
     *
     * A manual unlink must stick: without this, the next thread event re-runs
     * the ladder and the branch rung re-binds the exact issue the user just
     * removed. In memory — a restart forgets declines, which errs toward
     * re-offering, and re-offering is one click to decline again.
     */
    const declined = new Map<string, Set<string>>();

    function ladderDeps(readTeamIds: ReadonlySet<string>, threadId: string): LadderDeps {
      const declinedHere = declined.get(threadId) ?? new Set<string>();
      return {
        threadLink: (id) => store.threadLink(id),
        issuesByBranch: (branch) =>
          store.issuesByBranch(branch).filter((issue) => !declinedHere.has(issue.id)),
        issueByIdentifier: (identifier) => {
          const issue = store.issueByIdentifier(identifier);
          return issue !== null && declinedHere.has(issue.id) ? null : issue;
        },
        openIssues: () =>
          store
            .queryIssues({
              teamIds: [...readTeamIds],
              includeCompleted: false,
              sort: "updated",
              limit: 200,
            })
            .filter((issue) => !declinedHere.has(issue.id))
            .map((issue) => ({
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              teamId: issue.teamId,
            })),
        readTeamIds,
      };
    }

    async function evaluateThreadBinding(
      threadId: string,
      extraTexts: readonly string[],
    ): Promise<void> {
      const thread = await lifetime.runAsync(
        "thread",
        () => bb.sdk.threads.get({ threadId }),
        null,
      );
      if (thread === null) return;

      const projectId = thread.projectId ?? null;
      const scope = projectId === null ? null : scopeFor(projectId, bindingSnapshot);
      const readTeamIds = new Set(scope?.readTeamIds ?? []);
      if (readTeamIds.size === 0) {
        suggestions.delete(threadId);
        rebuildInstruction(threadId);
        return;
      }

      let branchName: string | null = null;
      const environmentId = thread.environmentId ?? null;
      if (environmentId !== null) {
        const environment = await lifetime.runAsync(
          "environment",
          () => bb.sdk.environments.get({ environmentId }),
          null,
        );
        branchName = environment?.branchName ?? null;
      }

      const title = thread.title ?? null;
      const outcome = resolveBinding(ladderDeps(readTeamIds, threadId), {
        threadId,
        branchName,
        texts: [title ?? "", ...extraTexts],
        title,
      });

      if (outcome.kind === "bound") {
        if (outcome.isNew) {
          store.linkThread({
            threadId,
            issueId: outcome.issueId,
            teamId: outcome.teamId,
            projectId,
            createdAt: now(),
            origin: outcome.origin,
          });
          suggestions.delete(threadId);
          publish("linear:data");
        }
      } else if (outcome.kind === "suggestion") {
        const previous = suggestions.get(threadId);
        suggestions.set(threadId, {
          issueId: outcome.issueId,
          identifier: outcome.identifier,
          title: outcome.title,
        });
        if (previous?.issueId !== outcome.issueId) publish("linear:data");
      } else if (suggestions.delete(threadId)) {
        publish("linear:data");
      }
      rebuildInstruction(threadId);
    }

    /** The per-turn sentence an agent gets about its thread's issue: what it
     *  is, where it stands, how it was bound, and the three commands that
     *  matter — so the task follows the thread with zero tool calls. */
    function rebuildInstruction(threadId: string): void {
      const link = store.threadLink(threadId);
      if (link === null) {
        instructionCache.delete(threadId);
        return;
      }
      const issue = store.issue(link.issueId);
      if (issue === null) {
        instructionCache.delete(threadId);
        return;
      }
      const state = store
        .workflowStates(issue.teamId)
        .find((entry) => entry.id === issue.stateId);
      instructionCache.set(
        threadId,
        [
          `This thread is working on Linear issue ${issue.identifier} — "${issue.title}"`,
          `(state: ${state?.name ?? "unknown"}; bound via ${link.origin}).`,
          `Read it with \`bb linear issue ${issue.identifier} --comments\`;`,
          `comment with \`bb linear comment ${issue.identifier} -- <text>\`;`,
          `move it with \`bb linear move ${issue.identifier} <state-name-or-type>\`.`,
        ].join(" "),
      );
    }

    /** Re-derive every cached sentence from the mirror. Called from the
     *  throttled publish path, so a state change reaches the next turn's
     *  context without a per-turn database read. */
    function rebuildAllInstructions(): void {
      for (const threadId of [...instructionCache.keys()]) rebuildInstruction(threadId);
    }

    bb.agents.contributeInstructions(({ threadId }) =>
      threadId === undefined || threadId === null
        ? null
        : (instructionCache.get(threadId) ?? null),
    );

    function bindManually(
      threadId: string,
      issueId: string | null,
      projectId: string | null,
    ): { ok: boolean; message: string | null } {
      if (issueId === null) {
        const existing = store.threadLink(threadId);
        if (existing !== null) {
          const set = declined.get(threadId) ?? new Set<string>();
          set.add(existing.issueId);
          declined.set(threadId, set);
        }
        store.unlinkThread(threadId);
        suggestions.delete(threadId);
        instructionCache.delete(threadId);
        publish("linear:data");
        return { ok: true, message: "Unlinked." };
      }
      const issue = store.issue(issueId) ?? store.issueByIdentifier(issueId);
      if (issue === null) {
        return { ok: false, message: `No issue called ${issueId} in the local copy.` };
      }
      declined.get(threadId)?.delete(issue.id);
      store.linkThread({
        threadId,
        issueId: issue.id,
        teamId: issue.teamId,
        projectId,
        createdAt: now(),
        origin: "manual",
      });
      suggestions.delete(threadId);
      rebuildInstruction(threadId);
      publish("linear:data");
      return { ok: true, message: `Linked to ${issue.identifier}.` };
    }

    /* ── Registrations ───────────────────────────────────────────────────── */

    bb.rpc.register(serverRpcContract, {
      async status() {
        const states = await slotStates(false);
        return {
          configured: states.length > 0,
          accounts: states.map((entry) => {
            if (entry.state.kind === "connected") {
              return {
                slot: entry.slot,
                label: entry.label,
                orgName: entry.state.workspace.name,
                orgUrlKey: entry.state.workspace.urlKey,
                displayName: entry.state.viewer.displayName,
                error: null,
              };
            }
            return {
              slot: entry.slot,
              label: entry.label,
              orgName: null,
              orgUrlKey: null,
              displayName: null,
              error: describeConnection(entry.state),
            };
          }),
        };
      },

      async threadIssue({ threadId }) {
        const link = store.threadLink(threadId);
        if (link !== null) {
          const issue = store.issue(link.issueId);
          if (issue !== null) {
            const states = store.workflowStates(issue.teamId);
            const state = states.find((entry) => entry.id === issue.stateId) ?? null;
            return {
              binding: {
                issueId: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                stateName: state?.name ?? "Unknown state",
                tone: toneForStateType(state?.type),
                url: issue.url,
                origin: link.origin,
                stateOptions: [...states]
                  .sort((a, b) => a.position - b.position)
                  .map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    type: entry.type,
                    tone: toneForStateType(entry.type),
                  })),
              },
              suggestion: null,
            };
          }
        }
        // Unbound: kick an evaluation so a chip mounted on a fresh thread
        // converges without waiting for the next lifecycle event.
        lifetime.detach("binding", async () => {
          await evaluateThreadBinding(threadId, []);
        });
        const suggestion = suggestions.get(threadId) ?? null;
        return { binding: null, suggestion };
      },

      async bindThread({ threadId, issueId }) {
        const thread = await lifetime.runAsync(
          "thread",
          () => bb.sdk.threads.get({ threadId }),
          null,
        );
        return bindManually(threadId, issueId, thread?.projectId ?? null);
      },

      async issue({ id }) {
        return { result: await detailFor(id) };
      },

      async updateIssue(params) {
        const issue = store.issue(params.id) ?? store.issueByIdentifier(params.id);
        if (issue === null) {
          return { ok: false, message: `No issue called ${params.id}.` };
        }
        try {
          await updateIssue(
            mutations,
            issue.id,
            {
              ...(params.stateId === undefined ? {} : { stateId: params.stateId }),
              ...(params.assigneeId === undefined ? {} : { assigneeId: params.assigneeId }),
              ...(params.priority === undefined ? {} : { priority: params.priority }),
              ...(params.estimate === undefined ? {} : { estimate: params.estimate }),
              ...(params.dueDate === undefined ? {} : { dueDate: params.dueDate }),
              ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
              ...(params.cycleId === undefined ? {} : { cycleId: params.cycleId }),
              ...(params.milestoneId === undefined ? {} : { milestoneId: params.milestoneId }),
              ...(params.title === undefined ? {} : { title: params.title }),
              ...(params.description === undefined ? {} : { description: params.description }),
              ...(params.addLabelIds === undefined ? {} : { addLabelIds: params.addLabelIds }),
              ...(params.removeLabelIds === undefined
                ? {}
                : { removeLabelIds: params.removeLabelIds }),
            },
            `${issue.identifier} wasn't changed`,
          );
          return { ok: true, message: null };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      /**
       * The lists a picker offers, for one issue's team — read entirely from
       * the mirror. Opening a dropdown must not wait on Linear.
       */
      async editorOptions({ issueId }) {
        const issue = store.issue(issueId) ?? store.issueByIdentifier(issueId);
        if (issue === null) {
          return {
            states: [],
            members: [],
            labels: [],
            priorities: [],
            projects: [],
            cycles: [],
            estimates: [],
          };
        }

        const team = store.team(issue.teamId);
        const estimationType = team?.estimationType ?? "notUsed";

        return {
          states: [...store.workflowStates(issue.teamId)]
            .sort((a, b) => a.position - b.position)
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              type: entry.type,
              tone: toneForStateType(entry.type),
            })),

          /*
           * Only people who can actually be assigned. Linear refuses
           * `issueUpdate` with "not a member" for anyone outside the issue's
           * team — found by clicking one. The fallback is the workspace list,
           * for the case where membership has never been read.
           */
          members: (() => {
            const onTeam = new Set(store.teamMemberIds(issue.teamId));
            const everyone = store.members().filter((entry) => entry.active && !entry.isApp);
            return onTeam.size === 0
              ? everyone
              : everyone.filter((entry) => onTeam.has(entry.id));
          })().map((entry) => ({
            id: entry.id,
            name: entry.displayName,
            initials: initialsOf(entry.displayName || entry.name),
            avatarUrl: entry.avatarUrl,
            isMe: entry.isMe,
          })),

          labels: store
            .labels([issue.teamId])
            .filter((entry) => !entry.isGroup)
            .map((entry) => ({ id: entry.id, name: entry.name, color: entry.color })),

          priorities: store.priorityValues().map((entry) => ({
            priority: entry.priority,
            label: entry.label,
          })),

          projects: store
            .projects([issue.teamId])
            .map((entry) => ({ id: entry.id, name: entry.name })),

          cycles: store.cycles(issue.teamId).map((entry) => ({
            id: entry.id,
            name: entry.name ?? `Cycle ${String(entry.number)}`,
          })),

          estimates: estimateScale(estimationType, {
            allowZero: team?.estimationAllowZero ?? false,
            extended: team?.estimationExtended ?? false,
          }).map((value) => ({ value, label: estimateLabel(value, estimationType) })),
        };
      },

      async comment({ issueId, body }) {
        try {
          await postComment(mutations, { issueId, body, clientId: clientId() });
          return { ok: true, message: null };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      /* ── M4: the nav panel ─────────────────────────────────────────────── */

      async connection({ recheck }) {
        return { state: await connectionState(recheck === true) };
      },

      async workspaces() {
        const states = await slotStates(false);
        const teamsPerWorkspace = new Map<string, number>();
        for (const entry of store.teams()) {
          if (entry.workspaceId === null) continue;
          teamsPerWorkspace.set(
            entry.workspaceId,
            (teamsPerWorkspace.get(entry.workspaceId) ?? 0) + 1,
          );
        }
        const workspaceBySlot = new Map(store.workspaces().map((entry) => [entry.slot, entry]));

        return {
          workspaces: states.map((entry) => {
            const workspace = workspaceBySlot.get(entry.slot);
            return {
              slot: entry.slot,
              label: entry.label,
              teams: workspace === undefined ? 0 : (teamsPerWorkspace.get(workspace.id) ?? 0),
              state: entry.state,
            };
          }),
        };
      },

      async refreshWorkspace() {
        const result = await cliEnvironment.refresh();
        return {
          ok: result.ok,
          message: result.text.trim(),
          teamsVisible: store.teams().length,
        };
      },

      async panel(query) {
        // The rpc call *is* the visibility signal — no second channel to keep
        // in step, and true by construction.
        lastPanelReadAt = now();
        lastFrontendReadAt = now();
        const deps = await panelDeps();
        // Mounting the panel is what starts the first read. Doing it here
        // rather than in the factory keeps the load path offline-safe: a
        // flaky connection during an upgrade must not fail activation.
        if (deps.hasCredential && store.teams().length === 0) {
          lifetime.detach("discover", async () => {
            await discoverOnce();
          });
        }
        if (deps.boundTeamIds.length > 0) {
          lifetime.detach("backfill", async () => {
            await backfillOnce(false);
          });
        }
        return buildPanelView(deps, {
          team: query.team,
          grouping: query.grouping,
          sort: query.sort,
          search: query.search,
          filters: query.filters,
        });
      },

      async facets({ team }) {
        return buildFacets(await panelDeps(), team);
      },

      async workingSet({ team }) {
        lastPanelReadAt = now();
        lastFrontendReadAt = now();
        const deps = await panelDeps();
        if (deps.boundTeamIds.length > 0) {
          lifetime.detach("backfill", async () => {
            await backfillOnce(false);
          });
        }
        return { view: buildWorkingSet(deps, team), notice: panelNotice() };
      },

      async bindings() {
        const projects = await projectSummaries();
        if (store.teams().length === 0) {
          lifetime.detach("discover", async () => {
            await discoverOnce();
          });
        }
        return buildBindingsView({
          projects,
          bindings: store.bindings(),
          teams: store.teams(),
          workspaces: store.workspaces(),
          workspaceName: store.workspace()?.name ?? null,
        });
      },

      async bind({ projectId, teamId, role }) {
        const team = store.team(teamId);
        if (team === null) {
          return { ok: false, message: "That team isn't in the local copy yet. Try again in a moment." };
        }
        store.setBinding(projectId, teamId, role, now());
        refreshBindings();
        publish("linear:data");
        lifetime.detach("backfill", async () => {
          await backfillOnce(false);
        });
        return {
          ok: true,
          message: `Reading ${team.name}'s open issues — this takes a few seconds the first time.`,
        };
      },

      async unbind({ projectId, teamId }) {
        store.removeBinding(projectId, teamId);
        refreshBindings();
        publish("linear:data");
        // The issues stay until the nightly prune, which is deliberate: a
        // mis-click that dropped a binding should not also cost the local copy
        // and a fresh backfill to undo.
        return { ok: true, message: null };
      },

      async resolveIdentifiers({ identifiers, threadId }) {
        if (identifiers.length === 0) return { issues: [] };

        const thread =
          threadId === null
            ? null
            : await lifetime.runAsync("thread", () => bb.sdk.threads.get({ threadId }), null);
        const projectId = thread?.projectId ?? null;
        const current = projectId === null ? null : scopeFor(projectId, bindingSnapshot);

        // With no project to scope by, every bound team is fair game — the
        // alternative is answering nothing at all in a personal thread.
        const readable =
          current === null || current.readTeamIds.length === 0
            ? store.boundTeamIds()
            : current.readTeamIds;

        const rows: IssueRow[] = [];
        const seen = new Set<string>();
        for (const identifier of identifiers) {
          const issue = store.issueByIdentifier(identifier);
          if (issue === null) continue;
          if (!readable.includes(issue.teamId)) continue;
          if (seen.has(issue.id)) continue;
          seen.add(issue.id);
          rows.push(issue);
        }
        if (rows.length === 0) return { issues: [] };

        return { issues: buildRowViews(await panelDeps(), rows) };
      },

      async preferences() {
        const record = await kv.readOptional(KV.sortPreference, sortPreferenceSchema);
        return { sort: record?.sort ?? null };
      },

      async setSort({ sort }) {
        await kv.write(KV.sortPreference, { v: 1, sort });
        return { ok: true };
      },

      async archiveIssue({ id }) {
        try {
          await archiveIssue(mutations, id);
          return { ok: true, message: null };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      async startThread({ issueId, projectId }) {
        try {
          const result = await startThreadFromIssue(startDeps, {
            issueId,
            ...(projectId === undefined ? {} : { projectId }),
          });
          return result;
        } catch (error) {
          return {
            ok: false,
            threadId: null,
            message: describeError(error),
            note: null,
          };
        }
      },

      async inbox({ markSeen }) {
        lastFrontendReadAt = now();
        const rows = store.inbox({ limit: 200 });
        const members = new Map(store.members().map((member) => [member.id, member]));
        // Workspace labels only when there is more than one to tell apart.
        const workspaces = store.workspaces();
        const workspaceNameFor =
          workspaces.length < 2
            ? () => null
            : (teamId: string | null): string | null => {
                if (teamId === null) return null;
                return store.workspaceForTeam(teamId)?.name ?? null;
              };

        const items = rows.map((row) =>
          selectInboxItem({
            row: {
              ...row,
              kind: row.kind as ReturnType<typeof classify>,
            },
            actor: row.actorId === null ? null : (members.get(row.actorId) ?? null),
            issue:
              row.issueId === null
                ? null
                : (() => {
                    const issue = store.issue(row.issueId);
                    return issue === null
                      ? null
                      : { identifier: issue.identifier, title: issue.title };
                  })(),
            blockers: [],
            now: now(),
            workspace: workspaceNameFor(row.teamId),
          }),
        );

        // Opening the segment marks visible rows seen. **Seen is not
        // handled**: a row stays until it is dismissed.
        if (markSeen === true) {
          store.markInboxSeen(
            rows.filter((row) => row.seenAt === null).map((row) => row.key),
            now(),
          );
          publish("linear:inbox");
        }

        return { items, unseen: store.unseenInboxCount() };
      },

      async dismissInbox({ keys, all }) {
        const target = all === true ? store.inbox({ limit: 500 }).map((row) => row.key) : keys;
        store.dismissInbox(target, now());
        publish("linear:inbox");
        publish("linear:data");
        return { ok: true, dismissed: target.length };
      },
    });

    const cliEnvironment: CliEnvironment = {
      status: statusReport,
      doctor: doctorChecks,
      budget: async () => {
        const values = await settings.get();
        return {
          snapshot: tightestBudget(),
          profile: readSyncProfile(values.syncProfile),
        };
      },
      teams: async () => {
        if (store.teams().length === 0) await discoverOnce();
        const all = store.workspaces();
        const names = all.length > 1 ? new Map(all.map((entry) => [entry.id, entry.name])) : null;
        return {
          teams: store.teams().map((entry) => ({
            ...entry,
            workspaceName:
              names === null || entry.workspaceId === null
                ? null
                : (names.get(entry.workspaceId) ?? null),
          })),
          bound: new Set(store.boundTeamIds()),
        };
      },
      bind: async ({ teamKey, projectId, role }) => {
        if (store.teams().length === 0) await discoverOnce();
        const team = store.teamByKey(teamKey);
        if (team === null) return { ok: false, message: `No team with key ${teamKey}.` };
        const resolved = projectId ?? (await defaultProjectId());
        if (resolved === null) {
          return {
            ok: false,
            message: "Name a project with --project <id>; this command has no thread to infer one from.",
          };
        }
        store.setBinding(resolved, team.id, role, now());
        refreshBindings();
        lifetime.detach("backfill", async () => {
          await backfillOnce(false);
        });
        publish("linear:data");
        return { ok: true, message: `Bound ${team.name} (${team.key}) as ${role}.` };
      },
      unbind: async ({ teamKey, projectId }) => {
        const team = store.teamByKey(teamKey);
        if (team === null) return { ok: false, message: `No team with key ${teamKey}.` };
        const resolved = projectId ?? (await defaultProjectId());
        if (resolved === null) {
          return { ok: false, message: "Name a project with --project <id>." };
        }
        store.removeBinding(resolved, team.id);
        refreshBindings();
        publish("linear:data");
        return { ok: true, message: `Unbound ${team.key}.` };
      },
      sync: async (full) => {
        // A backfill is up to six requests and cannot fit in the CLI's
        // two-second budget, so it is started rather than awaited. Returning
        // -1 is the runner's signal to say "started" rather than a count it
        // would have to invent.
        lifetime.detach("sync", async () => {
          await backfillOnce(full);
        });
        return -1;
      },

      issue: async ({ identifier, comments }) => {
        const result = await detailFor(identifier);
        if (result.kind === "missing") {
          return { ok: false, text: `No issue called ${result.identifier}.` };
        }
        if (result.kind === "refused") return { ok: false, text: result.message };
        if (result.kind === "loading") return { ok: false, text: "Still reading." };

        const issue = store.issue(result.detail.id);
        if (issue === null) return { ok: false, text: `No issue called ${identifier}.` };
        return {
          ok: true,
          text: issueDetailText(issue, toolContext(), {
            ...(comments ? { comments: store.comments(issue.id) } : {}),
            subIssues: result.detail.subIssues.map((child) => ({
              identifier: child.identifier,
              title: child.title,
              done: child.done,
            })),
          }),
        };
      },

      move: async ({ identifier, state, projectId }) => {
        const target = await resolveForWrite(identifier, projectId);
        if ("message" in target) return { ok: false, message: target.message };

        // Matched against the team's own states, by name **or** by type. A
        // workspace whose review column is called "Überprüfung" is served by
        // the type; a workspace with three started states is served by the
        // name. Neither is guessed.
        const states = store.workflowStates(target.issue.teamId);
        const needle = state.trim().toLowerCase();
        const match =
          states.find((entry) => entry.name.toLowerCase() === needle) ??
          states.filter((entry) => entry.type.toLowerCase() === needle)
            .sort((a, b) => a.position - b.position)[0];
        if (match === undefined) {
          return {
            ok: false,
            message: `${target.team.name} has no state called "${state}". Its states are: ${states
              .map((entry) => `${entry.name} (${entry.type})`)
              .join(", ")}.`,
          };
        }

        try {
          await updateIssue(
            mutations,
            target.issue.id,
            { stateId: match.id },
            `${target.issue.identifier} wasn't moved`,
          );
          return { ok: true, message: `${target.issue.identifier} → ${match.name}` };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      assign: async ({ identifier, who, projectId }) => {
        const target = await resolveForWrite(identifier, projectId);
        if ("message" in target) return { ok: false, message: target.message };

        let assigneeId: string | null = null;
        if (who !== "none") {
          const needle = who.replace(/^@/, "").toLowerCase();
          const member =
            who === "me"
              ? store.viewer()
              : (store.members().find(
                  (entry) =>
                    entry.displayName.toLowerCase() === needle ||
                    entry.name.toLowerCase() === needle,
                ) ?? null);
          if (member === null) return { ok: false, message: `No member called ${who}.` };
          assigneeId = member.id;
        }

        try {
          await updateIssue(
            mutations,
            target.issue.id,
            { assigneeId },
            `${target.issue.identifier} wasn't reassigned`,
          );
          const name =
            assigneeId === null
              ? "nobody"
              : (store.members().find((entry) => entry.id === assigneeId)?.displayName ?? who);
          return { ok: true, message: `${target.issue.identifier} assigned to ${name}.` };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      /**
       * Everything about an issue that is not its state or its assignee, which
       * already have verbs of their own.
       *
       * One command rather than six, because six commands that each set one
       * field is a CLI nobody remembers — and because a single patch is a
       * single request, which is the same thing the pane does.
       *
       * Names, not ids. Nobody has a project UUID to hand, and matching on the
       * team's own strings is what the pickers do too. An ambiguous name is
       * refused by listing the candidates rather than by guessing.
       */
      set: async (args) => {
        const target = await resolveForWrite(args.identifier, args.projectId);
        if ("message" in target) return { ok: false, message: target.message };
        const issue = target.issue;

        const patch: Record<string, unknown> = {};
        const changed: string[] = [];

        if (args.priority !== undefined) {
          const value = Number.parseInt(args.priority, 10);
          if (!Number.isFinite(value) || value < 0 || value > 4) {
            return {
              ok: false,
              message: `--priority takes 0 to 4. ${store
                .priorityValues()
                .map((entry) => `${String(entry.priority)} ${entry.label}`)
                .join(", ")}.`,
            };
          }
          patch["priority"] = value;
          changed.push("priority");
        }

        if (args.estimate !== undefined) {
          if (args.estimate === "none") {
            patch["estimate"] = null;
          } else {
            const value = Number.parseFloat(args.estimate);
            if (!Number.isFinite(value)) {
              return { ok: false, message: "--estimate takes a number, or none." };
            }
            patch["estimate"] = value;
          }
          changed.push("estimate");
        }

        if (args.due !== undefined) {
          if (args.due === "none") {
            patch["dueDate"] = null;
          } else if (!/^\d{4}-\d{2}-\d{2}$/.test(args.due)) {
            // A calendar date, never parsed into an instant: converting picks
            // a timezone on the user's behalf and is wrong by a day for half
            // the planet.
            return { ok: false, message: "--due takes YYYY-MM-DD, or none." };
          } else {
            patch["dueDate"] = args.due;
          }
          changed.push("due date");
        }

        if (args.title !== undefined) {
          if (args.title.trim() === "") return { ok: false, message: "--title needs some text." };
          patch["title"] = args.title.trim();
          changed.push("title");
        }

        if (args.project !== undefined) {
          if (args.project === "none") {
            patch["projectId"] = null;
          } else {
            const matches = store
              .projects([issue.teamId])
              .filter((entry) => entry.name.toLowerCase().includes(args.project!.toLowerCase()));
            const exact = matches.find(
              (entry) => entry.name.toLowerCase() === args.project!.toLowerCase(),
            );
            const chosen = exact ?? (matches.length === 1 ? matches[0] : undefined);
            if (chosen === undefined) {
              return {
                ok: false,
                message:
                  matches.length === 0
                    ? `No project matching "${args.project}" on ${target.team.name}.`
                    : `"${args.project}" matches ${String(matches.length)}: ${matches
                        .map((entry) => entry.name)
                        .join(", ")}.`,
              };
            }
            patch["projectId"] = chosen.id;
          }
          changed.push("project");
        }

        if (args.cycle !== undefined) {
          if (args.cycle === "none") {
            patch["cycleId"] = null;
          } else {
            const cycles = store.cycles(issue.teamId);
            const needle = args.cycle.toLowerCase();
            const chosen = cycles.find(
              (entry) =>
                (entry.name ?? "").toLowerCase() === needle ||
                String(entry.number) === needle ||
                `cycle ${String(entry.number)}` === needle,
            );
            if (chosen === undefined) {
              return {
                ok: false,
                message:
                  cycles.length === 0
                    ? `${target.team.name} does not use cycles.`
                    : `No cycle matching "${args.cycle}".`,
              };
            }
            patch["cycleId"] = chosen.id;
          }
          changed.push("cycle");
        }

        for (const [flag, key] of [
          [args.addLabel, "addLabelIds"],
          [args.removeLabel, "removeLabelIds"],
        ] as const) {
          if (flag === undefined) continue;
          const label = store
            .labels([issue.teamId])
            .find((entry) => entry.name.toLowerCase() === flag.toLowerCase());
          if (label === undefined) {
            return { ok: false, message: `No label called "${flag}" on ${target.team.name}.` };
          }
          patch[key] = [label.id];
          changed.push("labels");
        }

        if (changed.length === 0) {
          return {
            ok: false,
            message:
              "Nothing to change. Try --priority, --estimate, --due, --project, --cycle, --title, --label or --unlabel.",
          };
        }

        try {
          await updateIssue(mutations, issue.id, patch, `${issue.identifier} wasn't changed`);
          return {
            ok: true,
            message: `${issue.identifier}: changed ${joinSentence([...new Set(changed)])}.`,
          };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      comment: async ({ identifier, body, projectId }) => {
        const target = await resolveForWrite(identifier, projectId);
        if ("message" in target) return { ok: false, message: target.message };
        try {
          await postComment(mutations, {
            issueId: target.issue.id,
            body,
            clientId: clientId(),
          });
          return { ok: true, message: `Commented on ${target.issue.identifier}.` };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      create: async ({ title, description, team, assignee, priority, projectId: project }) => {
        const current = scopeFor(
          project ?? (await defaultProjectId()) ?? "",
          store.bindings(),
        );
        if (current.writeTeamIds.length === 0) {
          return {
            ok: false,
            message:
              "No bb project here is bound to a Linear team with write access. Run: bb linear bind <TEAM-KEY> --project <id>",
          };
        }

        const target =
          team === undefined
            ? (current.primaryTeamId === null ? null : store.team(current.primaryTeamId))
            : store.teamByKey(team);
        if (target === null || !current.writeTeamIds.includes(target.id)) {
          return {
            ok: false,
            message:
              team === undefined
                ? "This project has no primary Linear team."
                : `This project cannot write to team ${team}.`,
          };
        }

        const viewer = store.viewer();
        try {
          const issue = await createIssue(mutations, clientForTeam, {
            teamId: target.id,
            title,
            ...(description === undefined ? {} : { description }),
            ...(assignee === "me" && viewer !== null ? { assigneeId: viewer.id } : {}),
            ...(priority === undefined ? {} : { priority }),
            clientId: clientId(),
          });
          return {
            ok: true,
            message: `Created ${issue.identifier} — ${issue.title}${
              issue.url === null ? "" : `\n${issue.url}`
            }`,
          };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      /**
       * The bound teams' issues, filtered, from the local copy.
       *
       * Reads the mirror rather than Linear: the whole point of holding one is
       * that a list is instant and free. `--state` matches a state's **type**
       * or its name, because a workspace's review column can be called
       * anything in any language and the type is what carries the meaning.
       */
      issues: async ({ state, assignee, team, limit, projectId }) => {
        const current = scopeFor(
          projectId ?? (await defaultProjectId()) ?? "",
          store.bindings(),
        );
        if (current.readTeamIds.length === 0) {
          return {
            ok: false,
            rows: [],
            message:
              "No bb project is bound to a Linear team. Run: bb linear bind <TEAM-KEY> --project <id>",
          };
        }

        let teamIds = current.readTeamIds;
        if (team !== undefined) {
          const named = store.teamByKey(team);
          if (named === null || !current.readTeamIds.includes(named.id)) {
            return {
              ok: false,
              rows: [],
              message: `This project cannot read team ${team}.`,
            };
          }
          teamIds = [named.id];
        }

        const viewer = store.viewer();
        const needle = state?.trim().toLowerCase();
        const stateIds =
          needle === undefined
            ? undefined
            : teamIds
                .flatMap((id) => store.workflowStates(id))
                .filter(
                  (entry) =>
                    entry.type.toLowerCase() === needle || entry.name.toLowerCase() === needle,
                )
                .map((entry) => entry.id);

        if (stateIds !== undefined && stateIds.length === 0) {
          return {
            ok: false,
            rows: [],
            message: `No state called "${state ?? ""}" in those teams. Try a type: triage, backlog, unstarted, started, completed, canceled.`,
          };
        }

        const rows = store.queryIssues({
          teamIds,
          ...(stateIds === undefined ? {} : { stateIds }),
          ...(assignee === "me" && viewer !== null ? { assigneeIds: [viewer.id] } : {}),
          includeCompleted: true,
          sort: "updated",
          limit,
        });

        const filtered =
          assignee === "none" ? rows.filter((row) => row.assigneeId === null) : rows;

        const members = new Map(store.members().map((entry) => [entry.id, entry]));
        return {
          ok: true,
          message: filtered.length === 0 ? "Nothing matches that." : null,
          rows: filtered.map((row) => [
            row.identifier,
            row.stateId === null ? "" : (store.workflowState(row.stateId)?.name ?? ""),
            row.title,
            row.assigneeId === null ? "" : (members.get(row.assigneeId)?.displayName ?? ""),
          ]),
        };
      },

      attach: async ({ identifier, url, title, projectId }) => {
        const target = await resolveForWrite(identifier, projectId);
        if ("message" in target) return { ok: false, message: target.message };
        try {
          const result = await attachUrl(mutations, {
            issueId: target.issue.id,
            url,
            title: title ?? null,
          });
          return {
            ok: true,
            message: result.alreadyThere
              ? `That link is already on ${target.issue.identifier}.`
              : `Attached to ${target.issue.identifier}.`,
          };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      /**
       * Archive — `issueArchive`, reversible in Linear's own UI — and never
       * `issueDelete`.
       *
       * The confirmation is a required flag rather than a prompt: a plugin
       * command has no tty it can trust, and this is the same shape `forget`
       * already uses for the same reason.
       */
      archive: async ({ identifier, confirmed, projectId }) => {
        const target = await resolveForWrite(identifier, projectId);
        if ("message" in target) return { ok: false, message: target.message };
        if (!confirmed) {
          return {
            ok: false,
            message: `This archives ${target.issue.identifier} — ${target.issue.title} — in Linear. It is reversible in Linear's own UI. Run it again with --yes.`,
          };
        }
        try {
          await archiveIssue(mutations, target.issue.id);
          return { ok: true, message: `Archived ${target.issue.identifier}.` };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },

      /**
       * Re-read the workspace itself, not the issues in it.
       *
       * The command that was missing: replacing the API key points the plugin
       * at a different workspace, and until something re-runs discovery the
       * team list on screen is the *old* workspace's. Discovery does run on
       * its own — but only when a surface asks for it, which is a poor thing
       * to have to guess at from a terminal.
       *
       * Forces the verify too, so a key that was replaced seconds ago is not
       * answered from the connection cache.
       */
      refresh: async () => {
        const state = await connectionState(true);
        if (state.kind !== "connected") {
          return {
            ok: false,
            text: `Not connected — nothing to refresh. Run: bb linear doctor\n`,
          };
        }

        await discoverOnce();
        const teams = store.teams();
        const bound = store.boundTeamIds();

        // The bound teams' own vocabulary — states, labels, people — is what
        // every write path validates against, so a refresh that skipped it
        // would leave the picker showing the previous workspace's columns.
        const expanded = expandTeams(bound, teams, (await settings.get()).includeSubTeams);
        for (const [slot, group] of teamsBySlot(expanded)) {
          await refreshTeamVocabulary(backfillDepsFor(slot), group);
        }

        publish("linear:data");
        const names = store.workspaces().map((workspace) => workspace.name);
        return {
          ok: true,
          text: `${names.length === 0 ? state.workspace.name : names.join(", ")} · ${String(
            teams.length,
          )} ${teams.length === 1 ? "team" : "teams"} visible${
            bound.length === 0 ? "" : `, ${String(bound.length)} bound`
          }.\n`,
        };
      },

      forget: async ({ confirmed }) => {
        if (!confirmed) {
          return {
            ok: false,
            text: [
              "This deletes the local copy of your Linear workspace from this machine —",
              "issues, descriptions, comments and member details — and every cursor with it.",
              "",
              "It does NOT remove the API key, and it does not revoke it at Linear.",
              "",
              "Run it again with --yes if that is what you want.",
              "",
            ].join("\n"),
          };
        }
        store.forgetEverything();
        await kv.clearAll();
        webhookIds.clear();
        bindingSnapshot = [];
        cached = null;
        return { ok: true, text: "Local copy removed. The API key is untouched.\n" };
      },

      webhook: async ({ action, target: target_ }) => {
        const values = await settings.get();
        const url = values.webhookUrl.trim();

        if (action === "status" || action === undefined) {
          if (url === "") {
            return {
              ok: true,
              text: [
                "Not configured — the plugin polls, which always works.",
                "",
                "  Webhooks are an escalation for someone who already runs a public HTTPS",
                "  endpoint. Creating one also needs a Linear workspace admin, and a bb",
                "  connect share link will not work: it is session-gated, so Linear's",
                "  delivery bot gets the sign-in page.",
                "",
              ].join("\n"),
            };
          }
          return {
            ok: true,
            text:
              webhookIds.size === 0
                ? `A URL is set (${url}) but no webhook is registered yet. Run: bb linear webhook enable ${url}\n`
                : `${webhookIds.size} webhook(s) registered, one per bound team. Delivering to ${url}.\n`,
          };
        }

        if (action === "disable") {
          // Deletion happens only on explicit user action — this is one of the
          // three places that qualifies.
          for (const key of await kv.keys("webhook:")) await kv.remove(key);
          webhookIds.clear();
          store.putLocalSecret(WEBHOOK_SECRET_KEY, "");
          return { ok: true, text: "Webhook records removed. The plugin polls.\n" };
        }

        if (action === "enable") {
          // The URL may be given on the command line or left in settings. The
          // command line wins, because someone typing a URL means that URL.
          const target = target_ !== undefined && target_ !== "" ? target_ : url;
          return await enableWebhooks(target);
        }

        return {
          ok: false,
          text: "Usage: bb linear webhook status | enable <https-url> | disable\n",
        };
      },

      inbox: async ({ all, dismiss }) => {
        if (dismiss !== null || all) {
          const rows = store.inbox({ limit: 500 });
          const keys = dismiss === null || dismiss === "--all" ? rows.map((row) => row.key) : [dismiss];
          store.dismissInbox(keys, now());
          publish("linear:inbox");
          return { ok: true, text: `Dismissed ${keys.length}.` };
        }

        const rows = store.inbox({ limit: 50 });
        if (rows.length === 0) return { ok: true, text: "Nothing is waiting for you in Linear." };

        const members = new Map(store.members().map((entry) => [entry.id, entry]));
        const lines = rows.map((row) => {
          const view = selectInboxItem({
            row: { ...row, kind: row.kind as ReturnType<typeof classify> },
            actor: row.actorId === null ? null : (members.get(row.actorId) ?? null),
            issue:
              row.issueId === null
                ? null
                : (() => {
                    const issue = store.issue(row.issueId);
                    return issue === null
                      ? null
                      : { identifier: issue.identifier, title: issue.title };
                  })(),
            blockers: [],
            now: now(),
          });
          return [view.unseen ? "●" : " ", view.age, view.text];
        });
        return {
          ok: true,
          text: `${store.unseenInboxCount()} unseen\n${table(lines, "  ")}`,
        };
      },

      start: async ({ identifier, projectId, move }) => {
        const result = await startThreadFromIssue(
          // `--no-move` is a per-invocation override of the setting, which is
          // what makes "start a thread without touching the board" a thing
          // somebody can do once without changing their configuration.
          move ? startDeps : { ...startDeps, movesStatus: () => false },
          { issueId: identifier, ...(projectId === undefined ? {} : { projectId }) },
        );
        return {
          ok: result.ok,
          message: result.note === null ? result.message : `${result.message} ${result.note}`,
        };
      },

      link: async ({ identifier, threadId }) => {
        if (threadId === undefined) {
          // `run` executes on the server, so there is no ambient "current
          // thread" — the invoking CLI supplies one when it knows one.
          return {
            ok: false,
            message: "No thread to link. Run this from a thread, or pass --thread <id>.",
          };
        }
        if (identifier === null) {
          const result = bindManually(threadId, null, null);
          return { ok: result.ok, message: result.message ?? "Unlinked." };
        }
        let issue = store.issue(identifier) ?? store.issueByIdentifier(identifier);
        if (issue === null) {
          issue = await lifetime.runAsync("issue", () => refreshIssue(identifier), null);
        }
        if (issue === null) return { ok: false, message: `No issue called ${identifier}.` };
        const thread = await lifetime.runAsync(
          "thread",
          () => bb.sdk.threads.get({ threadId }),
          null,
        );
        const result = bindManually(threadId, issue.id, thread?.projectId ?? null);
        return {
          ok: result.ok,
          message: result.message ?? `Linked this thread to ${issue.identifier}.`,
        };
      },

      now,
    };

    function toolContext() {
      return {
        states: new Map(
          store
            .teams()
            .flatMap((team) => store.workflowStates(team.id))
            .map((state) => [state.id, state] as const),
        ),
        members: new Map(store.members().map((member) => [member.id, member] as const)),
        labels: new Map(store.labels([]).map((label) => [label.id, label] as const)),
        priorityLabels: new Map(
          store.priorityValues().map((value) => [value.priority, value.label] as const),
        ),
        teams: new Map(store.teams().map((team) => [team.id, team] as const)),
      };
    }

    /**
     * Resolve an issue for a write, and check the project's write set.
     *
     * With exactly one bound project the flag is optional, because there is
     * nothing to disambiguate. With more than one it is required rather than
     * guessed: a write sent to the wrong project's scope either succeeds when
     * it should have been refused, or is refused for a reason the user cannot
     * see.
     */
    async function resolveForWrite(
      identifier: string,
      projectId: string | undefined,
    ): Promise<{ issue: NonNullable<ReturnType<Store["issue"]>>; team: { name: string } } | { message: string }> {
      let issue = store.issue(identifier) ?? store.issueByIdentifier(identifier);
      if (issue === null) {
        issue = await lifetime.runAsync("issue", () => refreshIssue(identifier), null);
      }
      if (issue === null) return { message: `No issue called ${identifier}.` };

      const boundProjects = [...new Set(bindingSnapshot.map((row) => row.projectId))];
      const resolved = projectId ?? (boundProjects.length === 1 ? boundProjects[0] : undefined);
      if (resolved === undefined) {
        return {
          message:
            boundProjects.length === 0
              ? "No bb project is bound to a Linear team. Bind one first: bb linear bind <TEAM-KEY> --project <id>"
              : "More than one project is bound, so name one with --project <id>.",
        };
      }

      const scope = scopeFor(resolved, bindingSnapshot);
      const team = store.team(issue.teamId);
      if (!scope.writeTeamIds.includes(issue.teamId)) {
        const allowed = scope.writeTeamIds
          .map((id) => store.team(id))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        return {
          message: crossTeamRefusal({
            identifier: issue.identifier,
            targetTeam: { name: team?.name ?? "another team", key: team?.key ?? "?" },
            allowed: allowed.map((entry) => ({ name: entry.name, key: entry.key })),
            action: "write",
          }),
        };
      }

      return { issue, team: { name: team?.name ?? "that team" } };
    }

    /**
     * With exactly one project there is nothing to disambiguate, so the flag
     * is optional. With more than one it is required rather than guessed: a
     * binding written to the wrong project is silent, and the symptom appears
     * later as tools missing from a thread.
     */
    async function defaultProjectId(): Promise<string | null> {
      const projects = await projectSummaries();
      return projects.length === 1 ? (projects[0]?.id ?? null) : null;
    }

    /*
     * Agent surfaces. Registered unconditionally; `configure` is what decides
     * per thread whether any of them are offered, and an unbound project gets
     * none of them plus one sentence saying why.
     */
    registerMentionProviders(bb, { store, bindings: () => bindingSnapshot });

    registerTools(bb, {
      store,
      bindings: () => bindingSnapshot,
      agentWrites: () => readAgentWrites(initialSettings.agentWrites),
      mutations,
      refreshIssue,
      // `skills/linear/SKILL.md`'s frontmatter name. An **unknown** name
      // rejects this plugin's entire selection for the resolution, so this is
      // the one place it is written and it has to match the file.
      skills: () => ["linear"],
      clientForTeam,

      /**
       * Linear's own search, when the mirror cannot answer.
       *
       * Returns null rather than throwing: the caller has a perfectly good
       * local answer to fall back on, and turning a rate limit into a tool
       * error would tell the agent the search failed rather than that this
       * one escalation did.
       */
      searchRemote: async (query, teamIds, signal) => {
        try {
          // Grouped by workspace for the same reason every other read is: the
          // filter only resolves for the key that issued it.
          const found: IssueRow[] = [];
          for (const [slot, group] of teamsBySlot(teamIds)) {
            const result = await clientForSlot(slot).searchIssues(query, group, {
              initiator: "user",
              ...(signal ? { signal } : {}),
            });
            const rows = result.searchIssues.nodes.map(toIssueInput);
            store.putIssues(rows, now());
            for (const row of rows) {
              const stored = store.issue(row.id);
              if (stored !== null) found.push(stored);
            }
          }
          publish("linear:data");
          return found;
        } catch (error) {
          lifetime.log("debug", `Remote search failed: ${describeError(error)}`);
          return null;
        }
      },

      runView: async (viewId, signal) => {
        try {
          // The view runs at Linear. `filterData` is a JSONObject in Linear's
          // internal dialect and reimplementing it is not an option.
          const result = await client.customViewIssues(viewId, null, {
            initiator: "user",
            ...(signal ? { signal } : {}),
          });
          const rows = (result.customView.issues.nodes as IssueNode[]).map(toIssueInput);
          store.putIssues(rows, now());
          publish("linear:data");
          const issues = rows
            .map((row) => store.issue(row.id))
            .filter((row): row is IssueRow => row !== null);
          return { name: result.customView.name, issues };
        } catch (error) {
          lifetime.log("debug", `Saved view ${viewId} could not be read: ${describeError(error)}`);
          return null;
        }
      },

      startThread: async ({ issueId, projectId }) => {
        const result = await startThreadFromIssue(startDeps, { issueId, projectId });
        return { ok: result.ok, message: result.message, note: result.note };
      },

      /**
       * The thread's own binding, as the same sentence every turn's
       * instructions carry — one text, two delivery paths, so the tool and
       * the ambient context can never disagree.
       */
      threadIssue: (threadId) => {
        const cached = instructionCache.get(threadId);
        if (cached !== undefined) return cached;
        const suggestion = suggestions.get(threadId);
        if (suggestion !== undefined) {
          return `This thread is not bound to a Linear issue. Best guess by title: ${suggestion.identifier} — "${suggestion.title}". Bind it with linear_thread_bind if that is right.`;
        }
        return "This thread is not bound to a Linear issue. Bind one with linear_thread_bind, or work by identifier with the other linear_* tools.";
      },

      bindThread: async (threadId, idOrIdentifier) => {
        const thread = await lifetime.runAsync(
          "thread",
          () => bb.sdk.threads.get({ threadId }),
          null,
        );
        return bindManually(threadId, idOrIdentifier, thread?.projectId ?? null);
      },

      now,
    });

    bb.cli.register({
      name: "linear",
      summary: "Linear issues, and the bb threads and pull requests attached to them",
      commands: [...CLI_COMMANDS],
      run: createCliRunner(cliEnvironment),
    });

    /* ── Webhook reconciliation on load ──────────────────────────────────── */
    /*
     * Ids persist in kv and the plugin reconciles **on load** rather than
     * re-creating: reuse what matches, and recreate only what is missing or
     * misconfigured. Nothing is deleted here.
     *
     * This runs offline-safe: it reads kv and nothing else. The actual
     * `webhook(id)` health check belongs to the service loop, where a failing
     * network cannot turn a plugin reload into a failed activation.
     */
    for (const key of await kv.keys("webhook:")) {
      const record = await kv.readOptional(key, webhookRecordSchema);
      if (record !== undefined) webhookIds.set(key.slice("webhook:".length), record.id);
    }

    /* ── Status on load ──────────────────────────────────────────────────── */

    // `configure` is synchronous, so the values it reads have to be here
    // already. `onChange` keeps them current without a reload.
    let initialSettings = await settings.get();
    settings.onChange((next) => {
      initialSettings = next;
    });

    const initial = initialSettings;
    if (initial.apiKey === undefined || initial.apiKey.trim() === "") {
      bb.status.needsConfiguration(NEEDS_CONFIGURATION_MESSAGE);
    }

    /* ── Dispose ─────────────────────────────────────────────────────────── */
    /*
     * Registered LAST so it runs FIRST: dispose hooks run LIFO, and every
     * other piece of this plugin checks `lifetime.disposed` before touching a
     * host handle. Setting the flag before anything else runs is what turns a
     * detached continuation from a server-wide `uncaughtException` into a
     * no-op.
     *
     * Nothing user-visible or remote is destroyed here. `onDispose` takes no
     * reason and cannot tell an uninstall from a reload, a disable, an update
     * or a shutdown — so deleting a Linear webhook here would destroy it on
     * every bb restart, and re-creating one needs workspace-admin rights most
     * users do not have.
     */
    bb.onDispose(() => {
      lifetime.dispose();
      for (const state of publishers.values()) {
        if (state.timer !== null) clearTimeout(state.timer);
      }
      publishers.clear();
      forgetSecrets();
    });
  };
}

export default createPlugin();
