import { describeError } from "./linear/errors.js";

/**
 * The fix for a specific incident, not a hygiene wrapper.
 *
 * On reload the host aborts background services, runs dispose hooks, drains
 * in-flight handlers and then **invalidates the `bb` handle**. Any `bb.*`
 * touch after that throws `PluginContextStaleError` — and from a detached
 * continuation (a timer, a promise tail, an HTTP callback) Node raises that as
 * an `uncaughtException`, which takes down **the whole bb server**, not just
 * this plugin.
 *
 * The part that makes it vicious: `bb.log` throws once stale too, *including
 * from inside the `catch` that was containing the original failure*. So the
 * containment itself becomes the crash. Which means a guard has to do three
 * things, and doing two is the same as doing none:
 *
 *   1. Check a `disposed` flag set **first** in `onDispose`, before any await.
 *   2. Swallow everything, including whatever the logging attempt throws.
 *   3. Never hand a rejected promise back to a caller that will not await it.
 *
 * Every `bb.*` call reachable from a timer, a promise continuation or an HTTP
 * callback goes through here.
 */

export type LifetimeLogLevel = "debug" | "info" | "warn" | "error";

export interface Lifetime {
  /** True from the moment dispose begins. Read it before doing anything with
   *  a host handle, including inside a `catch`. */
  readonly disposed: boolean;
  /** Aborts when the plugin is disposed. Pass it to every fetch, sleep and
   *  service loop so nothing outlives the load that created it. */
  readonly signal: AbortSignal;
  /** Run host-touching work, returning `fallback` if the plugin is gone or the
   *  work throws. Never throws. */
  run<T>(label: string, fn: () => T, fallback: T): T;
  run(label: string, fn: () => void): void;
  /** The async form. Resolves rather than rejects, always — an unawaited
   *  rejection from a detached continuation is the exact shape of the crash
   *  this module exists to prevent. */
  runAsync<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T>;
  runAsync(label: string, fn: () => Promise<void>): Promise<void>;
  /** Fire-and-forget: schedules `fn` and guarantees nothing escapes. Use for
   *  work started from a handler that must not make the caller wait. */
  detach(label: string, fn: () => Promise<void>): void;
  log(level: LifetimeLogLevel, message: string): void;
  dispose(): void;
}

export interface LifetimeHost {
  log(level: LifetimeLogLevel, message: string): void;
}

/**
 * `PluginContextStaleError` is matched by name rather than imported, exactly
 * as `NeedsConfigurationError` is: the class is not part of the SDK's public
 * runtime surface, and a plugin that imports it to compare against gains
 * nothing over reading the name it was given.
 */
function isStaleHandleError(value: unknown): boolean {
  return (
    value instanceof Error &&
    (value.name === "PluginContextStaleError" ||
      value.message.includes("PluginContextStaleError"))
  );
}

export function createLifetime(host: LifetimeHost): Lifetime {
  let disposed = false;
  const controller = new AbortController();

  function log(level: LifetimeLogLevel, message: string): void {
    if (disposed) return;
    try {
      host.log(level, message);
    } catch {
      // Swallowed on purpose and without a second attempt. There is nowhere
      // left to report to: the handle that would carry the report is the one
      // that just failed.
    }
  }

  function handle(label: string, error: unknown): void {
    if (disposed || isStaleHandleError(error)) return;
    log("warn", `${label}: ${describeError(error)}`);
  }

  function run<T>(label: string, fn: () => T, fallback?: T): T | undefined {
    if (disposed) return fallback;
    try {
      return fn();
    } catch (error) {
      handle(label, error);
      return fallback;
    }
  }

  async function runAsync<T>(
    label: string,
    fn: () => Promise<T>,
    fallback?: T,
  ): Promise<T | undefined> {
    if (disposed) return fallback;
    try {
      const value = await fn();
      // The await is the dangerous part: the plugin can be disposed while the
      // promise is pending, so the check has to happen again on the far side.
      return disposed ? fallback : value;
    } catch (error) {
      handle(label, error);
      return fallback;
    }
  }

  return {
    get disposed() {
      return disposed;
    },
    signal: controller.signal,
    run: run as Lifetime["run"],
    runAsync: runAsync as Lifetime["runAsync"],
    detach(label, fn) {
      void runAsync(label, fn, undefined);
    },
    log,
    dispose() {
      // Flag first, abort second. Anything already inside a `run` sees the
      // flag on its way out; anything waiting on the signal wakes up to find
      // the flag already set.
      disposed = true;
      controller.abort();
    },
  };
}

/**
 * Sleep that wakes early when the plugin goes away, and never leaves a timer
 * behind. A service loop that sleeps on a bare `setTimeout` keeps the process
 * alive past a reload and then resumes into a dead handle.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
