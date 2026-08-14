import { beforeEach } from "vitest";
import { forgetSecrets } from "../src/linear/errors.js";

/**
 * No test may open a socket.
 *
 * CI has no Linear workspace, so a test that reaches the network is a test
 * that is either flaky or lying. Replacing `fetch` with a thrower means a
 * missing injection fails with a sentence naming the problem instead of
 * hanging for twenty seconds and then failing with `ECONNREFUSED`.
 */
globalThis.fetch = (() => {
  throw new Error(
    "A test tried to call fetch(). Inject a fake transport instead — nothing in this suite may reach the network.",
  );
}) as unknown as typeof fetch;

/**
 * Redaction keeps a module-level set of live secrets, which is correct for the
 * plugin (a stale entry can only over-redact) and wrong for a test suite,
 * where one test's key would silently rewrite another's assertions.
 */
beforeEach(() => {
  forgetSecrets();
});
