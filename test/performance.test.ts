import { describe, expect, it } from "vitest";
import { loadsForSegment } from "../src/panel-chrome.js";
import { createKeyedSingleFlight, staleWhileRevalidate } from "../src/performance.js";

describe("keyed single-flight", () => {
  it("joins duplicate work while letting independent keys run concurrently", async () => {
    const run = createKeyedSingleFlight<string, string>();
    let calls = 0;
    let active = 0;
    let peak = 0;
    const releases = new Map<string, () => void>();

    const task = (key: string) =>
      run(key, async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.set(key, resolve));
        active -= 1;
        return key;
      });

    const a1 = task("a");
    const a2 = task("a");
    const b = task("b");
    await Promise.resolve();

    expect(calls).toBe(2);
    expect(peak).toBe(2);
    releases.get("a")?.();
    releases.get("b")?.();
    await expect(Promise.all([a1, a2, b])).resolves.toEqual(["a", "a", "b"]);
  });

  it("clears a rejected flight so the next attempt can retry", async () => {
    const run = createKeyedSingleFlight<string, string>();
    let calls = 0;
    await run("a", async () => {
      calls += 1;
      throw new Error("first failed");
    }).catch(() => undefined);

    await expect(
      run("a", async () => {
        calls += 1;
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });
});

describe("stale while revalidate", () => {
  it("returns local snapshots without waiting for concurrent refreshes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshing: string[] = [];
    let background: Promise<void> | null = null;

    const values = await staleWhileRevalidate({
      entries: ["a", "b"],
      snapshot: async (entry) => ({ value: `cached-${entry}`, fresh: false }),
      refresh: async (entry) => {
        refreshing.push(entry);
        await gate;
      },
      detach: (task) => {
        background = task();
      },
    });

    expect(values).toEqual(["cached-a", "cached-b"]);
    await Promise.resolve();
    expect(refreshing.sort()).toEqual(["a", "b"]);
    release?.();
    await background;
  });
});

describe("panel load routing", () => {
  it("loads only the visible heavy segment", () => {
    expect(loadsForSegment("working")).toEqual({ panel: false, working: true, facets: false });
    expect(loadsForSegment("all")).toEqual({ panel: true, working: false, facets: true });
    expect(loadsForSegment("inbox")).toEqual({ panel: false, working: false, facets: false });
  });
});
