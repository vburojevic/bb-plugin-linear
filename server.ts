// bb-plugin-linear — backend entry. Wiring only: every behavior lives in a
// pure module under src/ where a test can reach it without a host.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { createAccounts, type Accounts } from "./src/accounts.js";
import { runCli } from "./src/cli.js";
import { describeError } from "./src/linear/errors.js";
import { forgetSecrets } from "./src/linear/errors.js";
import { SETTING_DESCRIPTORS, type LinearSettings } from "./src/settings.js";

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      accounts: z.array(
        z.object({
          slot: z.number(),
          orgName: z.string().nullable(),
          orgUrlKey: z.string().nullable(),
          displayName: z.string().nullable(),
          email: z.string().nullable(),
          error: z.string().nullable(),
        }),
      ),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTING_DESCRIPTORS);

  const lifetime = new AbortController();
  bb.onDispose(() => {
    lifetime.abort();
    forgetSecrets();
  });

  const accounts: Accounts = createAccounts({
    getSettings: (): Promise<LinearSettings> => settings.get(),
    log: (level, message) => bb.log[level](message),
    signal: lifetime.signal,
  });

  // Unconfigured is a described state, not an error: the plugin loads, the
  // settings form renders, and the first saved key auto-retries the load.
  const initial = await settings.get();
  const hasAnyKey = [
    initial.apiKey,
    initial.apiKey2,
    initial.apiKey3,
    initial.apiKey4,
  ].some((value) => (value ?? "").trim() !== "");
  if (!hasAnyKey) {
    bb.status.needsConfiguration(
      "Add your Linear API key in this plugin's settings, or run: bb plugin config linear set apiKey <key>",
    );
  }

  bb.rpc.register(rpcContract, {
    async status() {
      const configured = await accounts.configuredSlots();
      const rows = [];
      for (const slot of configured) {
        try {
          // Cached unless the key changed — a settings page render must not
          // spend a Linear request per paint.
          const identity = await accounts.identity(slot);
          rows.push({
            slot,
            orgName: identity.orgName,
            orgUrlKey: identity.orgUrlKey,
            displayName: identity.displayName,
            email: identity.email,
            error: null,
          });
        } catch (error) {
          rows.push({
            slot,
            orgName: null,
            orgUrlKey: null,
            displayName: null,
            email: null,
            error: describeError(error),
          });
        }
      }
      return { configured: configured.length > 0, accounts: rows };
    },
  });

  bb.cli.register({
    name: "linear",
    summary: "Linear issues, accounts and diagnostics",
    commands: [
      {
        name: "doctor",
        summary: "Connection, identity and budget, per key slot",
        usage: "bb linear doctor",
      },
      {
        name: "accounts",
        summary: "The configured accounts, one line each",
        usage: "bb linear accounts",
      },
      {
        name: "create",
        summary: "Create an issue",
        usage:
          "bb linear create --team <key-or-name> --title <title> [--description <markdown>] [--account <slot>]",
      },
    ],
    run: (argv) => runCli(argv, { accounts }),
  });
}
