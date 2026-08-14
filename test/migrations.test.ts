import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations.js";

/**
 * The shipped migration prefix is frozen, byte for byte.
 *
 * `bb.storage.migrate` uses the **statement index as the migration id**.
 * Editing statement 3 in a later release does not re-run it — it silently
 * skips it on every existing install, so a column added by an edit exists on
 * fresh installs and nowhere else. The symptom is a `no such column` from a
 * query that works perfectly on the author's machine, reported by a user whose
 * database is a version the author never had.
 *
 * So each statement's hash is recorded. Appending is normal and updating the
 * snapshot is a one-command chore; *changing* an existing hash is the thing
 * this test exists to make impossible to do by accident.
 *
 *     UPDATE_MIGRATION_SNAPSHOT=1 npx vitest run test/migrations.test.ts
 *
 * Run that only after appending. If it rewrites a line rather than adding one,
 * a shipped migration has been edited and the change must be reverted and
 * re-expressed as a new statement.
 */

const snapshotPath = fileURLToPath(new URL("./migrations.snapshot.json", import.meta.url));

function hash(statement: string): string {
  return createHash("sha256").update(statement).digest("hex").slice(0, 16);
}

interface Snapshot {
  readonly note: string;
  readonly hashes: string[];
}

describe("migrations", () => {
  const current = MIGRATIONS.map(hash);

  if (process.env["UPDATE_MIGRATION_SNAPSHOT"] === "1" || !existsSync(snapshotPath)) {
    it("writes the snapshot", () => {
      const snapshot: Snapshot = {
        note: "Append-only. A CHANGED line means a shipped migration was edited — revert it and add a new statement instead.",
        hashes: current,
      };
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      expect(current.length).toBeGreaterThan(0);
    });
    return;
  }

  const recorded = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;

  it("has not edited a shipped statement", () => {
    const overlap = Math.min(recorded.hashes.length, current.length);
    expect(current.slice(0, overlap)).toEqual(recorded.hashes.slice(0, overlap));
  });

  it("has not deleted or reordered a shipped statement", () => {
    // A migration that vanishes shifts every id after it by one, which
    // re-runs statements that already ran and skips ones that did not.
    expect(current.length).toBeGreaterThanOrEqual(recorded.hashes.length);
  });

  it("is additive only", () => {
    // bb rolls a failed activation back to the previous plugin version, which
    // then runs *old code against the new schema*. A dropped column or table
    // takes that rollback down with it; an added one is simply ignored by the
    // older code.
    const destructive = MIGRATIONS.filter((statement) =>
      /\b(DROP\s+(TABLE|COLUMN|INDEX)|ALTER\s+TABLE\s+\S+\s+RENAME)\b/i.test(statement),
    );
    expect(destructive).toEqual([]);
  });

  it("creates every table and index idempotently", () => {
    // The host runs unapplied statements in one transaction. `IF NOT EXISTS`
    // is what keeps a partially-applied history — an install that crashed
    // mid-migration — recoverable rather than permanently stuck.
    const creates = MIGRATIONS.filter((statement) => /^\s*CREATE\b/i.test(statement));
    const missing = creates.filter((statement) => !/IF NOT EXISTS/i.test(statement));
    expect(missing).toEqual([]);
  });

  it("ships the FTS triggers alongside the virtual tables that need them", () => {
    // An external-content FTS5 table without its triggers is a search surface
    // that silently returns nothing. Pairing them here means a future virtual
    // table cannot be added without them.
    const virtualTables = MIGRATIONS.filter((s) => /CREATE VIRTUAL TABLE/i.test(s));
    for (const statement of virtualTables) {
      const name = /CREATE VIRTUAL TABLE IF NOT EXISTS (\w+)/i.exec(statement)?.[1];
      expect(name, statement).toBeDefined();
      for (const suffix of ["ai", "ad", "au"]) {
        expect(
          MIGRATIONS.some((other) => other.includes(`${name}_${suffix}`)),
          `${name} is missing its ${suffix} trigger`,
        ).toBe(true);
      }
    }
  });
});
