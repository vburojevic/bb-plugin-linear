import { describe, expect, it } from "vitest";
import {
  GITHUB_PR_STATUS_PLUGIN_ID,
  lookupPullRequest,
  pullRequestsOutputSchema,
  type PullRequestsRpc,
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

/** Behaves like `bb.sdk.plugins.callRpc`: the output schema parses the peer's answer. */
function peer(answer: () => unknown): { rpc: PullRequestsRpc; calls: Parameters<PullRequestsRpc>[0][] } {
  const calls: Parameters<PullRequestsRpc>[0][] = [];
  return {
    calls,
    rpc: async (args) => {
      calls.push(args);
      return args.outputSchema.parse(answer());
    },
  };
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
});
