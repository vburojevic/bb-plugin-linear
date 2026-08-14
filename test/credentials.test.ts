import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SLOTS,
  configuredSlots,
  duplicateSlots,
  isCredentialSlot,
  PRIMARY_SLOT,
  slotLabel,
} from "../src/credentials.js";
import { SETTING_DESCRIPTORS } from "../src/settings.js";
import { createTestStore, NOW, team } from "./helpers/store.js";

const empty = { apiKey: undefined, apiKey2: undefined, apiKey3: undefined, apiKey4: undefined };

describe("credential slots", () => {
  it("declares a setting descriptor for every slot", () => {
    // A slot with no descriptor is a slot nobody can fill: the host renders
    // the declared descriptors and nothing else.
    for (const slot of CREDENTIAL_SLOTS) {
      expect(SETTING_DESCRIPTORS).toHaveProperty(slot);
      expect(SETTING_DESCRIPTORS[slot].secret).toBe(true);
    }
  });

  it("keeps the primary slot's key name unchanged", () => {
    // A secret setting's key IS the filename it is stored under. Renaming it
    // orphans the file and silently un-configures the plugin on upgrade.
    expect(PRIMARY_SLOT).toBe("apiKey");
    expect(CREDENTIAL_SLOTS[0]).toBe("apiKey");
  });

  it("finds nothing when nothing is set", () => {
    expect(configuredSlots(empty)).toEqual([]);
  });

  it("trims, because readSecret does not", () => {
    // A key pasted with a trailing newline persists with one and every request
    // 401s in a way that reads exactly like a revoked key.
    const found = configuredSlots({ ...empty, apiKey: "lin_api_one\n" });
    expect(found).toHaveLength(1);
    expect(found[0]!.credential).toEqual({ kind: "pat", token: "lin_api_one" });
  });

  it("ignores a slot holding only whitespace", () => {
    expect(configuredSlots({ ...empty, apiKey2: "   " })).toEqual([]);
  });

  it("returns slots in declared order, not settings order", () => {
    const found = configuredSlots({
      ...empty,
      apiKey3: "lin_api_three",
      apiKey: "lin_api_one",
    });
    expect(found.map((entry) => entry.slot)).toEqual(["apiKey", "apiKey3"]);
  });

  it("works with a second key and no first, because someone will do that", () => {
    const found = configuredSlots({ ...empty, apiKey2: "lin_api_two" });
    expect(found.map((entry) => entry.slot)).toEqual(["apiKey2"]);
  });

  it("fingerprints without holding the key", () => {
    const found = configuredSlots({ ...empty, apiKey: "lin_api_secretvalue" });
    expect(found[0]!.fingerprint).not.toContain("secretvalue");
  });
});

describe("duplicateSlots", () => {
  it("names two slots holding the same key", () => {
    // Both verify, both report the same workspace, and Linear's 2,500 requests
    // an hour — which is per key — gets split two ways for nothing.
    const found = configuredSlots({ ...empty, apiKey: "lin_api_same", apiKey3: "lin_api_same" });
    expect(duplicateSlots(found)).toEqual([["apiKey", "apiKey3"]]);
  });

  it("says nothing about genuinely different keys", () => {
    const found = configuredSlots({ ...empty, apiKey: "lin_api_a", apiKey2: "lin_api_b" });
    expect(duplicateSlots(found)).toEqual([]);
  });
});

describe("slotLabel", () => {
  it("does not number the first one", () => {
    // Virtually every install has exactly one. Calling it "workspace 1" would
    // imply a second is expected.
    expect(slotLabel("apiKey")).toBe("Linear API key");
    expect(slotLabel("apiKey2")).toBe("Linear API key 2");
  });
});

describe("isCredentialSlot", () => {
  it("rejects a value read back from the database that is not a slot", () => {
    // The store's `slot` column is TEXT. A row written by a future version, or
    // by hand, must fall back rather than index into nothing.
    expect(isCredentialSlot("apiKey")).toBe(true);
    expect(isCredentialSlot("apiKey9")).toBe(false);
    expect(isCredentialSlot("")).toBe(false);
  });
});

describe("the store keeps workspaces apart", () => {
  function workspace(id: string, slot: string, name: string) {
    return {
      id,
      slot,
      name,
      urlKey: name.toLowerCase(),
      viewerId: `viewer-${id}`,
      viewerName: "Somebody",
      gitBranchFormat: null,
    };
  }

  it("holds more than one workspace, in slot order", () => {
    const store = createTestStore();
    store.putWorkspace(workspace("w2", "apiKey2", "Beta"), NOW);
    store.putWorkspace(workspace("w1", "apiKey", "Alpha"), NOW);

    expect(store.workspaces().map((entry) => entry.name)).toEqual(["Alpha", "Beta"]);
    // The single-workspace surfaces show the primary, not whichever row came
    // back first.
    expect(store.workspace()?.name).toBe("Alpha");
  });

  it("answers which key can reach a team", () => {
    // The single most important lookup in the multi-workspace change: send a
    // team id over the wrong key and Linear answers with nothing, which reads
    // exactly like an empty team.
    const store = createTestStore();
    store.putWorkspace(workspace("w1", "apiKey", "Alpha"), NOW);
    store.putWorkspace(workspace("w2", "apiKey2", "Beta"), NOW);
    store.putTeams(
      [team("t1", "ONE", { workspaceId: "w1" }), team("t2", "TWO", { workspaceId: "w2" })],
      NOW,
    );

    expect(store.workspaceForTeam("t1")?.slot).toBe("apiKey");
    expect(store.workspaceForTeam("t2")?.slot).toBe("apiKey2");
  });

  it("returns nothing for a team recorded before workspaces were plural", () => {
    // NULL means "not recorded yet". The caller falls back to the primary
    // slot, which is where such a team came from.
    const store = createTestStore();
    store.putTeams([team("t1", "ONE")], NOW);
    expect(store.workspaceForTeam("t1")).toBeNull();
  });

  it("does not overwrite a known workspace with an unknown one", () => {
    // An upsert from a path that does not know the workspace must not erase
    // one that does.
    const store = createTestStore();
    store.putWorkspace(workspace("w1", "apiKey", "Alpha"), NOW);
    store.putTeams([team("t1", "ONE", { workspaceId: "w1" })], NOW);
    store.putTeams([team("t1", "ONE", { workspaceId: null })], NOW + 1);

    expect(store.workspaceForTeam("t1")?.id).toBe("w1");
  });

  it("forgets a workspace and its teams when its key is removed", () => {
    const store = createTestStore();
    store.putWorkspace(workspace("w1", "apiKey", "Alpha"), NOW);
    store.putWorkspace(workspace("w2", "apiKey2", "Beta"), NOW);
    store.putTeams(
      [team("t1", "ONE", { workspaceId: "w1" }), team("t2", "TWO", { workspaceId: "w2" })],
      NOW,
    );

    store.forgetWorkspace("w2");

    expect(store.workspaces().map((entry) => entry.id)).toEqual(["w1"]);
    expect(store.teams().map((entry) => entry.id)).toEqual(["t1"]);
  });
});
