import type { NotificationNode } from "../linear/types.js";

/**
 * What kind of thing is this notification, and does the user want it?
 *
 * **Routes on `category`, refines with `type`, and never crashes on an
 * unknown value.** `NotificationCategory` is a real enum in the SDL —
 * seventeen members, verified — while `Notification.type` is a plain `String!`
 * whose per-kind values are custom scalars, so the literal
 * `"issueAssignedToYou"` appears nowhere in the schema and cannot be relied on
 * to exist tomorrow. An exhaustive `switch` on `type` would go silently deaf
 * the next time Linear adds a member; this one degrades to a generic row.
 */

export type NotificationKind = "assigned" | "comment" | "blocked" | "unblocked" | "other";

/** The two `OtherNotificationType` members this plugin acts on. Both are real
 *  enum members, so matching them by name is safe in a way matching a category
 *  string would not be. */
const BLOCKING_TYPES: ReadonlySet<string> = new Set(["issueBlocking"]);
const UNBLOCKING_TYPES: ReadonlySet<string> = new Set(["issueUnblocked"]);

export function classify(node: {
  readonly category: string;
  readonly type: string;
}): NotificationKind {
  // `type` first, but only for the two values that are *enum members* rather
  // than free strings — those carry a meaning no category expresses.
  if (BLOCKING_TYPES.has(node.type)) return "blocked";
  if (UNBLOCKING_TYPES.has(node.type)) return "unblocked";

  switch (node.category) {
    case "assignments":
      return "assigned";
    case "commentsAndReplies":
    case "mentions":
      return "comment";
    default:
      // Every other category — `reactions`, `statusChanges`, `billing`,
      // `system`, and whatever Linear adds next — becomes a generic row. It
      // still reaches the Inbox segment; it just does not get its own
      // sentence or its own setting.
      return "other";
  }
}

export interface SuppressionInput {
  readonly node: NotificationNode;
  readonly now: number;
  readonly viewerId: string | null;
  /** Set on the first successful connect and never again. */
  readonly installWatermark: number;
  readonly boundTeamIds: ReadonlySet<string>;
  /** Whether `(entityId, updatedAt)` is in the echo table — this plugin's own
   *  write coming back. */
  readonly isEcho: (entityId: string, updatedAt: number) => boolean;
  readonly settings: {
    readonly assigned: boolean;
    readonly comments: boolean;
    readonly blocked: boolean;
  };
}

export type Suppression =
  | { readonly send: true }
  | { readonly send: false; readonly because: string };

/**
 * Applied at **send** time, not at claim time.
 *
 * The distinction matters: the claim is what makes delivery at-most-once
 * across restarts, and it has to happen before anything can be sent. The
 * suppression rules are about whether this particular user wants this
 * particular buzz *now* — `readAt` can change between the claim and the send,
 * and a snooze can expire.
 */
export function shouldSend(input: SuppressionInput): Suppression {
  const { node } = input;
  const createdAt = Date.parse(node.createdAt);

  // A stranger's first run must not deliver three hundred notifications about
  // last quarter.
  if (Number.isFinite(createdAt) && createdAt < input.installWatermark) {
    return { send: false, because: "older than this install" };
  }

  // The user did it. Notifying somebody about their own action is the fastest
  // way to make a notification stream worthless.
  if (input.viewerId !== null && node.actor?.id === input.viewerId) {
    return { send: false, because: "you did it" };
  }

  // This plugin did it. `echo` is keyed on (id, updatedAt), so a *later*
  // change by somebody else to the same issue is still reported.
  const issueUpdatedAt = node.issue === undefined ? null : Date.parse(node.issue.updatedAt);
  if (
    node.issue !== undefined &&
    issueUpdatedAt !== null &&
    Number.isFinite(issueUpdatedAt) &&
    input.isEcho(node.issue.id, issueUpdatedAt)
  ) {
    return { send: false, because: "this plugin did it" };
  }

  if (node.readAt !== null) return { send: false, because: "already read in Linear" };

  const snoozedUntil = node.snoozedUntilAt === null ? null : Date.parse(node.snoozedUntilAt);
  if (snoozedUntil !== null && Number.isFinite(snoozedUntil) && snoozedUntil > input.now) {
    return { send: false, because: "snoozed" };
  }

  // Scope is the binding here too. A notification about a team no bb project
  // binds is a notification about work this bb does not track.
  if (node.team !== undefined && !input.boundTeamIds.has(node.team.id)) {
    return { send: false, because: "team not bound" };
  }

  const kind = classify(node);
  if (kind === "assigned" && !input.settings.assigned) {
    return { send: false, because: "assignment notifications are off" };
  }
  if (kind === "comment" && !input.settings.comments) {
    return { send: false, because: "comment notifications are off" };
  }
  if ((kind === "blocked" || kind === "unblocked") && !input.settings.blocked) {
    return { send: false, because: "blocked notifications are off" };
  }

  return { send: true };
}

/**
 * The dedupe key.
 *
 * `groupingKey` where Linear supplies one — it is Linear's own answer to "is
 * this the same event?", and it is what makes a burst of six comments one
 * notification rather than six. The fallback composes type, entity and
 * timestamp, which is what the webhook path needs, so **one mechanism serves
 * both paths**: a second, subtly different dedupe for webhooks is how webhook
 * mode becomes a second pipeline with its own bugs.
 */
export function deliveryKey(node: {
  readonly groupingKey?: string;
  readonly type: string;
  readonly id: string;
  readonly timestamp?: number;
}): string {
  if (node.groupingKey !== undefined && node.groupingKey !== "") return node.groupingKey;
  return `${node.type}:${node.id}:${node.timestamp ?? 0}`;
}

/**
 * A blocked/unblocked pair is **one row that toggles**, not two pings.
 *
 * "ENG-42 is blocked" followed twenty minutes later by "ENG-42 is no longer
 * blocked" is one situation resolving, and delivering it as two events makes
 * the second one feel like new work.
 */
export function inboxKeyFor(kind: NotificationKind, node: NotificationNode): string {
  if (kind === "blocked" || kind === "unblocked") {
    return `blocked:${node.issueId ?? node.id}`;
  }
  return deliveryKey(node);
}
