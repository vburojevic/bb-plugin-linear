import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations.js";
import { createStore } from "../src/store/store.js";

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

  it("fails closed when upgrading ambiguous vocabulary from multiple workspaces", () => {
    const vocabularyStart = MIGRATIONS.findIndex((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS workspace_label"),
    );
    expect(vocabularyStart).toBeGreaterThan(0);

    const db = new Database(":memory:");
    for (const statement of MIGRATIONS.slice(0, vocabularyStart)) db.prepare(statement).run();
    const insertWorkspace = db.prepare(
      `INSERT INTO workspace
        (id, name, url_key, viewer_id, viewer_name, git_branch_format, fetched_at, slot)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?)`,
    );
    insertWorkspace.run("ws_p", "Personal", "p", "u_p", "Personal Me", "apiKey");
    insertWorkspace.run("ws_c", "Company", "c", "u_c", "Company Me", "apiKey2");
    db.prepare(
      `INSERT INTO team (id, key, name, fetched_at, workspace_id)
       VALUES ('team_p', 'PER', 'Personal team', 1, 'ws_p'),
              ('team_c', 'COM', 'Company team', 1, 'ws_c')`,
    ).run();
    db.prepare(
      `INSERT INTO label (id, team_id, name)
       VALUES ('label_team', 'team_p', 'Personal team label'),
              ('label_unknown', NULL, 'Unknown workspace label')`,
    ).run();
    db.prepare(
      `INSERT INTO member (id, name, display_name, is_me)
       VALUES ('u_p', 'Personal Me', 'Personal Me', 1),
              ('u_c', 'Company Me', 'Company Me', 1),
              ('u_member', 'Personal Member', 'Personal Member', 0)`,
    ).run();
    db.prepare(`INSERT INTO team_member (team_id, user_id) VALUES ('team_p', 'u_member')`).run();
    db.prepare(
      `INSERT INTO project_status (id, name, type) VALUES ('status_unknown', 'Unknown status', 'started')`,
    ).run();
    db.prepare(
      `INSERT INTO priority_value (priority, label) VALUES (1, 'Unknown urgent')`,
    ).run();

    for (const statement of MIGRATIONS.slice(vocabularyStart)) db.prepare(statement).run();
    const store = createStore(db);

    expect(store.labels(["team_p"]).map((row) => row.id)).toEqual(["label_team"]);
    expect(store.labels([])).toEqual([]);
    expect(store.members(["team_p"]).map((row) => row.id).sort()).toEqual(["u_member", "u_p"]);
    expect(store.members(["team_c"]).map((row) => row.id)).toEqual(["u_c"]);
    expect(store.projectStatuses(["team_p"])).toEqual([]);
    expect(store.priorityValues(["team_p"])).toEqual([]);
  });

  it("does not attribute an unknown legacy inbox team to the primary workspace", () => {
    const inboxOwnershipStart = MIGRATIONS.findIndex((statement) =>
      statement.includes("ALTER TABLE inbox ADD COLUMN workspace_id"),
    );
    expect(inboxOwnershipStart).toBeGreaterThan(0);

    const db = new Database(":memory:");
    for (const statement of MIGRATIONS.slice(0, inboxOwnershipStart)) {
      db.prepare(statement).run();
    }
    const insertWorkspace = db.prepare(
      `INSERT INTO workspace
        (id, name, url_key, viewer_id, viewer_name, git_branch_format, fetched_at, slot)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?)`,
    );
    insertWorkspace.run("ws_p", "Personal", "p", "u_p", "Personal Me", "apiKey");
    insertWorkspace.run("ws_c", "Company", "c", "u_c", "Company Me", "apiKey2");
    db.prepare(
      `INSERT INTO team (id, key, name, fetched_at, workspace_id)
       VALUES ('team_legacy', 'OLD', 'Legacy primary team', 1, NULL),
              ('team_company', 'COM', 'Company team', 1, 'ws_c')`,
    ).run();
    const insertInbox = db.prepare(
      `INSERT INTO inbox
        (key, kind, issue_id, team_id, actor_id, title, body, url, created_at,
         seen_at, dismissed_at, linear_read_at)
       VALUES (?, 'other', NULL, ?, NULL, ?, ?, NULL, 1, NULL, NULL, NULL)`,
    );
    insertInbox.run("known-primary", "team_legacy", "known primary", "keep");
    insertInbox.run("known-company", "team_company", "known company", "keep");
    insertInbox.run("unknown-team", "team_missing", "unknown team", "discard");
    insertInbox.run("teamless", null, "teamless unknown", "discard");

    for (const statement of MIGRATIONS.slice(inboxOwnershipStart)) {
      db.prepare(statement).run();
    }

    expect(
      db.prepare(`SELECT key, workspace_id AS workspaceId FROM inbox ORDER BY key`).all(),
    ).toEqual([
      { key: "ws_c:known-company", workspaceId: "ws_c" },
      { key: "ws_p:known-primary", workspaceId: "ws_p" },
    ]);
  });

  it("discards ownerless legacy inbox rows even when only one workspace was recorded", () => {
    const inboxOwnershipStart = MIGRATIONS.findIndex((statement) =>
      statement.includes("ALTER TABLE inbox ADD COLUMN workspace_id"),
    );
    expect(inboxOwnershipStart).toBeGreaterThan(0);

    const db = new Database(":memory:");
    for (const statement of MIGRATIONS.slice(0, inboxOwnershipStart)) {
      db.prepare(statement).run();
    }
    db.prepare(
      `INSERT INTO workspace
        (id, name, url_key, viewer_id, viewer_name, git_branch_format, fetched_at, slot)
       VALUES ('ws_p', 'Personal', 'p', 'u_p', 'Personal Me', NULL, 1, 'apiKey')`,
    ).run();
    const insertInbox = db.prepare(
      `INSERT INTO inbox
        (key, kind, issue_id, team_id, actor_id, title, body, url, created_at,
         seen_at, dismissed_at, linear_read_at)
       VALUES (?, 'other', NULL, ?, NULL, ?, ?, NULL, 1, NULL, NULL, NULL)`,
    );
    insertInbox.run("unknown-team", "team_missing", "unknown team", "discard");
    insertInbox.run("teamless", null, "teamless unknown", "discard");

    for (const statement of MIGRATIONS.slice(inboxOwnershipStart)) {
      db.prepare(statement).run();
    }

    expect(db.prepare(`SELECT key, workspace_id FROM inbox`).all()).toEqual([]);
  });
});
