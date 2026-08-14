/**
 * Small concurrency primitives used at the plugin boundary.
 *
 * They live outside `server.ts` so the two properties that matter can be
 * tested deterministically: duplicate work joins one promise, while unrelated
 * work is allowed to overlap; and a handler can return a local snapshot while
 * stale network refreshes continue behind the lifetime guard.
 */

export function createKeyedSingleFlight<Key, Value>(): (
  key: Key,
  task: () => Promise<Value>,
) => Promise<Value> {
  const active = new Map<Key, Promise<Value>>();

  return (key, task) => {
    const existing = active.get(key);
    if (existing !== undefined) return existing;

    const running = Promise.resolve().then(task);
    active.set(key, running);
    const clear = (): void => {
      if (active.get(key) === running) active.delete(key);
    };
    // Both branches handle the tail, so cleanup never creates a detached
    // rejected promise of its own.
    void running.then(clear, clear);
    return running;
  };
}

export async function staleWhileRevalidate<Entry, Value>(options: {
  readonly entries: readonly Entry[];
  readonly snapshot: (entry: Entry) => Promise<{ value: Value; fresh: boolean }>;
  readonly refresh: (entry: Entry) => Promise<void>;
  readonly detach: (task: () => Promise<void>) => void;
}): Promise<Value[]> {
  const snapshots = await Promise.all(options.entries.map(options.snapshot));
  const stale = options.entries.filter((_, index) => snapshots[index]?.fresh === false);
  if (stale.length > 0) {
    options.detach(async () => {
      await Promise.all(stale.map(options.refresh));
    });
  }
  return snapshots.map((entry) => entry.value);
}
