import Database from "better-sqlite3";
import { MIGRATIONS } from "../../src/store/migrations.js";
import { createStore, type IssueInput, type Store } from "../../src/store/store.js";
import type { MemberRow, WorkflowStateRow } from "../../src/store/rows.js";

/**
 * A real SQLite database, in memory.
 *
 * Never a mock. The interesting behaviour of the mirror *is* SQLite's — the
 * partial unique index that makes "exactly one primary" impossible to
 * violate, the FTS5 triggers without which every search silently returns
 * nothing, `json_each` over the label array. A fake store would assert that
 * the code calls the methods it calls, which is not a fact anybody needs.
 */
export function createTestStore(): Store {
  const db = new Database(":memory:");
  // The host applies these through `bb.storage.migrate`, which tracks a
  // statement index. A fresh database needs no bookkeeping — but running them
  // one at a time still proves the invariant the host relies on: every entry
  // is exactly one statement.
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  return createStore(db);
}

export const NOW = 1_700_000_000_000;

export function team(id: string, key: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: null,
    key,
    name: `${key} team`,
    icon: null,
    color: null,
    parentId: null,
    estimationType: "notUsed",
    estimationAllowZero: false,
    estimationExtended: false,
    defaultEstimate: 0,
    cyclesEnabled: false,
    triageEnabled: false,
    activeCycleId: null,
    updatedAt: NOW,
    ...overrides,
  };
}

export function state(
  id: string,
  teamId: string,
  type: string,
  position = 0,
  name = type,
): WorkflowStateRow {
  return { id, teamId, name, type, color: null, position, description: null };
}

export function member(id: string, displayName: string, isMe = false): MemberRow {
  return {
    id,
    name: displayName,
    displayName,
    email: null,
    avatarUrl: null,
    active: true,
    isApp: false,
    isMe,
    updatedAt: NOW,
  };
}

export function issue(overrides: Partial<IssueInput> & { id: string }): IssueInput {
  return {
    identifier: `ENG-${overrides.id}`,
    number: 1,
    teamId: "team_eng",
    title: "An issue",
    description: null,
    url: null,
    branchName: null,
    priority: 0,
    estimate: null,
    stateId: null,
    assigneeId: null,
    creatorId: null,
    projectId: null,
    milestoneId: null,
    cycleId: null,
    parentId: null,
    dueDate: null,
    sortOrder: 0,
    subIssueSortOrder: null,
    labelIds: [],
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    triagedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
