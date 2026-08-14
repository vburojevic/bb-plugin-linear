/**
 * The two runtime values this plugin needs from `@bb/plugin-sdk`, vendored.
 *
 * `@bb/plugin-sdk` is not published to npm, and it is correctly not a
 * dependency here: the vendored `types/*.d.ts` cover every type-only import
 * through tsconfig `paths`, and those erase at build. But `defineRpcContract`
 * and `PLUGIN_CLI_OUTPUT_MAX_BYTES` are *runtime* exports, and vitest does not
 * read tsconfig `paths` — so importing them from the package makes a clean
 * `npm ci && npm test` on a fork fail at module resolution, in every test that
 * transitively touches the rpc contract. Which is most of them.
 *
 * Vendoring two values is the smaller cost. `bb plugin build` keeps
 * `@bb/plugin-sdk` external anyway, so nothing about the shipped bundle
 * changes; what changes is that the test suite resolves without the SDK
 * present, which is the whole point of the offline verification plan.
 */

/**
 * Identity at runtime. The host validates rpc traffic against the contract's
 * Standard Schema values, not against this wrapper — the wrapper exists to
 * pin the generic so `useRpc<typeof contract>()` can infer method names,
 * inputs and results on the frontend.
 */
export const defineRpcContract = <T>(contract: T): T => contract;

/**
 * Mirrors `packages/plugin-sdk/src/backend-contract.ts` (1024 * 1024). The
 * host rejects an oversize CLI result *atomically* — it never clips — so
 * every command pages or caps well under this rather than discovering the
 * ceiling in production.
 */
export const PLUGIN_CLI_OUTPUT_MAX_BYTES = 1_048_576;
