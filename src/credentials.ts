import { credentialFingerprint, patFromSetting, type LinearCredential } from "./linear/credential.js";

/**
 * More than one Linear workspace, from one bb.
 *
 * A Linear personal API key is scoped to **one workspace**. Someone who
 * contracts for two organisations, or who keeps a personal workspace beside a
 * work one, cannot see both with one key — no amount of permission granting
 * changes that, because the key is issued by the workspace. So a plugin that
 * holds exactly one key is a plugin that works for exactly one of their
 * workspaces, and the other one is invisible.
 *
 * **Slots, not a list.** A secret setting's key *is* the filename it is stored
 * under, and this plugin never writes its own settings — so the set of places
 * a key can live has to be declared up front and fixed forever. Four is the
 * number: it covers a personal workspace plus three clients, it keeps the
 * settings form readable, and every slot past the first is empty by default and
 * costs nothing.
 *
 * Everything downstream is keyed by slot: one transport, one rate-limit budget,
 * one circuit breaker, one notification cursor and one `viewer` per slot,
 * because Linear tracks all five per key. Teams record which workspace they
 * came from, and a write to a team goes out over the key that can see it.
 */

export const CREDENTIAL_SLOTS = ["apiKey", "apiKey2", "apiKey3", "apiKey4"] as const;

export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

/** The slot that existed before there were slots. Its setting key is
 *  unchanged, because renaming a secret setting orphans the file it is stored
 *  in and silently un-configures the plugin on upgrade. */
export const PRIMARY_SLOT: CredentialSlot = "apiKey";

export function isCredentialSlot(value: string): value is CredentialSlot {
  return (CREDENTIAL_SLOTS as readonly string[]).includes(value);
}

/** For messages. The first slot is not called "workspace 1", because for the
 *  overwhelming majority of installs there is only one and numbering it would
 *  imply a second is expected. */
export function slotLabel(slot: CredentialSlot): string {
  return slot === PRIMARY_SLOT ? "Linear API key" : `Linear API key ${slot.slice("apiKey".length)}`;
}

export type SlotValues = Readonly<Record<CredentialSlot, string | undefined>>;

export interface SlotCredential {
  readonly slot: CredentialSlot;
  readonly credential: LinearCredential;
  /** Distinguishes "this key was replaced" from "this key was revoked" without
   *  ever holding the key itself. */
  readonly fingerprint: string;
}

/**
 * Every slot that has a key in it, in declared order.
 *
 * Trimmed at the read, because the host's `readSecret` is a raw `readFile`: a
 * key pasted with a trailing newline persists with one and every request 401s
 * in a way that reads exactly like a revoked key.
 */
export function configuredSlots(values: SlotValues): SlotCredential[] {
  const found: SlotCredential[] = [];
  for (const slot of CREDENTIAL_SLOTS) {
    const credential = patFromSetting(values[slot]);
    if (credential === null) continue;
    found.push({ slot, credential, fingerprint: credentialFingerprint(credential) });
  }
  return found;
}

/**
 * Two slots holding the same key.
 *
 * Worth naming rather than tolerating: the second slot would verify happily,
 * report the same workspace, and then spend a second full share of a
 * **shared** rate-limit budget re-reading teams the first slot already has.
 * Linear's 2,500 requests an hour is per key, and the same key twice is one
 * budget split two ways for no benefit.
 */
export function duplicateSlots(slots: readonly SlotCredential[]): CredentialSlot[][] {
  const byFingerprint = new Map<string, CredentialSlot[]>();
  for (const entry of slots) {
    const existing = byFingerprint.get(entry.fingerprint);
    if (existing === undefined) byFingerprint.set(entry.fingerprint, [entry.slot]);
    else existing.push(entry.slot);
  }
  return [...byFingerprint.values()].filter((group) => group.length > 1);
}
