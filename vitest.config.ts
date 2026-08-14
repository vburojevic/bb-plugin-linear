import { defineConfig } from "vitest/config";

/**
 * The whole suite is pure Node. Every surface this plugin draws is a switch
 * over a pure projection in `src/select/*`, so the interesting assertions are
 * about data, not about DOM — and a jsdom default would only hide that.
 *
 * `test/setup.ts` replaces `globalThis.fetch` with a thrower, so a test that
 * accidentally reaches the network fails loudly instead of depending on a
 * Linear workspace CI does not have.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // The SDL is 1.3 MB and `validate:documents` parses it once per file that
    // asks for it. Everything else is milliseconds.
    testTimeout: 30_000,
  },
});
