import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import type { LinearClient } from "../src/linear/client.js";
import { createStore } from "../src/store/store.js";
import { issue, NOW, state, team } from "./helpers/store.js";

/*
 * The write-back end to end through the real server wiring: a thread event,
 * bb's GitHub PR Status plugin answering through `bb.sdk.plugins.callRpc`,
 * and the Linear write. The runner's own tests inject the lookup, which is
 * exactly how a removed SDK method once went unnoticed, so this one fakes only
 * the edges: the peer plugin's RPCs and the Linear client. Nothing reaches the
 * network; `test/setup.ts` would fail the test if it did.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface PeerCall {
  readonly pluginId: string;
  readonly method: string;
  readonly input: unknown;
}

function pullRequest(state: "open" | "merged") {
  return {
    outcome: "available",
    pullRequest: {
      number: 7,
      title: "Fix the thing",
      state,
      url: "https://github.com/acme/app/pull/7",
      baseRefName: "main",
      headRefName: "eng-1-fix-the-thing",
      attention: state === "merged" ? "merged" : "review_requested",
      checks: { state: "passed", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 },
    },
  };
}

async function fixture(options: { refreshFails?: boolean } = {}) {
  const peerCalls: PeerCall[] = [];
  const updates: { issueId: string; input: Record<string, unknown> }[] = [];
  /** What GitHub says, and what the peer's saved row says until a refresh copies it over. */
  const github = { state: "open" as "open" | "merged" };
  let saved: "open" | "merged" = "open";

  // Every Linear call the write-back is not about fails loudly, so a test
  // that passes cannot have leaned on one by accident.
  const client = new Proxy({} as LinearClient, {
    get: (_target, name) => {
      if (name === "then") return undefined;
      if (name === "branchSearch") return async () => ({ issueVcsBranchSearch: null });
      if (name === "updateIssue") {
        return async (issueId: string, input: Record<string, unknown>) => {
          updates.push({ issueId, input });
          return { issueUpdate: { success: true, issue: null } };
        };
      }
      return async () => {
        throw new Error(`Linear client method ${String(name)} is not faked`);
      };
    },
  });

  const thread = makeThreadResponse({ id: "t", projectId: "p", environmentId: "env_1" });
  const { bb, harness } = createFakePluginHost({
    pluginId: "linear",
    settings: { apiKey: "lin_api_test", allowWrites: true, prTransitions: true },
    sdk: {
      threads: { get: async () => thread, timeline: async () => ({ rows: [] }) as never },
      environments: { get: async () => ({ id: "env_1", branchName: "eng-1-fix-the-thing" }) as never },
      projects: { list: async () => ({ projects: [] }) as never },
      plugins: {
        callRpc: (async (args: { pluginId: string; method: string; input: unknown; outputSchema: { parse(value: unknown): unknown } }) => {
          peerCalls.push({ pluginId: args.pluginId, method: args.method, input: args.input });
          if (args.method === "refresh") {
            if (options.refreshFails === true) throw new Error("Unknown RPC method refresh");
            saved = github.state;
            return args.outputSchema.parse({ ok: true });
          }
          return args.outputSchema.parse({ env_1: pullRequest(saved) });
        }) as never,
      },
    },
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await createPlugin(() => client)(bb as never);

  const store = createStore(bb.storage.database() as never);
  store.putTeams([team("team_eng", "ENG")], NOW);
  store.replaceWorkflowStates("team_eng", [
    state("todo", "team_eng", "unstarted"),
    state("doing", "team_eng", "started"),
    state("done", "team_eng", "completed"),
  ]);
  store.putIssues([issue({ id: "a", identifier: "ENG-1", stateId: "doing" })], NOW);
  expect((await harness.behavior.runCli(["bind", "ENG", "--project", "p"])).exitCode).toBe(0);

  return {
    harness,
    store,
    peerCalls,
    updates,
    /** GitHub merges the pull request; the peer's saved row still says open. */
    merge: () => {
      github.state = "merged";
    },
  };
}

/** Thread handlers are detached; wait until the transition has written `pr_state`. */
async function settled(store: ReturnType<typeof createStore>, prState: string) {
  await expect.poll(() => store.prState("env_1")?.prState, { timeout: 5_000 }).toBe(prState);
}

describe("pull-request write-back through the server", () => {
  it("re-checks GitHub when a turn ends, so a merge in that turn moves the issue to Done", async () => {
    const { harness, store, peerCalls, updates, merge } = await fixture();

    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "t", projectId: "p", environmentId: "env_1" }) });
    await settled(store, "open");
    // Turn start reads the saved row: no extra GitHub round trip.
    expect(peerCalls.map((call) => call.method)).toEqual(["pullRequests"]);
    expect(updates).toEqual([]);

    merge();
    peerCalls.length = 0;
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "t", projectId: "p", environmentId: "env_1" }),
      lastAssistantText: null,
    });
    await settled(store, "merged");

    expect(peerCalls).toEqual([
      { pluginId: "bb--github-pr-status", method: "refresh", input: { environmentId: "env_1" } },
      { pluginId: "bb--github-pr-status", method: "pullRequests", input: { keys: ["env_1"] } },
    ]);
    expect(updates).toEqual([{ issueId: "a", input: { stateId: "done" } }]);
  });

  it("still reads the saved row when the re-check fails", async () => {
    const { harness, store, peerCalls, updates, merge } = await fixture({ refreshFails: true });
    merge();
    // The re-check throws (an older GitHub PR Status without `refresh`, say).
    // The read still answers from the saved row, which says open, so the
    // issue does not move and the lookup is not mistaken for a failure.
    const thread = makeThreadResponse({ id: "t", projectId: "p", environmentId: "env_1" });
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await settled(store, "open");
    expect(peerCalls.map((call) => call.method)).toEqual(["refresh", "pullRequests"]);
    expect(updates).toEqual([]);
  });
});
