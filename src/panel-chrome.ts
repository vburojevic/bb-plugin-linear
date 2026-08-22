import { useSyncExternalStore } from "react";
import type { Grouping, PanelFilters, Sort } from "./contract.js";

/**
 * The nav panel's chrome state, in one module-level store.
 *
 * `headerContent` mounts in the **shared app title bar** — a different React
 * tree from the panel body — so ordinary React state and context cannot span
 * them. The team selector and the search field live up there; the list lives
 * down here; both need the same four values.
 *
 * A module singleton is safe *here* specifically because there is exactly one
 * nav panel per window. The warning against module-level singletons applies to
 * *per-thread* surfaces — the composer banner, the thread header chip — which
 * mount once per visible thread in a split layout, and where a shared store
 * would show one thread's issue beside another thread's conversation.
 *
 * **The persistence split.** Everything here is device-local, kept in browser
 * storage: the selected team, the filters, the grouping, the group-collapse
 * state. Only *sort* is account-wide, and it lives in the plugin's kv through
 * an rpc round trip — a preference for "priority over updated" is a working
 * style worth carrying between machines, while a phone mid-triage and a
 * desktop must not fight over one synced collapse state.
 */

export type Segment = "working" | "inbox" | "all";

/** Heavy panel RPCs are lazy by segment. The default Working set must not
 * also build and serialise the hidden 300-row All issues view, and the Inbox
 * needs neither issue projection. */
export function loadsForSegment(segment: Segment): {
  panel: boolean;
  working: boolean;
  facets: boolean;
} {
  return {
    panel: segment === "all",
    working: segment === "working",
    facets: segment === "all",
  };
}

export interface ChromeState {
  readonly segment: Segment;
  readonly teamId: string | null;
  readonly search: string;
  readonly grouping: Grouping;
  readonly sort: Sort;
  readonly filters: PanelFilters;
  readonly collapsed: readonly string[];
}

export const EMPTY_FILTERS: PanelFilters = {
  stateIds: [],
  stateTypes: [],
  assigneeIds: [],
  labelIds: [],
  priorities: [],
  // True, because these are the ALL ISSUES segment's defaults and a segment
  // named "All issues" that silently hides every Done row is a label lying
  // about its list — on this team it showed 1 of 8. The Working set never
  // reads this (it has its own view), and the filter popover's toggle still
  // narrows to open-only for anyone who wants the old behaviour.
  includeCompleted: true,
};

const INITIAL: ChromeState = {
  // The panel's argument for existing, so it is what opens.
  segment: "working",
  teamId: null,
  search: "",
  grouping: "state",
  sort: "updated",
  filters: EMPTY_FILTERS,
  collapsed: [],
};

const STORAGE_KEY = "bb-plugin-linear:panel";

function load(): ChromeState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return INITIAL;
    const parsed = JSON.parse(raw) as Partial<ChromeState>;
    // Merged rather than trusted: a value written by an older release is
    // missing fields a newer one reads, and a spread over the defaults turns
    // that into a working panel instead of a crash at first paint.
    return {
      ...INITIAL,
      ...parsed,
      filters: { ...EMPTY_FILTERS, ...(parsed.filters ?? {}) },
    };
  } catch {
    return INITIAL;
  }
}

let state: ChromeState = load();
const listeners = new Set<() => void>();

function commit(next: ChromeState): void {
  state = next;
  try {
    // Sort is deliberately excluded here — it is account-wide and travels
    // through kv, so writing it to this device's storage as well would give
    // two sources of truth that disagree after a change on another machine.
    const { sort: _sort, ...deviceLocal } = next;
    void _sort;
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(deviceLocal));
  } catch {
    // Private browsing, a full quota, a locked-down embedder. A preference
    // that fails to persist is a preference that resets, not a broken panel.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Apply the account-wide sort, once, on first load.
 *
 * Deliberately does **not** go through `commit`: that would write the value
 * straight back over rpc, and a hydration that echoes itself is a hydration
 * that races every other tab. A sort the user has already changed on this
 * device this session wins, because they changed it more recently than the
 * server knew.
 */
let sortHydrated = false;

export function hydrateSort(sort: Sort): void {
  if (sortHydrated) return;
  sortHydrated = true;
  if (sort === state.sort) return;
  state = { ...state, sort };
  for (const listener of listeners) listener();
}

export function usePanelChrome(): ChromeState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  );
}

export const chrome = {
  current: (): ChromeState => state,

  setSegment(segment: Segment): void {
    commit({ ...state, segment });
  },

  setTeam(teamId: string | null): void {
    // Changing team clears the filters with it. A state id from Engineering
    // means nothing on Design, and leaving it applied produces an empty list
    // whose explanation names a state the new team does not have.
    commit({ ...state, teamId, filters: EMPTY_FILTERS, collapsed: [] });
  },

  setSearch(search: string): void {
    commit({ ...state, search });
  },

  setGrouping(grouping: Grouping): void {
    commit({ ...state, grouping, collapsed: [] });
  },

  setSort(sort: Sort): void {
    // A local change is authoritative from here on: the user just expressed a
    // preference, and a hydration arriving late must not undo it.
    sortHydrated = true;
    commit({ ...state, sort });
  },

  setFilters(filters: PanelFilters): void {
    commit({ ...state, filters });
  },

  toggleFacet(facet: "stateIds" | "stateTypes" | "assigneeIds" | "labelIds", id: string): void {
    const current = state.filters[facet];
    const next = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id];
    commit({ ...state, filters: { ...state.filters, [facet]: next } });
  },

  togglePriority(priority: number): void {
    const current = state.filters.priorities;
    const next = current.includes(priority)
      ? current.filter((entry) => entry !== priority)
      : [...current, priority];
    commit({ ...state, filters: { ...state.filters, priorities: next } });
  },

  clearFilters(): void {
    commit({ ...state, filters: EMPTY_FILTERS, search: "" });
  },

  toggleCollapsed(key: string): void {
    const next = state.collapsed.includes(key)
      ? state.collapsed.filter((entry) => entry !== key)
      : [...state.collapsed, key];
    commit({ ...state, collapsed: next });
  },
};

/**
 * The one collapse rule, shared by the renderer and the keyboard list.
 *
 * Finished work starts folded; the stored list records toggles away from
 * that default; a live search opens everything. Two copies of this rule
 * already diverged once — the renderer folded Done while j/k kept walking
 * the selection through its invisible rows.
 */
export function isGroupCollapsed(
  group: { readonly key: string; readonly tone: string },
  collapsed: readonly string[],
  searching: boolean,
): boolean {
  const startsCollapsed =
    !searching &&
    (group.tone === "completed" ||
      group.tone === "canceled" ||
      group.tone === "duplicate");
  return collapsed.includes(group.key) !== startsCollapsed;
}

/** Whether anything is narrowing the list. Drives the Clear filters control
 *  and the empty state's choice of sentence. */
export function hasActiveFilters(value: ChromeState): boolean {
  return (
    value.search.trim() !== "" ||
    value.filters.stateIds.length > 0 ||
    value.filters.stateTypes.length > 0 ||
    value.filters.assigneeIds.length > 0 ||
    value.filters.labelIds.length > 0 ||
    value.filters.priorities.length > 0 ||
    value.filters.includeCompleted
  );
}
