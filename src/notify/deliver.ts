import { z } from "zod";
import { describeError } from "../linear/errors.js";
import { truncate } from "../format.js";

/**
 * The delivery ladder, and a contract instead of a guess.
 *
 * **Rung 1 — always.** A durable inbox row plus a coalesced `linear:inbox`
 * signal. This rung has no preconditions and never fails.
 *
 * **Rung 2 — only if the user named a peer.** There is no plugin-facing
 * notification API in bb (verified: no `notif*` symbol anywhere in the SDK
 * declarations), and there is no existing peer that could receive one — the
 * published iOS push plugin exposes `status`, `subscribe`, `unsubscribe`,
 * `removeDevice` and `sendTest`, and `sendTest` takes `z.null()`, so it cannot
 * carry a title or a body. Nor is method feature-detection possible:
 * `plugins.list()` returns no rpc method names, so "detection" could only mean
 * calling a guessed method on somebody else's plugin.
 *
 * So: **no candidate list, no auto-detection.** This plugin publishes a
 * contract in `docs/push-contract.md` and calls only what the user put in
 * `pushPluginId`. The README says the true thing — "bb has no plugin
 * notification API, so these land in bb" — rather than "if a push plugin is
 * installed", which is true for nobody today.
 *
 * **Rung 3 — foreground.** The frontend raises a toast on the realtime signal.
 * The backend never toasts.
 */

/** The proposed cross-plugin push contract. No shipping plugin implements it
 *  yet, which is exactly why it is written down rather than assumed. */
export const pushNotifyOutputSchema = z.object({ delivered: z.boolean() });

export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly tag?: string;
}

export interface PeerDeps {
  /** `bb.sdk.plugins.list()`, narrowed. */
  readonly listPlugins: () => Promise<
    readonly { readonly id: string; readonly enabled: boolean; readonly status: string }[]
  >;
  readonly callRpc: (args: {
    pluginId: string;
    method: string;
    input: unknown;
    outputSchema: typeof pushNotifyOutputSchema;
  }) => Promise<unknown>;
  readonly log?: (level: "debug" | "warn", message: string) => void;
}

export type PeerOutcome =
  | { readonly attempted: false; readonly why: string }
  | { readonly attempted: true; readonly delivered: boolean; readonly error: string | null };

/**
 * Call a named peer, and survive every way it can be wrong.
 *
 * `callRpc` throws for a missing, disabled or changed peer, and the plugin's
 * **own** output schema is what catches a peer that answers with a different
 * shape. Every one of those is caught here: a push that does not arrive must
 * never cost the durable row that already did.
 */
export async function deliverToPeer(
  deps: PeerDeps,
  pushPluginId: string,
  payload: PushPayload,
): Promise<PeerOutcome> {
  const id = pushPluginId.trim();
  if (id === "") return { attempted: false, why: "no push plugin is configured" };

  let peer: { id: string; enabled: boolean; status: string } | undefined;
  try {
    const plugins = await deps.listPlugins();
    peer = plugins.find((entry) => entry.id === id);
  } catch (error) {
    return { attempted: false, why: describeError(error) };
  }

  // `enabled` alone is not enough: a plugin can be enabled and failing to
  // load, and calling into one that is not running produces an error rather
  // than a delivery.
  if (peer === undefined) return { attempted: false, why: `no plugin called ${id} is installed` };
  if (!peer.enabled) return { attempted: false, why: `${id} is disabled` };
  if (peer.status !== "running") return { attempted: false, why: `${id} is ${peer.status}` };

  try {
    const result = await deps.callRpc({
      pluginId: id,
      method: "notify",
      input: {
        title: truncate(payload.title, 120),
        body: truncate(payload.body, 500),
        ...(payload.url === undefined ? {} : { url: payload.url }),
        ...(payload.tag === undefined ? {} : { tag: truncate(payload.tag, 64) }),
      },
      outputSchema: pushNotifyOutputSchema,
    });
    const parsed = pushNotifyOutputSchema.safeParse(result);
    if (!parsed.success) {
      // A peer shaped differently is a caught schema error and nothing else.
      deps.log?.("debug", `${id} answered notify with an unexpected shape.`);
      return { attempted: true, delivered: false, error: "unexpected response shape" };
    }
    return { attempted: true, delivered: parsed.data.delivered, error: null };
  } catch (error) {
    deps.log?.("debug", `${id} could not deliver a notification: ${describeError(error)}`);
    return { attempted: true, delivered: false, error: describeError(error) };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The claim                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ClaimStore {
  /** `INSERT OR IGNORE`, returning whether this call won the row. */
  claim(key: string, kind: string, at: number): boolean;
  markSent(key: string, at: number): void;
}

/**
 * **Claim then send** — at most once.
 *
 * A crash between the claim and the send loses one push. The rejected
 * alternative, send then claim, is at least once and produces a duplicate buzz
 * after every crash.
 *
 * Duplicates lose, and the reason is asymmetric: the durable surface — the
 * Inbox segment — is recomputed from Linear and can never miss anything, so
 * only the ephemeral push is at risk. Losing one push whose row is still
 * sitting unseen in the panel is strictly the better failure.
 */
export async function claimAndSend(
  store: ClaimStore,
  input: { readonly key: string; readonly kind: string; readonly now: number },
  send: () => Promise<void>,
): Promise<boolean> {
  if (!store.claim(input.key, input.kind, input.now)) return false;
  await send();
  store.markSent(input.key, input.now);
  return true;
}
