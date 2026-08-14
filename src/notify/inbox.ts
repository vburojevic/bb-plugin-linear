import { formatRelativeCompact } from "../format.js";
import type { NotificationNode } from "../linear/types.js";
import type { MemberRow } from "../store/rows.js";
import { classify, inboxKeyFor, type NotificationKind } from "./classify.js";

/**
 * The Inbox segment: rows, and the sentences they read as.
 *
 * Rung 1 of the delivery ladder writes a durable row; this is where it lands
 * and it is the notification's **home**. The homepage section and the composer
 * banner are echoes of it, and nothing else carries a count.
 */

export interface InboxRow {
  readonly key: string;
  readonly kind: NotificationKind;
  readonly issueId: string | null;
  readonly teamId: string | null;
  readonly actorId: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly url: string | null;
  readonly createdAt: number;
  readonly seenAt: number | null;
  readonly dismissedAt: number | null;
  /** Linear's own read state, carried by the poller. A row read elsewhere
   *  drops out of the unseen count on the next tick — it does not vanish,
   *  because a row disappearing under your cursor is worse than a stale dot. */
  readonly linearReadAt: number | null;
}

export function toInboxRow(node: NotificationNode, now: number): InboxRow {
  const kind = classify(node);
  const createdAt = Date.parse(node.createdAt);
  return {
    key: inboxKeyFor(kind, node),
    kind,
    issueId: node.issueId ?? node.issue?.id ?? null,
    teamId: node.team?.id ?? null,
    actorId: node.actor?.id ?? null,
    title: node.title,
    body: node.subtitle === "" ? null : node.subtitle,
    url: node.inboxUrl,
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    seenAt: null,
    dismissedAt: null,
    linearReadAt: node.readAt === null ? null : Date.parse(node.readAt),
  };
}

export interface InboxItemView {
  readonly key: string;
  readonly kind: NotificationKind;
  readonly text: string;
  readonly identifier: string | null;
  readonly issueId: string | null;
  readonly url: string | null;
  /** Set only when more than one workspace is connected. */
  readonly workspace: string | null;
  readonly age: string;
  readonly unseen: boolean;
}

/**
 * One sentence grammar for every row.
 *
 * *"**Kai** assigned you **ENG-42 · Fix the flaky login test**."* — an actor,
 * a verb, an object. Linear's own `title`/`subtitle` are the fallback rather
 * than the default, because they are written for Linear's inbox and read
 * oddly out of it; where the plugin knows the actor and the issue it says so
 * in its own words.
 */
export function selectInboxItem(input: {
  readonly row: InboxRow;
  readonly actor: MemberRow | null;
  readonly issue: { readonly identifier: string; readonly title: string } | null;
  readonly blockers: readonly string[];
  readonly now: number;
  /** The workspace name, only when more than one is connected — naming the
   *  only workspace on every row is noise, and a merged inbox without labels
   *  is a guessing game. */
  readonly workspace?: string | null;
}): InboxItemView {
  const actor = input.actor?.displayName ?? null;
  const subject =
    input.issue === null ? null : `${input.issue.identifier} · ${input.issue.title}`;

  let text: string;
  switch (input.row.kind) {
    case "assigned":
      text =
        actor === null || subject === null
          ? input.row.title
          : `${actor} assigned you ${subject}.`;
      break;
    case "comment":
      text =
        actor === null || input.issue === null
          ? input.row.title
          : `${actor} replied on ${input.issue.identifier}.`;
      break;
    case "blocked":
      text =
        input.issue === null
          ? input.row.title
          : input.blockers.length === 0
            ? `${input.issue.identifier} is blocked.`
            : `${input.issue.identifier} is blocked by ${input.blockers.join(" and ")}.`;
      break;
    case "unblocked":
      text =
        input.issue === null
          ? input.row.title
          : `${input.issue.identifier} is no longer blocked.`;
      break;
    case "other":
      text = input.row.body === null ? input.row.title : `${input.row.title} — ${input.row.body}`;
      break;
  }

  return {
    key: input.row.key,
    kind: input.row.kind,
    text,
    identifier: input.issue?.identifier ?? null,
    issueId: input.row.issueId,
    url: input.row.url,
    workspace: input.workspace ?? null,
    age: formatRelativeCompact(input.row.createdAt, input.now),
    // Unseen means: this bb has not shown it, and Linear does not think it has
    // been read either. Reading it in Linear's own client clears the dot on
    // the next tick without removing the row.
    unseen: input.row.seenAt === null && input.row.linearReadAt === null,
  };
}

/** Capped at 99+ because the difference between 100 and 340 has never changed
 *  anybody's next action. */
export function unseenCount(rows: readonly InboxRow[]): number {
  return rows.filter((row) => row.dismissedAt === null && row.seenAt === null && row.linearReadAt === null)
    .length;
}
