import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import type { LinearClient } from "../src/linear/client.js";
import { createStore } from "../src/store/store.js";
import { issue, NOW, state, team } from "./helpers/store.js";

/*
 * The Working set through the real server: which issues get bb facts is
 * decided in server.ts, not in buildWorkingSet, so a panel test that passes
 * facts in directly cannot see an issue the server never computed one for.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Every Linear request fails loudly: the Working set reads the mirror only.
 *  The two synchronous health readers answer "healthy, no budget yet". */
const offline = new Proxy({} as LinearClient, {
  get: (_target, name) => {
    if (name === "then") return undefined;
    if (name === "breaker") return () => ({ open: false, lastError: null });
    if (name === "budget") return () => null;
    return async () => {
      throw new Error(`Linear client method ${String(name)} is not faked`);
    };
  },
});

describe("Working set through the server", () => {
  it("files a running thread's old, low-priority issue under Running on a busy team", async () => {
    const thread = makeThreadResponse({ id: "t_run", projectId: "p", environmentId: null });
    const { bb, harness } = createFakePluginHost({
      pluginId: "linear",
      settings: { apiKey: "lin_api_test" },
      sdk: {
        threads: { get: async () => thread, timeline: async () => ({ rows: [] }) as never },
        projects: { list: async () => ({ projects: [] }) as never },
      },
    });
    cleanups.push(() => harness.lifecycle.dispose());
    await createPlugin(() => offline)(bb as never);

    const store = createStore(bb.storage.database() as never);
    store.putTeams([team("team_eng", "ENG")], NOW);
    store.replaceWorkflowStates("team_eng", [state("todo", "team_eng", "unstarted")]);
    // More recent, higher-priority issues than both the 300-row Working set
    // cut and the 500 most recently updated issues.
    store.putIssues(
      [
        ...Array.from({ length: 600 }, (_, index) =>
          issue({ id: `o${index}`, identifier: `ENG-${index + 10}`, stateId: "todo", priority: 1, updatedAt: NOW }),
        ),
        issue({ id: "run", identifier: "ENG-1", stateId: "todo", priority: 0, updatedAt: NOW - 90 * 86_400_000 }),
      ],
      NOW,
    );
    expect((await harness.behavior.runCli(["bind", "ENG", "--project", "p"])).exitCode).toBe(0);
    await bb.storage.kv.set("backfilled:team_eng", { v: 1, at: NOW, issues: 601 });
    store.linkThread({ threadId: "t_run", issueId: "run", teamId: "team_eng", projectId: "p", createdAt: NOW, origin: "manual" });

    await harness.behavior.emitThreadEvent("thread.active", { thread });
    const { view } = (await harness.behavior.callRpc("workingSet", { team: null })) as {
      view: { kind: string; buckets?: { id: string; rows: { id: string }[] }[] };
    };

    expect(view.kind).toBe("buckets");
    expect(view.buckets?.find((bucket) => bucket.id === "running")?.rows.map((row) => row.id)).toEqual(["run"]);
  });
});
