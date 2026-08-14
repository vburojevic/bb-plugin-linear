import type { z } from "zod";
import type { PluginKvStorage } from "@bb/plugin-sdk";

/**
 * Typed, versioned access to `bb.storage.kv`.
 *
 * kv holds cursors and small state only — values cap at 256 KB, and anything
 * that grows belongs in the plugin's own SQLite. What lives here is the state
 * that must survive a reload but has no rows: watermarks, webhook ids, the
 * install watermark, the last budget snapshot.
 *
 * Two rules, both enforced by this module rather than by discipline:
 *
 * **Every value is parsed, never cast.** `kv.get<T>()` is a lie about a JSON
 * blob written by an older release of this plugin; a schema parse turns a
 * shape change into a fallback instead of a `TypeError` three frames away.
 *
 * **Every value carries a version.** `{ v: 1, … }` means a later release can
 * recognise what it is reading and either migrate it or discard it. A bare
 * value cannot be told apart from a corrupted one.
 */

export interface VersionedStore {
  read<S extends z.ZodType>(key: string, schema: S, fallback: z.infer<S>): Promise<z.infer<S>>;
  /** Returns `undefined` when the key is missing or unparseable, for the
   *  callers where "absent" and "the default" are different answers. */
  readOptional<S extends z.ZodType>(key: string, schema: S): Promise<z.infer<S> | undefined>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  /** Drop every key this plugin owns. Disconnect means it, so this has to
   *  reach state a targeted delete would miss. */
  clearAll(): Promise<void>;
}

export function createVersionedStore(kv: PluginKvStorage): VersionedStore {
  return {
    async read(key, schema, fallback) {
      const raw = await kv.get<unknown>(key);
      if (raw === undefined) return fallback;
      const parsed = schema.safeParse(raw);
      return parsed.success ? parsed.data : fallback;
    },

    async readOptional(key, schema) {
      const raw = await kv.get<unknown>(key);
      if (raw === undefined) return undefined;
      const parsed = schema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    },

    write: (key, value) => kv.set(key, value),
    remove: (key) => kv.delete(key),
    keys: (prefix) => kv.list(prefix),

    async clearAll() {
      const all = await kv.list();
      await Promise.all(all.map((key) => kv.delete(key)));
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Keys                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Every kv key this plugin writes, named in one place.
 *
 * A key built inline at three call sites is a key that gets a typo at one of
 * them, and the symptom — a watermark that resets on every load, so the poller
 * re-reads the same page forever — looks like a sync bug rather than a typo.
 */
export const KV = {
  /** Whether a particular credential has ever verified. Keyed by a
   *  non-reversible fingerprint; the key itself never goes near kv. */
  verified: (fingerprint: string) => `verified:${fingerprint}`,
  /** Set once, on first successful connect. Notifications older than this are
   *  suppressed, so a new install does not deliver last quarter. */
  installWatermark: "install-watermark",
  /** The last write this plugin was refused, which is how the read-only key
   *  state is discovered — Linear does not expose a key's scopes. */
  writeRefusal: "write-refusal",
  /** Written once a team's bounded backfill has completed. This is the only
   *  honest way to tell "still reading" from "this team has no open issues",
   *  and getting that distinction wrong makes the panel state a fact about a
   *  team it has not yet looked at. */
  backfilled: (teamId: string) => `backfilled:${teamId}`,
  /** Per (team, entity) sync cursors. */
  watermark: (teamId: string, entity: string) => `watermark:${teamId}:${entity}`,
  /** The viewer's notification cursor, which is workspace-wide. */
  notificationWatermark: "watermark:notifications",
  /**
   * One notification cursor per key.
   *
   * A Linear notification belongs to a *viewer*, and each key has its own —
   * so two workspaces have two independent inboxes with two independent
   * clocks. Sharing one cursor would let the busier workspace's timestamps
   * advance past the quieter one's unread notifications, which never arrive
   * and leave no trace that they did not.
   *
   * The primary slot keeps the original key so an existing install does not
   * replay its inbox on upgrade.
   */
  notificationWatermarkFor: (slot: string): string =>
    slot === "apiKey" ? "watermark:notifications" : `watermark:notifications:${slot}`,
  /** Webhook ids, one per bound team. */
  webhook: (teamId: string) => `webhook:${teamId}`,
  /** The last rate-limit snapshot, so `bb linear budget` can answer without
   *  spending a request to find out. */
  budget: "budget",
  /** Account-wide UI preference. Sort only — see the persistence split. */
  sortPreference: "ui:sort",
} as const;
