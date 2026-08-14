/**
 * The declared settings, in one place so `server.ts` and the tests read the
 * same descriptors.
 *
 * Two rules govern this file and neither is negotiable.
 *
 * **A key is never renamed after release.** A secret setting's key *is* the
 * filename it is stored under (`<dataDir>/plugins/linear/secrets/<key>`), so
 * renaming `apiKey` orphans the file and silently un-configures the plugin on
 * upgrade. The migration, if one is ever genuinely needed, is: add the new
 * key, read-old-write-new for one release, remove the old one in a major.
 *
 * **The plugin never writes its own settings.** When a plugin's status is
 * `needs-configuration`, the host's `updateSettings` awaits a
 * dispose-then-load cycle inline, and an rpc handler is an in-flight
 * invocation that dispose waits on — a plugin saving its own key from its own
 * handler stalls, loses its handles mid-flight, and can take the server down
 * with it (observed live in this plugin's predecessor). The host already
 * renders `secret: true` descriptors as password fields, including for
 * `needs-configuration` plugins; that form and `bb plugin config` are the
 * only writers.
 */

import type { PluginSettingsValues } from "@bb/plugin-sdk";

export const SETTING_DESCRIPTORS = {
  apiKey: {
    type: "string",
    label: "Linear API key",
    secret: true,
    description:
      "Create one in Linear under Settings → Account → Security & access → Personal API keys. Read access is enough to browse; write access is needed to change anything. Stored in bb's secret storage on this machine (a 0600 file), never shown again, and never given to an agent.",
  },

  /*
   * Slots two, three and four. Empty for almost everyone.
   *
   * A Linear personal API key is scoped to one workspace, so a second
   * workspace genuinely needs a second key — there is no permission that
   * makes one key reach two. Declared up front and never renamed, for the
   * same reason `apiKey` is: a secret setting's key is the filename it lives
   * in.
   */
  apiKey2: {
    type: "string",
    label: "Linear API key — second workspace",
    secret: true,
    description:
      "Only if you work in more than one Linear workspace. Create the key in that workspace, the same way. Its teams appear alongside the first workspace's, tagged with which workspace they came from.",
  },
  apiKey3: {
    type: "string",
    label: "Linear API key — third workspace",
    secret: true,
    description: "As above. Leave empty unless you need it.",
  },
  apiKey4: {
    type: "string",
    label: "Linear API key — fourth workspace",
    secret: true,
    description: "As above. Leave empty unless you need it.",
  },
} as const;

export type LinearSettings = PluginSettingsValues<typeof SETTING_DESCRIPTORS>;

/** The slot numbers, in display order. Slot 1 reads `apiKey`, the rest
 *  `apiKey<n>` — the asymmetry is permanent because the key names are. */
export const KEY_SLOTS = [1, 2, 3, 4] as const;
export type KeySlot = (typeof KEY_SLOTS)[number];

export function slotSettingKey(slot: KeySlot): keyof LinearSettings {
  return slot === 1 ? "apiKey" : (`apiKey${slot}` as keyof LinearSettings);
}

export function rawKeyForSlot(
  settings: LinearSettings,
  slot: KeySlot,
): string | undefined {
  return settings[slotSettingKey(slot)];
}
