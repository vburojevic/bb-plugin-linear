import { z } from "zod";
import { describeError } from "../linear/errors.js";

/**
 * Where the pull-request facts come from.
 *
 * bb 0.47 deleted `bb.sdk.environments.pullRequest` and moved GitHub pull
 * requests into its bundled GitHub PR Status plugin, which is built in and on
 * by default. Its `pullRequests` RPC is a keyed read with the same three-way
 * union the old method returned, so the runner's decision logic is unchanged.
 */
export const GITHUB_PR_STATUS_PLUGIN_ID = "bb--github-pr-status";

/** Only the fields this plugin reads. Not `.strict()`: the peer's rows carry
 *  more (checks, review, mergeability), and a new field there must not turn
 *  every lookup into a schema failure here. */
const pullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  url: z.string(),
  baseRefName: z.string(),
  attention: z.string(),
});

const environmentPullRequestSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), pullRequest: pullRequestSchema }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);

export const pullRequestsOutputSchema = z.record(z.string(), environmentPullRequestSchema);

export type PullRequestLookup = z.infer<typeof environmentPullRequestSchema>;

export type PullRequestsRpc = (args: {
  pluginId: string;
  method: string;
  input: { keys: string[] };
  outputSchema: typeof pullRequestsOutputSchema;
}) => Promise<z.infer<typeof pullRequestsOutputSchema>>;

/**
 * One environment's pull request, as one of the three outcomes.
 *
 * `callRpc` throws when the peer is missing, disabled, still loading, or
 * answers with a different shape. Each of those means the lookup itself
 * failed, which is `unavailable`, never `absent`: the decision function must
 * not read "couldn't ask" as "no pull request exists".
 */
export async function lookupPullRequest(
  callRpc: PullRequestsRpc,
  environmentId: string,
): Promise<PullRequestLookup> {
  try {
    const rows = await callRpc({
      pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
      method: "pullRequests",
      input: { keys: [environmentId] },
      outputSchema: pullRequestsOutputSchema,
    });
    return (
      rows[environmentId] ?? {
        outcome: "unavailable",
        message: `${GITHUB_PR_STATUS_PLUGIN_ID} returned no row for this environment.`,
      }
    );
  } catch (error) {
    return {
      outcome: "unavailable",
      message: `${GITHUB_PR_STATUS_PLUGIN_ID} could not be asked: ${describeError(error)}`,
    };
  }
}
