/**
 * The local mirror's schema, as an append-only list of statements.
 *
 * `bb.storage.migrate` uses the **statement index as the migration id**.
 * Editing statement 3 in a later release does not re-run it — it silently
 * skips it on every existing install, so a column added by an edit exists on
 * fresh installs and nowhere else, and the failure surfaces as a `no such
 * column` from a query that works perfectly on the author's machine.
 * `test/migrations.test.ts` hashes every shipped statement and fails on any
 * change to one, which turns that rule from a comment into a gate.
 *
 * Migrations are also **additive only**. bb rolls a failed activation back to
 * the previous plugin version, which then runs *old code against the new
 * schema*. A dropped column takes the rollback down with it; an added one is
 * simply ignored by the older code.
 *
 * Two conventions hold throughout:
 *
 * **Every timestamp is epoch milliseconds, stored as an integer.** Parsed once
 * at the transport boundary and never again — `Intl` is applied at render and
 * the result is never read back.
 *
 * **Except `due_date` and `target_date`, which stay `YYYY-MM-DD` strings.**
 * They are Linear's `TimelessDate`: calendar facts, not instants. Converting
 * one to epoch picks a timezone on the user's behalf and is wrong by exactly
 * one day for half the planet.
 *
 * Keys are Linear UUIDs everywhere. `identifier` is display only — an issue
 * moved between teams changes identifier, which is why
 * `Issue.previousIdentifiers` exists and why `issue_previous_identifier` does.
 */
export const MIGRATIONS: string[] = [
  /* ── Identity ──────────────────────────────────────────────────────────── */

  `CREATE TABLE IF NOT EXISTS workspace (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     url_key TEXT NOT NULL,
     viewer_id TEXT NOT NULL,
     viewer_name TEXT NOT NULL,
     git_branch_format TEXT,
     fetched_at INTEGER NOT NULL
   )`,

  /* ── The slow-moving graph ─────────────────────────────────────────────── */

  `CREATE TABLE IF NOT EXISTS team (
     id TEXT PRIMARY KEY,
     key TEXT NOT NULL,
     name TEXT NOT NULL,
     icon TEXT,
     color TEXT,
     parent_id TEXT,
     estimation_type TEXT NOT NULL DEFAULT 'notUsed',
     estimation_allow_zero INTEGER NOT NULL DEFAULT 0,
     estimation_extended INTEGER NOT NULL DEFAULT 0,
     default_estimate REAL NOT NULL DEFAULT 0,
     cycles_enabled INTEGER NOT NULL DEFAULT 0,
     triage_enabled INTEGER NOT NULL DEFAULT 0,
     active_cycle_id TEXT,
     updated_at INTEGER,
     fetched_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS workflow_state (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     color TEXT,
     position REAL NOT NULL DEFAULT 0,
     description TEXT
   )`,

  // States are read as "this team's states, grouped by type, in position
  // order" on every render of a state selector and every grouping of the
  // list. That is the index.
  `CREATE INDEX IF NOT EXISTS workflow_state_by_team
     ON workflow_state (team_id, type, position)`,

  `CREATE TABLE IF NOT EXISTS label (
     id TEXT PRIMARY KEY,
     team_id TEXT,
     name TEXT NOT NULL,
     color TEXT,
     parent_id TEXT,
     is_group INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER
   )`,

  // `team_id IS NULL` means a **workspace-level** label, not an orphaned one.
  // The same is true of `Template.team`. Every label picker merges both.
  `CREATE INDEX IF NOT EXISTS label_by_team ON label (team_id, name)`,

  `CREATE TABLE IF NOT EXISTS member (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     display_name TEXT NOT NULL,
     email TEXT,
     avatar_url TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     is_app INTEGER NOT NULL DEFAULT 0,
     is_me INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER
   )`,

  // Project statuses are **workspace-level** (`Organization.projectStatuses`),
  // while issue workflow states are team-level. The two look symmetrical and
  // are scoped differently, which is exactly why they are separate tables
  // rather than one with a nullable team.
  `CREATE TABLE IF NOT EXISTS project_status (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     position REAL NOT NULL DEFAULT 0,
     color TEXT
   )`,

  // Fetched once so priority labels are the workspace's own strings — in the
  // workspace's own language — rather than five English constants compiled
  // into a plugin.
  `CREATE TABLE IF NOT EXISTS priority_value (
     priority INTEGER PRIMARY KEY,
     label TEXT NOT NULL
   )`,

  /* ── Issues ────────────────────────────────────────────────────────────── */

  `CREATE TABLE IF NOT EXISTS issue (
     id TEXT PRIMARY KEY,
     identifier TEXT NOT NULL,
     number REAL NOT NULL DEFAULT 0,
     team_id TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT,
     url TEXT,
     branch_name TEXT,
     priority INTEGER NOT NULL DEFAULT 0,
     estimate REAL,
     state_id TEXT,
     assignee_id TEXT,
     creator_id TEXT,
     project_id TEXT,
     milestone_id TEXT,
     cycle_id TEXT,
     parent_id TEXT,
     due_date TEXT,
     sort_order REAL NOT NULL DEFAULT 0,
     sub_issue_sort_order REAL,
     label_ids TEXT NOT NULL DEFAULT '[]',
     started_at INTEGER,
     completed_at INTEGER,
     canceled_at INTEGER,
     triaged_at INTEGER,
     archived_at INTEGER,
     created_at INTEGER,
     updated_at INTEGER NOT NULL DEFAULT 0,
     synced_at INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE INDEX IF NOT EXISTS issue_by_team ON issue (team_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS issue_by_identifier ON issue (identifier)`,
  // The branch lookup runs on every thread that has an environment, so it is
  // worth an index even though most rows have no branch of their own.
  `CREATE INDEX IF NOT EXISTS issue_by_branch ON issue (branch_name)`,
  `CREATE INDEX IF NOT EXISTS issue_by_assignee ON issue (assignee_id, team_id)`,

  // An issue moved between teams changes identifier. Without this, a link
  // written last month resolves to nothing and the user is told the issue does
  // not exist.
  `CREATE TABLE IF NOT EXISTS issue_previous_identifier (
     identifier TEXT PRIMARY KEY,
     issue_id TEXT NOT NULL
   )`,

  /* ── Search ────────────────────────────────────────────────────────────── */

  // External-content FTS5: the index stores no copy of the text, it points at
  // `issue`. SQLite does **not** maintain that link for you.
  `CREATE VIRTUAL TABLE IF NOT EXISTS issue_fts USING fts5(
     identifier, title, description,
     content='issue', content_rowid='rowid', tokenize='unicode61'
   )`,

  // Without these three triggers every search returns zero rows and the whole
  // search surface dies silently — no error, no empty-state, just nothing
  // found, forever. A test inserts an issue through `apply.ts` and finds it
  // through FTS, so an upsert path that bypasses the triggers fails.
  `CREATE TRIGGER IF NOT EXISTS issue_fts_ai AFTER INSERT ON issue BEGIN
     INSERT INTO issue_fts(rowid, identifier, title, description)
     VALUES (new.rowid, new.identifier, new.title, new.description);
   END`,
  `CREATE TRIGGER IF NOT EXISTS issue_fts_ad AFTER DELETE ON issue BEGIN
     INSERT INTO issue_fts(issue_fts, rowid, identifier, title, description)
     VALUES ('delete', old.rowid, old.identifier, old.title, old.description);
   END`,
  `CREATE TRIGGER IF NOT EXISTS issue_fts_au AFTER UPDATE ON issue BEGIN
     INSERT INTO issue_fts(issue_fts, rowid, identifier, title, description)
     VALUES ('delete', old.rowid, old.identifier, old.title, old.description);
     INSERT INTO issue_fts(rowid, identifier, title, description)
     VALUES (new.rowid, new.identifier, new.title, new.description);
   END`,

  /* ── Plugin state ──────────────────────────────────────────────────────── */

  // A bb project binds to exactly one **primary** Linear team plus zero or
  // more additional teams, each marked write or read. Unqualified work goes to
  // the primary; anything else must name its team and is allowed only if that
  // team is in the write set.
  `CREATE TABLE IF NOT EXISTS binding (
     project_id TEXT NOT NULL,
     team_id TEXT NOT NULL,
     role TEXT NOT NULL,
     bound_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, team_id)
   )`,

  // "Exactly one primary" enforced by the database rather than by every code
  // path that writes a binding. A partial unique index is the cheapest way to
  // make an invariant impossible to violate rather than merely uncommon.
  `CREATE UNIQUE INDEX IF NOT EXISTS binding_primary
     ON binding (project_id) WHERE role = 'primary'`,

  /* ── M3: one issue, read and written ───────────────────────────────────── */

  `CREATE TABLE IF NOT EXISTS comment (
     id TEXT PRIMARY KEY,
     issue_id TEXT NOT NULL,
     user_id TEXT,
     parent_id TEXT,
     body TEXT NOT NULL,
     url TEXT,
     created_at INTEGER,
     updated_at INTEGER NOT NULL DEFAULT 0,
     edited_at INTEGER,
     resolved_at INTEGER
   )`,

  `CREATE INDEX IF NOT EXISTS comment_by_issue ON comment (issue_id, created_at)`,

  /**
   * Echo suppression.
   *
   * Every local mutation returns the updated entity, and its `(id, updatedAt)`
   * is written here *before* the next tick can run — so the tick sees its own
   * write and stays silent. Without it, the plugin notifies the user about
   * every change the user just made, which is the fastest way to make a
   * notification stream worthless.
   *
   * Keyed on the pair rather than on the id, because the same entity is
   * written many times and only the specific version this plugin caused should
   * be suppressed. A later change by someone else carries a different
   * `updatedAt` and is reported normally.
   */
  `CREATE TABLE IF NOT EXISTS echo (
     entity_id TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (entity_id, updated_at)
   )`,

  `CREATE INDEX IF NOT EXISTS echo_by_age ON echo (recorded_at)`,

  /* ── M4: a thread started from an issue ────────────────────────────────── */

  /**
   * The link between a bb thread and a Linear issue.
   *
   * Written **before the spawn returns**, so the composer banner and the
   * thread header chip are correct on the thread's first paint rather than one
   * poll later.
   *
   * `origin` records who made the link — a spawn, a manual link, or a branch
   * that resolved to an issue — because the three deserve different confidence
   * and the branch one can be wrong.
   */
  `CREATE TABLE IF NOT EXISTS thread_link (
     thread_id TEXT PRIMARY KEY,
     issue_id TEXT NOT NULL,
     team_id TEXT NOT NULL,
     project_id TEXT,
     created_at INTEGER NOT NULL,
     origin TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS thread_link_by_issue ON thread_link (issue_id)`,

  /* ── M6: notifications ─────────────────────────────────────────────────── */

  /**
   * The durable half of the delivery ladder.
   *
   * Rung 1 always writes a row here and never fails, which is what makes rung
   * 2 (a push peer) and rung 3 (a foreground toast) safe to lose: the Inbox
   * segment is recomputed from Linear and can never miss anything, so only the
   * ephemeral push can be dropped.
   *
   * `seen_at` and `dismissed_at` are separate on purpose: opening the segment
   * marks rows seen, and a row stays until it is dismissed. **Seen is not
   * handled.**
   */
  `CREATE TABLE IF NOT EXISTS inbox (
     key TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     issue_id TEXT,
     team_id TEXT,
     actor_id TEXT,
     title TEXT NOT NULL,
     body TEXT,
     url TEXT,
     created_at INTEGER NOT NULL,
     seen_at INTEGER,
     dismissed_at INTEGER,
     linear_read_at INTEGER
   )`,

  `CREATE INDEX IF NOT EXISTS inbox_by_age ON inbox (created_at DESC)`,

  /**
   * Exactly-once across restarts, and the choice is deliberate.
   *
   * `INSERT OR IGNORE` then send only if `changes() === 1` is **claim then
   * send**, which is *at most once*: a crash between the claim and the send
   * loses one push. The rejected alternative — send then claim — is *at least
   * once*, and produces a duplicate buzz after every crash.
   *
   * Duplicates lose. The durable surface can never miss anything, so the only
   * thing at risk is the ephemeral push, and losing one push whose row is
   * still sitting unseen in the panel is strictly the better failure.
   */
  `CREATE TABLE IF NOT EXISTS delivered (
     key TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     claimed_at INTEGER NOT NULL,
     sent_at INTEGER
   )`,

  `CREATE INDEX IF NOT EXISTS delivered_by_age ON delivered (claimed_at)`,

  /* ── M7: pull-request transitions ──────────────────────────────────────── */

  /**
   * Linear's own configuration of exactly this automation, cached per team.
   *
   * `GitAutomationStates` is a real enum — `draft | merge | mergeable | review
   * | start` — so matching on `event` is safe in a way matching a state's name
   * is not. Reading this means the plugin matches a workspace's existing
   * behaviour on day one in a workspace it has never seen, with nothing
   * hardcoded.
   */
  `CREATE TABLE IF NOT EXISTS git_automation_state (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     event TEXT NOT NULL,
     state_id TEXT,
     state_name TEXT,
     target_branch_pattern TEXT,
     target_branch_is_regex INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE INDEX IF NOT EXISTS git_automation_by_team ON git_automation_state (team_id, event)`,

  /**
   * Which issue does this environment's branch belong to?
   *
   * `resolution` records **how** it was resolved, because the answers differ
   * in confidence: `linear` came from `issueVcsBranchSearch`, which
   * understands the workspace's own branch format; `regex` came from this
   * plugin's fallback and can be wrong; `none` is a negative cache with a TTL,
   * so a `main` checkout is not re-queried every tick forever.
   */
  `CREATE TABLE IF NOT EXISTS branch_link (
     environment_id TEXT PRIMARY KEY,
     branch_name TEXT NOT NULL,
     issue_id TEXT,
     resolution TEXT NOT NULL,
     resolved_at INTEGER NOT NULL
   )`,

  /**
   * What was applied, and for which pull-request state.
   *
   * Keyed on the pair rather than on the environment, so an *applied*
   * transition is never applied twice and a user who moves the issue back by
   * hand afterwards is not overruled on the next tick — while a genuinely new
   * pull-request state still transitions.
   */
  `CREATE TABLE IF NOT EXISTS pr_state (
     environment_id TEXT PRIMARY KEY,
     issue_id TEXT,
     pr_number INTEGER,
     pr_url TEXT,
     pr_state TEXT,
     pr_attention TEXT,
     applied_state_id TEXT,
     applied_at INTEGER,
     last_seen_at INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS pr_state_by_issue ON pr_state (issue_id)`,

  /**
   * One-shot host capability probes.
   *
   * bb's pull-request lookup is `gh pr view` and nothing else, so the
   * automation needs the GitHub CLI authenticated on the machine running bb
   * and does not fire on GitLab, Bitbucket, Gitea or Azure DevOps. The first
   * `unavailable` writes a row here; while it says this host has never once
   * produced an `available` lookup, the per-thread banner row is **not
   * rendered at all** and the fact appears in exactly two places instead — the
   * settings section and `bb linear doctor`.
   *
   * Otherwise a GitLab shop gets a permanent apology attached to every linked
   * thread. One successful lookup clears the probe forever.
   */
  `CREATE TABLE IF NOT EXISTS probe (
     key TEXT PRIMARY KEY,
     outcome TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,

  /* ── M8: breadth ───────────────────────────────────────────────────────── */

  /**
   * Projects are workspace-level and belong to many teams, which is why
   * `project_team` exists rather than a `team_id` column: filtering a team's
   * board by project has to include a project two teams share.
   *
   * `target_date` stays a `TimelessDate` string for the same reason `due_date`
   * does.
   */
  `CREATE TABLE IF NOT EXISTS project (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT,
     url TEXT,
     status_id TEXT,
     lead_id TEXT,
     start_date TEXT,
     target_date TEXT,
     progress REAL,
     updated_at INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS project_team (
     project_id TEXT NOT NULL,
     team_id TEXT NOT NULL,
     PRIMARY KEY (project_id, team_id)
   )`,

  `CREATE TABLE IF NOT EXISTS milestone (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     target_date TEXT,
     sort_order REAL NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL DEFAULT 0
   )`,

  /**
   * `is_active` / `is_next` / `is_previous` come from Linear rather than from
   * date arithmetic here. `Cycle.isActive` is Linear's own answer and it
   * accounts for the team's cycle configuration; comparing `startsAt` and
   * `endsAt` against the local clock reimplements that badly and disagrees
   * across a timezone.
   */
  `CREATE TABLE IF NOT EXISTS cycle (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     number REAL NOT NULL DEFAULT 0,
     name TEXT,
     starts_at INTEGER,
     ends_at INTEGER,
     is_active INTEGER NOT NULL DEFAULT 0,
     is_next INTEGER NOT NULL DEFAULT 0,
     is_previous INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE INDEX IF NOT EXISTS cycle_by_team ON cycle (team_id, is_active)`,

  /**
   * Relations, and the distinction the tool descriptions state plainly:
   * **sub-issues are not relations.** A parent/child link lives on
   * `issue.parent_id`; `blocks`, `related`, `duplicate` and `similar` live
   * here, and confusing the two produces a "blocked by" line pointing at a
   * sub-issue.
   */
  `CREATE TABLE IF NOT EXISTS relation (
     id TEXT PRIMARY KEY,
     issue_id TEXT NOT NULL,
     related_issue_id TEXT NOT NULL,
     type TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS relation_by_issue ON relation (issue_id, type)`,
  `CREATE INDEX IF NOT EXISTS relation_by_related ON relation (related_issue_id, type)`,

  /* ── M9: webhooks ──────────────────────────────────────────────────────── */

  /**
   * The webhook signing secret, which is deliberately **not** a setting.
   *
   * Every declared descriptor is rendered by the host's own form as an
   * editable field, and the descriptor schema is `.strict()` with no hidden or
   * read-only option — so a plugin-generated secret declared as a setting is a
   * field a user can overwrite and silently break delivery with.
   *
   * It lives here instead: server-local by nature, so the multi-machine rule
   * does not apply. If it is ever lost, `webhookRotateSecret(id:)` re-mints it
   * without deleting the webhook.
   */
  `CREATE TABLE IF NOT EXISTS local_secret (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  /* ── M13: more than one workspace ──────────────────────────────────────── */

  /**
   * Which settings slot's key found this workspace.
   *
   * A Linear personal API key is scoped to one workspace, so two workspaces
   * means two keys, and every request has to go out over the key that can
   * actually see its target. The slot is the join: workspace → slot → key.
   *
   * `DEFAULT 'apiKey'` is what makes this migration safe on an existing
   * install. The one workspace already in the table was found by the only key
   * that existed, which is exactly the primary slot.
   */
  `ALTER TABLE workspace ADD COLUMN slot TEXT NOT NULL DEFAULT 'apiKey'`,

  /**
   * Nullable rather than defaulted, and deliberately so.
   *
   * A team already in the table was read before this column existed, and there
   * is exactly one workspace it could have come from — but writing that guess
   * in as a default would make a wrong guess indistinguishable from a right
   * one. NULL means "not recorded yet", the next discovery fills it in, and
   * until then the team resolves through the primary slot, which is where it
   * came from.
   */
  `ALTER TABLE team ADD COLUMN workspace_id TEXT`,

  `CREATE INDEX IF NOT EXISTS team_by_workspace ON team (workspace_id)`,

  /* ── M21: who can be assigned ──────────────────────────────────────────── */

  /**
   * Team membership, which the workspace-wide user list does not carry.
   *
   * Linear refuses `issueUpdate` with "not a member" for an assignee outside
   * the issue's team, so a picker built from `users` offers choices that fail.
   * Found by clicking one.
   *
   * Replaced wholesale per team on every vocabulary refresh, like workflow
   * states: somebody removed from a team has to *leave* the picker, and an
   * upsert cannot express a removal.
   */
  `CREATE TABLE IF NOT EXISTS team_member (
     team_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     PRIMARY KEY (team_id, user_id)
   )`,
];
