import { describe, expect, it, vi } from "vitest";
import {
  classify,
  deliveryKey,
  inboxKeyFor,
  shouldSend,
  type SuppressionInput,
} from "../src/notify/classify.js";
import { selectInboxItem, toInboxRow, unseenCount } from "../src/notify/inbox.js";
import { claimAndSend, deliverToPeer, type PeerDeps } from "../src/notify/deliver.js";
import type { NotificationNode } from "../src/linear/types.js";
import { createTestStore, member, NOW } from "./helpers/store.js";

function node(overrides: Partial<NotificationNode> = {}): NotificationNode {
  return {
    id: "n_1",
    type: "issueAssignedToYou",
    category: "assignments",
    groupingKey: "g_1",
    createdAt: "2026-08-12T10:00:00.000Z",
    readAt: null,
    snoozedUntilAt: null,
    inboxUrl: "https://linear.app/acme/inbox/n_1",
    title: "Kai assigned you ENG-42",
    subtitle: "Fix the flaky login test",
    issueStatusType: null,
    actor: { id: "u_kai" },
    issueId: "i_1",
    team: { id: "team_eng" },
    issue: {
      id: "i_1",
      identifier: "ENG-42",
      title: "Fix the flaky login test",
      updatedAt: "2026-08-12T10:00:00.000Z",
    },
    ...overrides,
  };
}

describe("classify", () => {
  it("routes on the category enum", () => {
    expect(classify({ category: "assignments", type: "whatever" })).toBe("assigned");
    expect(classify({ category: "commentsAndReplies", type: "x" })).toBe("comment");
    expect(classify({ category: "mentions", type: "x" })).toBe("comment");
  });

  it("refines with the two type values that are real enum members", () => {
    // `issueBlocking` and `issueUnblocked` are members of
    // OtherNotificationType, so matching them by name is safe in a way
    // matching an arbitrary `type` string would not be.
    expect(classify({ category: "subscriptions", type: "issueBlocking" })).toBe("blocked");
    expect(classify({ category: "subscriptions", type: "issueUnblocked" })).toBe("unblocked");
  });

  it("turns everything else into a generic row rather than dropping it", () => {
    // `Notification.type` is a plain String! and the per-kind types are custom
    // scalars, so an exhaustive switch on it would go silently deaf the next
    // time Linear adds a member.
    for (const category of ["reactions", "statusChanges", "billing", "system", "loops"]) {
      expect(classify({ category, type: "x" })).toBe("other");
    }
    // And three values that do not exist today.
    for (const category of ["somethingNew", "", "TRIAGE"]) {
      expect(classify({ category, type: "alsoNew" })).toBe("other");
    }
  });

  it("covers every documented NotificationCategory member without throwing", () => {
    const categories = [
      "appsAndIntegrations", "assignments", "billing", "commentsAndReplies",
      "customers", "documentChanges", "feed", "loops", "mentions",
      "postsAndUpdates", "reactions", "reminders", "reviews", "statusChanges",
      "subscriptions", "system", "triage",
    ];
    for (const category of categories) {
      expect(() => classify({ category, type: "x" })).not.toThrow();
    }
  });
});

describe("shouldSend", () => {
  function input(overrides: Partial<SuppressionInput> = {}): SuppressionInput {
    return {
      node: node(),
      now: Date.parse("2026-08-12T11:00:00.000Z"),
      viewerId: "u_me",
      installWatermark: Date.parse("2026-08-01T00:00:00.000Z"),
      boundTeamIds: new Set(["team_eng"]),
      workspaceHasBoundTeam: true,
      isEcho: () => false,
      settings: { assigned: true, comments: true, blocked: true },
      ...overrides,
    };
  }

  it("sends an ordinary assignment", () => {
    expect(shouldSend(input()).send).toBe(true);
  });

  it("suppresses anything older than the install", () => {
    // A stranger's first run must not deliver three hundred notifications
    // about last quarter.
    const verdict = shouldSend(
      input({ installWatermark: Date.parse("2026-09-01T00:00:00.000Z") }),
    );
    expect(verdict).toEqual({ send: false, because: "older than this install" });
  });

  it("suppresses the viewer's own action", () => {
    expect(shouldSend(input({ node: node({ actor: { id: "u_me" } }) })).send).toBe(false);
  });

  it("suppresses this plugin's own write, and only that version of it", () => {
    // The echo is keyed on (id, updatedAt): a later change by somebody else to
    // the same issue is still reported.
    const echoed = shouldSend(input({ isEcho: () => true }));
    expect(echoed).toEqual({ send: false, because: "this plugin did it" });

    const later = shouldSend(
      input({
        isEcho: (_id, updatedAt) => updatedAt === Date.parse("2026-08-12T09:00:00.000Z"),
      }),
    );
    expect(later.send).toBe(true);
  });

  it("suppresses what has already been read in Linear", () => {
    expect(shouldSend(input({ node: node({ readAt: "2026-08-12T10:30:00.000Z" }) })).send).toBe(
      false,
    );
  });

  it("suppresses a live snooze but not an expired one", () => {
    expect(
      shouldSend(input({ node: node({ snoozedUntilAt: "2026-08-12T23:00:00.000Z" }) })).send,
    ).toBe(false);
    expect(
      shouldSend(input({ node: node({ snoozedUntilAt: "2026-08-12T10:30:00.000Z" }) })).send,
    ).toBe(true);
  });

  it("suppresses a team no bb project binds", () => {
    expect(shouldSend(input({ boundTeamIds: new Set(["team_other"]) })).send).toBe(false);
  });

  it("suppresses a team-less notification from a workspace with no bound team", () => {
    // The company key you added but bound nothing in: its project/document
    // notifications carry no team, so the team check cannot catch them — the
    // workspace-level guard does.
    const teamless = node({ team: undefined, category: "postsAndUpdates" });
    expect(shouldSend(input({ node: teamless, workspaceHasBoundTeam: false })).send).toBe(false);
  });

  it("still delivers a team-less assignment in a workspace you actually use", () => {
    const teamless = node({ team: undefined });
    expect(shouldSend(input({ node: teamless, workspaceHasBoundTeam: true })).send).toBe(true);
  });

  it("never pushes the catch-all 'other' kind, even in a bound workspace", () => {
    // "other" lands in the durable inbox but is too low-signal to buzz a phone.
    expect(shouldSend(input({ node: node({ category: "statusChanges" }) })).send).toBe(false);
  });

  it("honours each per-kind setting independently", () => {
    expect(
      shouldSend(input({ settings: { assigned: false, comments: true, blocked: true } })).send,
    ).toBe(false);
    expect(
      shouldSend(
        input({
          node: node({ category: "commentsAndReplies" }),
          settings: { assigned: true, comments: false, blocked: true },
        }),
      ).send,
    ).toBe(false);
    expect(
      shouldSend(
        input({
          node: node({ type: "issueBlocking" }),
          settings: { assigned: true, comments: true, blocked: false },
        }),
      ).send,
    ).toBe(false);
  });
});

describe("deliveryKey", () => {
  it("prefers Linear's own groupingKey", () => {
    // It is Linear's answer to "is this the same event?", and it is what makes
    // a burst of six comments one notification rather than six.
    expect(deliveryKey({ groupingKey: "g_1", type: "t", id: "n_1" })).toBe("g_1");
  });

  it("composes a key for the webhook path, which has no groupingKey", () => {
    // One mechanism for both paths: a second, subtly different dedupe is how
    // webhook mode becomes a second pipeline with its own bugs.
    expect(deliveryKey({ type: "Issue", id: "i_1", timestamp: 1234 })).toBe("Issue:i_1:1234");
    expect(deliveryKey({ groupingKey: "", type: "Issue", id: "i_1" })).toBe("Issue:i_1:0");
  });
});

describe("inboxKeyFor", () => {
  it("makes blocked and unblocked one row that toggles", () => {
    // "ENG-42 is blocked" and "ENG-42 is no longer blocked" are one situation
    // resolving; two rows would make the second read as new work.
    const blocked = inboxKeyFor("blocked", node({ type: "issueBlocking" }));
    const unblocked = inboxKeyFor("unblocked", node({ type: "issueUnblocked" }));
    expect(blocked).toBe(unblocked);
  });
});

describe("the claim table", () => {
  it("sends once for one key, however many times it is offered", async () => {
    const store = createTestStore();
    const claim = {
      claim: (key: string, kind: string, at: number) => store.claimDelivery(key, kind, at),
      markSent: (key: string, at: number) => store.markDelivered(key, at),
    };
    const send = vi.fn(async () => {});

    expect(await claimAndSend(claim, { key: "k", kind: "assigned", now: NOW }, send)).toBe(true);
    expect(await claimAndSend(claim, { key: "k", kind: "assigned", now: NOW }, send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("loses one push rather than sending two after a crash", async () => {
    // Claim then send is at MOST once. A crash between the claim and the send
    // loses one push; the durable inbox row is still there, unseen. The
    // rejected alternative — send then claim — is at LEAST once and produces a
    // duplicate buzz after every crash.
    const store = createTestStore();
    const claim = {
      claim: (key: string, kind: string, at: number) => store.claimDelivery(key, kind, at),
      markSent: (key: string, at: number) => store.markDelivered(key, at),
    };

    await claimAndSend(claim, { key: "k", kind: "assigned", now: NOW }, async () => {
      throw new Error("crash between claim and send");
    }).catch(() => undefined);

    const afterRestart = vi.fn(async () => {});
    await claimAndSend(claim, { key: "k", kind: "assigned", now: NOW }, afterRestart);
    expect(afterRestart).not.toHaveBeenCalled();
  });
});

describe("deliverToPeer", () => {
  function deps(overrides: Partial<PeerDeps> = {}): PeerDeps {
    return {
      listPlugins: async () => [{ id: "push", enabled: true, status: "running" }],
      callRpc: async () => ({ delivered: true }),
      ...overrides,
    };
  }

  it("never calls anything when no peer is named", async () => {
    // No candidate list and no auto-detection: `plugins.list()` returns no rpc
    // method names, so "detection" could only mean calling a guessed method on
    // somebody else's plugin.
    const callRpc = vi.fn();
    const outcome = await deliverToPeer(deps({ callRpc }), "", {
      title: "t",
      body: "b",
    });
    expect(outcome).toEqual({ attempted: false, why: "no push plugin is configured" });
    expect(callRpc).not.toHaveBeenCalled();
  });

  it("requires the peer to be running, not merely enabled", async () => {
    const outcome = await deliverToPeer(
      deps({ listPlugins: async () => [{ id: "push", enabled: true, status: "error" }] }),
      "push",
      { title: "t", body: "b" },
    );
    expect(outcome).toEqual({ attempted: false, why: "push is error" });
  });

  it("catches a peer that throws, so the durable row still stands", async () => {
    const outcome = await deliverToPeer(
      deps({
        callRpc: async () => {
          throw new Error("no such method");
        },
      }),
      "push",
      { title: "t", body: "b" },
    );
    expect(outcome).toMatchObject({ attempted: true, delivered: false });
  });

  it("catches a peer shaped differently", async () => {
    const outcome = await deliverToPeer(
      deps({ callRpc: async () => ({ ok: "yes" }) }),
      "push",
      { title: "t", body: "b" },
    );
    expect(outcome).toEqual({
      attempted: true,
      delivered: false,
      error: "unexpected response shape",
    });
  });

  it("caps what it sends, because a peer's fields have limits", async () => {
    const seen: { input: { title: string; body: string } }[] = [];
    const callRpc = vi.fn(async (args: unknown) => {
      seen.push(args as { input: { title: string; body: string } });
      return { delivered: true };
    });
    await deliverToPeer(deps({ callRpc: callRpc as never }), "push", {
      title: "x".repeat(400),
      body: "y".repeat(900),
    });
    const sent = seen[0]!;
    expect(sent.input.title.length).toBeLessThanOrEqual(120);
    expect(sent.input.body.length).toBeLessThanOrEqual(500);
  });
});

describe("the inbox", () => {
  it("reads as one sentence with an actor, a verb and an object", () => {
    const row = toInboxRow(node(), NOW);
    const view = selectInboxItem({
      row,
      actor: member("u_kai", "Kai Rivers"),
      issue: { identifier: "ENG-42", title: "Fix the flaky login test" },
      blockers: [],
      now: NOW,
    });
    expect(view.text).toBe("Kai Rivers assigned you ENG-42 · Fix the flaky login test.");
  });

  it("names the blocker when it knows one", () => {
    const row = toInboxRow(node({ type: "issueBlocking", category: "subscriptions" }), NOW);
    const view = selectInboxItem({
      row,
      actor: null,
      issue: { identifier: "ENG-42", title: "x" },
      blockers: ["ENG-40", "ENG-41"],
      now: NOW,
    });
    expect(view.text).toBe("ENG-42 is blocked by ENG-40 and ENG-41.");
  });

  it("falls back to Linear's own words when it does not know the actor", () => {
    const row = toInboxRow(node(), NOW);
    const view = selectInboxItem({ row, actor: null, issue: null, blockers: [], now: NOW });
    expect(view.text).toBe("Kai assigned you ENG-42");
  });

  it("keeps a row read elsewhere in the list but out of the unseen count", () => {
    // A row disappearing under your cursor is worse than a stale dot.
    const read = { ...toInboxRow(node(), NOW), linearReadAt: NOW };
    const view = selectInboxItem({ row: read, actor: null, issue: null, blockers: [], now: NOW });
    expect(view.unseen).toBe(false);
    expect(unseenCount([read])).toBe(0);
    expect(unseenCount([toInboxRow(node(), NOW)])).toBe(1);
  });

  it("does not un-see a row the poller sees again", () => {
    const store = createTestStore();
    const row = toInboxRow(node(), NOW);
    store.putInbox([row]);
    store.markInboxSeen([row.key], NOW);
    store.putInbox([row]);
    expect(store.unseenInboxCount()).toBe(0);
  });

  it("keeps a dismissed row out of the list", () => {
    const store = createTestStore();
    const row = toInboxRow(node(), NOW);
    store.putInbox([row]);
    store.dismissInbox([row.key], NOW);
    expect(store.inbox()).toEqual([]);
    expect(store.inbox({ includeDismissed: true })).toHaveLength(1);
  });
});
