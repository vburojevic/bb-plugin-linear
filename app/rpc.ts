import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { serverRpcContract } from "../src/rpc.js";

type LinearRpcContract = typeof serverRpcContract;

/**
 * The one typed rpc hook, and the one loading discipline every surface uses.
 *
 * `useLinearRpc` exists so the contract type is imported once rather than in
 * every component — a type-only import, so the backend module and everything
 * it pulls in are erased from the frontend bundle.
 */
export function useLinearRpc() {
  return useRpc<LinearRpcContract>();
}

export type AsyncState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T; readonly refreshing: boolean }
  | { readonly status: "failed"; readonly message: string };

/**
 * Fetch-on-mount with one property that matters more than the rest: **a
 * refresh never drops back to `loading`.**
 *
 * Once a surface has data it keeps rendering it, and the refresh is a flag on
 * top rather than a state that replaces it. A spinner over data you already
 * have is a lie about what you know — and with a ten-second poller underneath,
 * a surface that blanked on every refresh would spend more time empty than
 * populated.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  // The latest loader, so the effect can depend on `deps` rather than on a
  // function identity that changes every render.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((current) =>
      current.status === "ready" ? { ...current, refreshing: true } : current,
    );
    void loadRef
      .current(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setState({ status: "ready", value, refreshing: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : "Something went wrong.",
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, reload };
}
