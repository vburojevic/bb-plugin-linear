// bb-plugin-linear — a BB plugin backend entry.
//
// The default export is a factory that receives the plugin API. BB supplies
// the tiny defineRpcContract runtime helper; the API type remains type-only.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  greeting: {
    input: z.null(),
    output: z.object({ greeting: z.string(), loadCount: z.number().int() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Declarative settings — rendered in BB's settings UI and editable with
  // `bb plugin config linear`. Add `secret: true` for values like API keys.
  const settings = bb.settings.define({
    greeting: { type: "string", label: "Greeting", default: "hello" },
  });
  const { greeting } = await settings.get();

  // Namespaced key-value storage in bb.db (JSON values, up to 256KB each).
  // For bigger or relational data use bb.storage.database().
  const loadCount = ((await bb.storage.kv.get<number>("load-count")) ?? 0) + 1;
  await bb.storage.kv.set("load-count", loadCount);
  bb.log.info(`${greeting} — load #${loadCount}`);

  // Both schemas run at the wire boundary. Handler input/output are inferred
  // from the shared contract; app.tsx imports only its type.
  bb.rpc.register(rpcContract, {
    greeting: () => ({ greeting, loadCount }),
  });

  // Cleanup on reload/disable/shutdown; hooks run LIFO. The sanctioned place
  // to clear timers and close connections.
  bb.onDispose(() => {
    bb.log.info("disposed");
  });

  // Long-lived background work: starts after load, gets an AbortSignal on
  // reload/disable/shutdown, and restarts with backoff if it crashes. Sleeps
  // must wake on abort — a plain setTimeout sleeps through the stop window
  // and the plugin reports "degraded (service did not stop)" on reload.
  // bb.background.service("worker", {
  //   async start(signal) {
  //     while (!signal.aborted) {
  //       await new Promise((resolve) => {
  //         const timer = setTimeout(resolve, 60_000);
  //         signal.addEventListener(
  //           "abort",
  //           () => { clearTimeout(timer); resolve(undefined); },
  //           { once: true },
  //         );
  //       });
  //     }
  //   },
  // });
}
