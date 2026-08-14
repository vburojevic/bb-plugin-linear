import type { CallOptions, LinearClient } from "../linear/client.js";
import type { NotificationNode } from "../linear/types.js";

const MAX_NOTIFICATION_PAGES = 200;

/** Follow Linear's notification cursor to completion. A missing or repeated
 * cursor is an explicit failure, never an endless page-one poll. */
export async function readAllNotifications(
  client: Pick<LinearClient, "notifications">,
  since: string,
  options?: CallOptions,
): Promise<readonly NotificationNode[]> {
  const nodes: NotificationNode[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let pages = 0;

  while (true) {
    const result = await client.notifications(since, after, options);
    pages += 1;
    nodes.push(...result.notifications.nodes);
    if (!result.notifications.pageInfo.hasNextPage) return nodes;
    if (pages >= MAX_NOTIFICATION_PAGES) {
      throw new Error("Linear returned too many notification pages.");
    }

    const next = result.notifications.pageInfo.endCursor ?? null;
    if (next === null || seen.has(next)) {
      throw new Error("Linear returned an invalid notification cursor.");
    }
    seen.add(next);
    after = next;
  }
}
