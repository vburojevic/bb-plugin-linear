/**
 * The rpc surface this plugin currently ships.
 *
 * Deliberately slim: the old panel's 24-method contract was cut with the
 * panel, and each new surface (M3 header chip + side panel, M4 nav panel,
 * M5 inbox) adds its methods here as it lands — schema-first, so the wire
 * boundary is validated in both directions from day one.
 */

import { z } from "zod";
import { defineRpcContract } from "./sdk-runtime.js";

export const serverRpcContract = defineRpcContract({
  /** The settings card and homepage section: who is connected, per slot. */
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      accounts: z.array(
        z.object({
          slot: z.string(),
          label: z.string(),
          orgName: z.string().nullable(),
          orgUrlKey: z.string().nullable(),
          displayName: z.string().nullable(),
          error: z.string().nullable(),
        }),
      ),
    }),
  },
});
