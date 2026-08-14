import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level tripwires for properties the security audit verified by hand.
 *
 * These existed as comment-claims ("a test greps src/", "a CI grep asserts")
 * without the test — which means they held by review, the one enforcement
 * mechanism that degrades silently. Each check below names its threat, so a
 * legitimate future change knows what it must preserve when it updates the
 * allow-list rather than deleting the check.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const serverFiles = [...walk(join(root, "src")), join(root, "server.ts")];
const appFiles = [...walk(join(root, "app")), join(root, "app.tsx")];

function relative(path: string): string {
  return path.slice(root.length);
}

describe("network egress census", () => {
  it("src/ has exactly the two sanctioned fetch call sites", () => {
    // Every Linear request must pass the transport (where the credential,
    // the budget, the breaker and the write-consent gate live); the webhook
    // self-test POSTs a signed nonce to the user's own URL. A third fetch is
    // a path around all four protections.
    const sanctioned = new Set(["src/linear/transport.ts", "src/webhook-register.ts"]);
    const callers = serverFiles
      .filter((path) => /\bfetch\s*\(|globalThis\.fetch/.test(readFileSync(path, "utf8")))
      .map(relative);
    expect(callers.sort()).toEqual([...sanctioned].sort());
  });

  it("the frontend fetches nothing itself", () => {
    // App surfaces speak rpc to this plugin's backend and nothing else; a
    // frontend fetch would bypass redaction, budget and consent entirely.
    const callers = appFiles
      .filter((path) => /\bfetch\s*\(/.test(readFileSync(path, "utf8")))
      .map(relative);
    expect(callers).toEqual([]);
  });
});

describe("forbidden APIs", () => {
  const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
    {
      pattern: /\bchild_process\b|\bexecSync\b|\bspawnSync\b/,
      why: "no shell, ever — model-controlled text must have no path to a process",
    },
    {
      pattern: /\beval\s*\(|\bnew Function\s*\(/,
      why: "no dynamic code",
    },
    {
      pattern: /dangerouslySetInnerHTML/,
      why: "remote markdown renders only through the host Markdown component",
    },
    {
      // The call shape, not the word — the word appears in the settings
      // module's own documentation of this exact incident.
      pattern: /\.updateSettings\s*\(/,
      why: "a plugin saving its own settings deadlocks the host's dispose cycle (documented incident)",
    },
    {
      pattern: /\bconsole\.(log|error|warn|info|debug)\b/,
      why: "the one log sink is bb.log, which re-redacts",
    },
  ];

  for (const { pattern, why } of FORBIDDEN) {
    it(`${String(pattern)} appears nowhere — ${why}`, () => {
      const offenders = [...serverFiles, ...appFiles]
        .filter((path) => pattern.test(readFileSync(path, "utf8")))
        .map(relative);
      expect(offenders).toEqual([]);
    });
  }
});

describe("secret-shaped literals", () => {
  it("no real-looking Linear key appears outside test fixtures", () => {
    // Fixtures are deliberately fake (lin_api_TESTKEY...); anything in src/
    // or app/ that matches the real shape is a paste accident.
    const offenders = [...serverFiles, ...appFiles]
      .filter((path) => /lin_api_(?!TESTKEY)[A-Za-z0-9]{16,}/.test(readFileSync(path, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);
  });
});
