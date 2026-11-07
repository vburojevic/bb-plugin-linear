import { describe, expect, it } from "vitest";
import {
  GITHUB_PR_STATUS_PLUGIN_ID,
  lookupPullRequest,
  pullRequestsOutputSchema,
  type GithubPrStatusRpc,
} from "../src/automations/pull-request-lookup.js";

/** A row as bb's GitHub PR Status plugin actually returns it, extra fields and all. */
const MERGED_ROW = {
  outcome: "available",
  pullRequest: {
    number: 2,
    title: "Fix the thing",
    state: "merged",
    url: "https://github.com/acme/app/pull/2",
    baseRefName: "main",
    headRefName: "eng-7-fix-the-thing",
    updatedAt: "2026-11-06T23:28:05Z",
    autoMerge: false,
    inMergeQueue: false,
    checks: { state: "no_checks", totalCount: 0, passedCount: 0, failedCount: 0, pendingCount: 0 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "unknown", mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" },
    attention: "merged",
  },
};

type PeerCall = Parameters<GithubPrStatusRpc>[0];

/** Behaves like `bb.sdk.plugins.callRpc`: the output schema parses the peer's answer. */
function peer(
  answer: () => unknown,
  refresh: () => unknown = () => ({ ok: true }),
): { rpc: GithubPrStatusRpc; calls: PeerCall[] } {
  const calls: PeerCall[] = [];
  const rpc = (async (args: PeerCall) => {
    calls.push(args);
    return args.outputSchema.parse(args.method === "refresh" ? refresh() : answer());
  }) as GithubPrStatusRpc;
  return { calls, rpc };
}

describe("lookupPullRequest", () => {
  it("asks GitHub PR Status for exactly this environment and passes the row through", async () => {
    const { rpc, calls } = peer(() => ({ env_1: MERGED_ROW }));

    const result = await lookupPullRequest(rpc, "env_1");

    expect(calls).toEqual([
      {
        pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
        method: "pullRequests",
        input: { keys: ["env_1"] },
        outputSchema: pullRequestsOutputSchema,
      },
    ]);
    expect(result).toEqual({
      outcome: "available",
      pullRequest: {
        number: 2,
        title: "Fix the thing",
        state: "merged",
        url: "https://github.com/acme/app/pull/2",
        baseRefName: "main",
        attention: "merged",
      },
    });
  });

  it("keeps absent and unavailable distinct", async () => {
    const absent = peer(() => ({ env_1: { outcome: "absent" } }));
    const unavailable = peer(() => ({ env_1: { outcome: "unavailable", message: "gh is not authenticated" } }));

    expect(await lookupPullRequest(absent.rpc, "env_1")).toEqual({ outcome: "absent" });
    expect(await lookupPullRequest(unavailable.rpc, "env_1")).toEqual({
      outcome: "unavailable",
      message: "gh is not authenticated",
    });
  });

  it("reads a missing row as unavailable, never as absent", async () => {
    const { rpc } = peer(() => ({}));

    expect((await lookupPullRequest(rpc, "env_1")).outcome).toBe("unavailable");
  });

  it("reads a disabled peer or a changed shape as unavailable instead of throwing", async () => {
    const disabled = peer(() => {
      throw new Error("Plugin bb--github-pr-status is disabled");
    });
    const reshaped = peer(() => ({ env_1: { outcome: "available", pullRequest: { number: "two" } } }));

    const fromDisabled = await lookupPullRequest(disabled.rpc, "env_1");
    expect(fromDisabled.outcome).toBe("unavailable");
    expect(fromDisabled.outcome === "unavailable" && fromDisabled.message).toContain("is disabled");
    expect((await lookupPullRequest(reshaped.rpc, "env_1")).outcome).toBe("unavailable");
  });

  it("re-checks GitHub before reading only when asked for a fresh answer", async () => {
    const cached = peer(() => ({ env_1: MERGED_ROW }));
    await lookupPullRequest(cached.rpc, "env_1");
    expect(cached.calls.map((call) => call.method)).toEqual(["pullRequests"]);

    const fresh = peer(() => ({ env_1: MERGED_ROW }));
    const result = await lookupPullRequest(fresh.rpc, "env_1", { fresh: true });
    expect(fresh.calls.map((call) => [call.method, call.input])).toEqual([
      ["refresh", { environmentId: "env_1" }],
      ["pullRequests", { keys: ["env_1"] }],
    ]);
    expect(result.outcome).toBe("available");
  });

  it("still answers from the saved row when the re-check fails", async () => {
    const { rpc, calls } = peer(
      () => ({ env_1: MERGED_ROW }),
      () => {
        throw new Error("Unknown RPC method refresh");
      },
    );

    const result = await lookupPullRequest(rpc, "env_1", { fresh: true });

    expect(calls.map((call) => call.method)).toEqual(["refresh", "pullRequests"]);
    expect(result.outcome).toBe("available");
  });
});
