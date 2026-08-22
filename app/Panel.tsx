import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRealtime } from "@bb/plugin-sdk/app";
import { ArchiveDialog } from "./ArchiveDialog.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { IssueRowView, PanelView, Sort, WorkingSetView } from "../src/contract.js";
import {
  chrome,
  hasActiveFilters,
  hydrateSort,
  loadsForSegment,
  usePanelChrome,
} from "../src/panel-chrome.js";
import { joinSentence, pluralize } from "../src/format.js";
import { toast } from "sonner";
import { IssueDetail } from "./Detail.js";
import { InboxBadge, InboxSegment, useInboxCount } from "./Inbox.js";
import { IssueRow, type RowActions } from "./IssueRow.js";
import { StateGlyph } from "./StateGlyph.js";
import { useAsync, useLinearRpc } from "./rpc.js";

/**
 * The nav panel body.
 *
 * The host draws the title bar with the plugin icon and title, so this owns a
 * full-bleed body with zero host padding and never repeats the title. It is a
 * switch over `state.kind` and holds no logic of its own — everything it
 * renders was decided by `selectPanelState`, which is what makes all of it
 * testable without a DOM.
 *
 * **The panel is workspace-scoped, and it cannot be otherwise.**
 * `PluginNavPanelProps` is `{ subPath }` and nothing else, and the escape
 * hatch fails too: `useBbContext().projectId` is derived from
 * `/projects/:projectId/*` route matches, and this panel's route is
 * `/plugins/linear/linear/*`. So there is no "this project" here — the team
 * selector in the header is the scope, and project-scoped calls to action live
 * on the surfaces that actually carry a project.
 */
export function LinearPanel({ subPath }: { subPath: string }) {
  const rpc = useLinearRpc();
  const navigate = useBbNavigate();
  const state = usePanelChrome();
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // `g` then `i`/`a`. A ref rather than state: a chord's first key must not
  // cost a render of a forty-row list.
  const chordPending = useRef(false);

  // A deep link lands here: `/plugins/linear/linear/t/ENG` selects a team,
  // `/i/ENG-123` opens an issue. Parsed rather than trusted — it round-trips
  // through the address bar.
  const deepLink = parseSubPath(subPath);
  const loads = loadsForSegment(state.segment);
  const debouncedSearch = useDebouncedValue(state.search, 180);

  const working = useAsync(
    useCallback(
      async () => rpc.call("workingSet", { team: deepLink.teamKey ?? state.teamId }),
      [rpc, deepLink.teamKey, state.teamId],
    ),
    [deepLink.teamKey, state.teamId],
    loads.working,
  );

  const panel = useAsync(
    useCallback(
      async () =>
        rpc.call("panel", {
          team: deepLink.teamKey ?? state.teamId,
          grouping: state.grouping,
          sort: state.sort,
          search: debouncedSearch,
          filters: state.filters,
        }),
      [
        rpc,
        deepLink.teamKey,
        state.teamId,
        state.grouping,
        state.sort,
        debouncedSearch,
        state.filters,
      ],
    ),
    [
      deepLink.teamKey,
      state.teamId,
      state.grouping,
      state.sort,
      debouncedSearch,
      JSON.stringify(state.filters),
    ],
    loads.panel,
  );

  // The poller publishes a bare `{ at }` signal; reload only the visible
  // projection. Updating a disabled hook still costs a render even though it
  // correctly skips the rpc call.
  const reloadVisible = useCallback(() => {
    if (loads.panel) panel.reload();
    if (loads.working) working.reload();
  }, [loads.panel, loads.working, panel.reload, working.reload]);
  useRealtime("linear:data", reloadVisible);

  const rows = useMemo(() => {
    if (
      state.segment === "working" &&
      working.status === "ready" &&
      working.value.view.kind === "buckets"
    ) {
      return working.value.view.buckets.flatMap((bucket) => bucket.rows);
    }
    if (
      state.segment === "all" &&
      panel.status === "ready" &&
      panel.value.state.kind === "rows"
    ) {
      return panel.value.state.groups.flatMap((group) => group.rows);
    }
    return [];
  }, [panel, state.segment, working]);

  const open = useCallback(
    (id: string) => {
      setSelected(id);
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        navigate.toPluginPanel("linear", { subPath: `i/${row.identifier}` });
      }
    },
    [rows, navigate],
  );

  /**
   * The issue a confirmation is open for, or null.
   *
   * State rather than a dialog per row: one dialog, rendered once, told which
   * issue it is about. A hundred rows each holding a closed dialog is a
   * hundred portals the browser has to keep, and the list is the one place in
   * this plugin where per-row cost actually shows.
   */
  const [archiving, setArchiving] = useState<IssueRowView | null>(null);

  /*
   * The account-wide half of the chrome. One read, on mount, and then never
   * again: everything after this is a local change that writes through.
   */
  useEffect(() => {
    void rpc.call("preferences", null).then((prefs) => {
      if (prefs.sort !== null) hydrateSort(prefs.sort as Sort);
    });
  }, [rpc]);

  const actions: RowActions = useMemo(
    () => ({
      askToArchive: setArchiving,
      start: (id: string) => {
        void (async () => {
          const result = await rpc.call("startThread", { issueId: id });
          if (!result.ok) {
            toast.error(result.message);
            return;
          }
          // The fallback note is a second sentence rather than a second toast:
          // "started, but bb named the branch" is one event.
          toast.success(result.note === null ? result.message : `${result.message} ${result.note}`);
          if (result.threadId !== null) navigate.toThread(result.threadId);
        })();
      },
      copyIdentifier: (row) => {
        void navigator.clipboard?.writeText(row.identifier);
      },
      copyBranch: (id: string) => {
        void (async () => {
          // Read through rpc rather than from the row: the branch name is not
          // part of the row projection, and putting it there would cost every
          // row in the list a field that one menu item uses.
          const result = await rpc.call("issue", { id });
          if (result.result.kind !== "issue") return;
          const { branchName, identifier } = result.result.detail;
          void navigator.clipboard?.writeText(branchName ?? identifier);
        })();
      },
    }),
    [rpc, navigate],
  );

  const confirmArchive = useCallback(() => {
    const target = archiving;
    if (target === null) return;
    setArchiving(null);
    void (async () => {
      const result = await rpc.call("archiveIssue", { id: target.id });
      if (result.ok) toast.success(`Archived ${target.identifier}.`);
      else toast.error(result.message ?? `Couldn't archive ${target.identifier}.`);
    })();
  }, [archiving, rpc]);

  // j/k move the selection, Enter opens, Escape returns focus to the list,
  // `/` focuses search. Bound on the list rather than the document so the
  // shortcuts cannot fight a composer somewhere else in the app.
  useEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const index = rows.findIndex((row) => row.id === selected);
      if (chordPending.current) {
        chordPending.current = false;
        if (event.key === "i") {
          event.preventDefault();
          chrome.setSegment("inbox");
          return;
        }
        if (event.key === "a") {
          event.preventDefault();
          chrome.setSegment("all");
          return;
        }
      }
      if (event.key === "g") {
        chordPending.current = true;
        return;
      }
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelected(rows[Math.min(index + 1, rows.length - 1)]?.id ?? rows[0]?.id ?? null);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(rows[Math.max(index - 1, 0)]?.id ?? null);
      } else if (event.key === "Enter" && selected !== null) {
        event.preventDefault();
        open(selected);
      }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [rows, selected, open]);

  if (loads.panel && panel.status === "loading") {
    // Skeletons appear only when a surface has never had cached rows. Once the
    // mirror has anything, the mirror renders and staleness is stated in
    // words — a spinner over data you already have is a lie about what you
    // know.
    return <SkeletonList />;
  }

  if (loads.panel && panel.status === "failed") {
    return (
      <Body>
        <Notice tone="error">{panel.message}</Notice>
      </Body>
    );
  }

  const openIssue = deepLink.identifier;
  const notice =
    state.segment === "all" && panel.status === "ready"
      ? panel.value.notice
      : state.segment === "working" && working.status === "ready"
        ? working.value.notice
        : null;

  return (
    <div className="flex h-full min-h-0">
      {/* min-w-0, or a long issue title sets this flex child's intrinsic
          width and the whole list slides off a phone screen — flex items
          default to min-width:auto and never shrink below their content. */}
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${openIssue === null ? "" : "hidden md:flex"}`}
      >
        <Segments />

        {/* Failure-first: above the list, never inside it. */}
        {notice !== null ? (
          <div className="px-3 pt-3">
            <Notice tone={notice.tone}>{notice.message}</Notice>
          </div>
        ) : null}

        {state.segment === "inbox" ? (
          <InboxSegment />
        ) : state.segment === "working" ? (
          <WorkingSet view={working} onOpen={open} actions={actions} />
        ) : panel.status === "ready" ? (
          <PanelBody
            view={panel.value}
            selected={selected}
            onOpen={open}
            listRef={listRef}
            collapsed={state.collapsed}
            searching={state.search.trim() !== ""}
            actions={actions}
          />
        ) : (
          <SkeletonList />
        )}
      </div>

      {/*
        Two panes on desktop, drill-in on compact. The detail replaces the list
        below `md` rather than squeezing beside it: hover affordances are
        unreachable on a touch pointer anyway, and two 180px columns are two
        columns nobody can read.
      */}
      {openIssue !== null ? (
        <aside className="min-h-0 w-full border-l border-border md:w-[26rem] lg:w-[32rem]">
          <IssueDetail
            issueId={openIssue}
            onClose={() => navigate.toPluginPanel("linear", { subPath: "" })}
          />
        </aside>
      ) : null}

      <ArchiveDialog
        target={archiving}
        onCancel={() => setArchiving(null)}
        onConfirm={confirmArchive}
      />
    </div>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function PanelBody({
  view,
  selected,
  onOpen,
  listRef,
  collapsed,
  searching,
  actions,
}: {
  view: PanelView;
  selected: string | null;
  onOpen: (id: string) => void;
  listRef: React.RefObject<HTMLUListElement | null>;
  collapsed: readonly string[];
  searching: boolean;
  actions: RowActions;
}) {
  const state = view.state;

  switch (state.kind) {
    case "no-credential":
      return (
        <Body>
          <h2 className="text-base font-medium text-foreground">Connect Linear</h2>
          <p className="text-sm text-muted-foreground">
            This panel needs a Linear API key. Create a personal key in Linear under Settings →
            Account → Security &amp; access → Personal API keys, then save it in this plugin&apos;s
            settings — the field is called <strong>Linear API key</strong>. The Linear button in
            bb&apos;s sidebar footer opens that page.
          </p>
          <p className="text-sm text-muted-foreground">
            From a terminal:{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              bb plugin config linear set apiKey &lt;key&gt;
            </code>{" "}
            — that puts the key in your shell history and the process table.
          </p>
          <p className="text-sm text-muted-foreground">
            The key is stored in bb&apos;s secret storage on this machine, is never shown again,
            and is never given to an agent.
          </p>
        </Body>
      );

    case "no-binding":
      return (
        <Body>
          <p className="text-sm text-foreground">
            No bb project is bound to a Linear team yet, so there is nothing to show here.
          </p>
          <p className="text-sm text-muted-foreground">
            Bind one in this plugin&apos;s settings — the Linear button in bb&apos;s sidebar footer
            opens that page.
          </p>
        </Body>
      );

    case "first-sync":
      return (
        <div className="flex h-full flex-col">
          <p className="px-3 pt-3 text-sm text-muted-foreground">
            Reading <strong>{state.teamName ?? "your teams"}</strong>&apos;s open issues — this
            takes a few seconds the first time.
          </p>
          <SkeletonList />
        </div>
      );

    case "empty-team":
      return (
        <Body>
          <p className="text-sm text-foreground">
            <strong>{state.teamName}</strong> has no open issues.
          </p>
        </Body>
      );

    case "empty-filter":
      return (
        <Body>
          <p className="text-sm text-foreground">
            No issues match {joinSentence(state.facets.map((facet) => facet))}.
          </p>
          {/* The phrase is the button's own label, so the sentence and the
              control agree. */}
          <div>
            <Button variant="outline" size="sm" onClick={() => chrome.clearFilters()}>
              Clear filters
            </Button>
            <span className="ml-2 text-sm text-muted-foreground">
              to see all {state.totalWithoutFilters}.
            </span>
          </div>
        </Body>
      );

    case "rows":
      return (
        <GroupedRows {...{ state, selected, onOpen, listRef, collapsed, searching, actions }} />
      );
  }
}

/**
 * The window: 60 rows, grown 60 at a time as the user scrolls toward the end.
 *
 * Not a height-estimating virtualizer, deliberately. A row here is one line or
 * two depending on whether it earned a second one, and a virtualizer fed a
 * wrong estimate produces a scrollbar that jumps under the pointer — which is
 * a worse experience than the one it was brought in to fix. Windowing needs no
 * estimate at all: rows that exist are measured by the browser, and rows that
 * do not exist cost nothing.
 *
 * It does not shrink again on the way back up. That is the honest trade: the
 * ceiling is what you have actually scrolled past, and the row cap keeps that
 * bounded anyway.
 *
 * Below the threshold there is no windowing at all — the machinery would cost
 * more than it saves, and a list of forty rows was never the problem.
 */
const WINDOW_THRESHOLD = 200;
const WINDOW_STEP = 60;

function GroupedRows({
  state,
  selected,
  onOpen,
  listRef,
  collapsed,
  searching,
  actions,
}: {
  state: Extract<PanelView["state"], { kind: "rows" }>;
  selected: string | null;
  onOpen: (id: string) => void;
  listRef: React.RefObject<HTMLUListElement | null>;
  collapsed: readonly string[];
  searching: boolean;
  actions: RowActions;
}) {
  const total = state.groups.reduce((sum, group) => sum + group.rows.length, 0);
  const windowed = total > WINDOW_THRESHOLD;
  const [budget, setBudget] = useState(WINDOW_STEP);

  // A new set of rows starts a new window. Keyed on the group keys rather than
  // the row ids: a poll that changes one issue's state must not scroll the
  // reader back to the top of a list they were halfway down.
  const shape = state.groups.map((group) => group.key).join("\u0000");
  useEffect(() => {
    setBudget(WINDOW_STEP);
  }, [shape]);

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLUListElement>) => {
      if (!windowed) return;
      const element = event.currentTarget;
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (remaining < element.clientHeight) {
        setBudget((current) => (current >= total ? current : current + WINDOW_STEP));
      }
    },
    [windowed, total],
  );

  let spent = 0;

  return (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Linear issues"
          aria-activedescendant={selected === null ? undefined : `bbl-row-${selected}`}
          onScroll={onScroll}
          /*
            The cap is a reading measure, not a layout preference. Past about
            72rem a row's title ends near the left edge and its age sits by the
            right one, and the eye stops connecting them — the row stops being
            a row and becomes two columns that happen to share a line.
          */
          className="bbl-scroller w-full max-w-[56rem] flex-1 overflow-y-auto px-1 pb-3 focus-visible:outline-none"
        >
          {state.groups.map((group) => {
            /*
              Finished work starts folded. A team that has shipped for a year
              carries hundreds of Done rows, and a segment that opens with all
              of them expanded buries the open work it exists to show. The
              stored list is therefore "toggled away from the DEFAULT", not
              "collapsed": one click still opens Done, and the chevron still
              tells the truth. While a search is active every group opens —
              a hit hidden under a folded header reads as a miss.
            */
            const startsCollapsed =
              !searching &&
              (group.tone === "completed" ||
                group.tone === "canceled" ||
                group.tone === "duplicate");
            const isCollapsed = collapsed.includes(group.key) !== startsCollapsed;
            // A collapsed group renders no rows, so it spends none of the
            // window — otherwise collapsing a group would shorten the list you
            // can reach, which is the opposite of what collapsing is for.
            const rows = isCollapsed
              ? []
              : windowed
                ? group.rows.slice(0, Math.max(0, budget - spent))
                : group.rows;
            spent += rows.length;
            return (
              <li key={group.key} role="group" aria-label={group.label}>
                {group.label !== "" ? (
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => chrome.toggleCollapsed(group.key)}
                    className="bbl-section sticky top-0 z-10 flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors duration-150 hover:text-foreground"
                  >
                    <Icon
                      name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                      className="size-3"
                      aria-hidden
                    />
                    <span className="truncate">{group.label}</span>
                    {/* Post-filter, always. The filter row above already names
                        the filter, so there is nothing for a total to
                        disambiguate. A pill rather than "· 12", so the number
                        is a shape the eye finds instead of punctuation it has
                        to parse. */}
                    <span className="bbl-count rounded-full px-1.5 py-px text-[10px] tabular-nums">
                      {group.count}
                    </span>
                  </button>
                ) : null}

                {isCollapsed ? null : (
                  <ul>
                    {rows.map((row) => (
                      <IssueRow
                        key={row.id}
                        row={row}
                        selected={row.id === selected}
                        onOpen={onOpen}
                        actions={actions}
                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}

          {windowed && spent < total ? (
            <li className="px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              {spent} of {total} shown — keep scrolling.
            </li>
          ) : null}

          {state.shown < state.total ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Showing {state.shown} of {state.total}{" "}
              {pluralize(state.total, "issue", "issues")}. Narrow it with a filter or search to
              see the rest.
            </li>
          ) : null}
        </ul>
  );
}

/**
 * The segmented control.
 *
 * *All issues* is the conventional list. *Inbox* is the durable destination
 * for everything Linear wants you for. The `g` chord — `g` then `i` or `a` —
 * switches between them without reaching for the mouse.
 */
function Segments() {
  const state = usePanelChrome();
  const unseen = useInboxCount();

  // Working set first, and default: it is the segment that answers questions
  // the browser tab you already have open cannot answer at all.
  const tabs = [
    { id: "working" as const, label: "Working set" },
    { id: "inbox" as const, label: "Inbox" },
    { id: "all" as const, label: "All issues" },
  ];

  return (
    <div className="w-full max-w-[56rem] px-2 py-2">
      {/*
        One control, not three buttons. The track is what says these three are
        alternatives to each other; without it they read as three unrelated
        links that happen to sit in a row.
      */}
      <div
        role="tablist"
        aria-label="Linear segments"
        className="bbl-segments inline-flex items-center gap-0.5 rounded-lg p-0.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={state.segment === tab.id}
            className={`flex items-center rounded-[0.3rem] px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              state.segment === tab.id
                ? "bbl-segment-active font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => chrome.setSegment(tab.id)}
          >
            {tab.label}
            {tab.id === "inbox" ? <InboxBadge count={unseen} /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The Working set, grouped by **bb fact**.
 *
 * A bucket with nothing in it does not render at all. The five hints appear
 * only when the whole set is clear, which is the one case worth a sentence —
 * five empty headings is a wall of nothing, and one sentence naming what was
 * asked is the difference between "nothing here" and "nothing needs you".
 */
function WorkingSet({
  view,
  onOpen,
  actions,
}: {
  view: ReturnType<typeof useAsync<{ view: WorkingSetView; notice: unknown }>>;
  onOpen: (id: string) => void;
  actions: RowActions;
}) {
  if (view.status === "loading") return <SkeletonList />;
  if (view.status === "failed") {
    return (
      <Body>
        <Notice tone="error">{view.message}</Notice>
      </Body>
    );
  }

  const state = view.value.view;

  if (state.kind === "no-credential" || state.kind === "no-binding") {
    // The same two sentences the All-issues segment shows. One source, so they
    // cannot drift apart.
    return (
      <PanelBody
        view={{ notice: null, state: { kind: state.kind } }}
        selected={null}
        onOpen={onOpen}
        listRef={{ current: null }}
        collapsed={[]}
        searching={false}
        actions={actions}
      />
    );
  }

  if (state.kind === "first-sync") {
    return (
      <div className="flex h-full flex-col">
        <p className="px-3 pt-3 text-sm text-muted-foreground">
          Reading <strong>{state.teamName ?? "your teams"}</strong>&apos;s open issues — this
          takes a few seconds the first time.
        </p>
        <SkeletonList />
      </div>
    );
  }

  if (state.kind === "clear") {
    /*
     * The surface a user sees most often when things are going well, so it is
     * worth composing rather than listing.
     *
     * The five hints are the five questions the Working set asked, each with a
     * check beside it — which turns a wall of grey sentences into evidence
     * that something was actually looked at. The heading is the answer; the
     * list is the working.
     */
    return (
      <div className="flex w-full max-w-[56rem] flex-1 flex-col items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="bbl-completed bbl-glyph">
              <StateGlyph tone="completed" className="size-5" />
            </span>
            <p className="text-sm font-medium text-foreground">Nothing needs you right now.</p>
          </div>
          <ul className="space-y-1.5">
            {state.hints.map((hint) => (
              <li key={hint} className="flex items-start gap-2 text-xs text-muted-foreground">
                <Icon name="Check" className="mt-0.5 size-3 shrink-0 opacity-50" aria-hidden />
                <span>{hint}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <ul
      role="listbox"
      aria-label="Working set"
      className="bbl-scroller w-full max-w-[56rem] flex-1 overflow-y-auto px-1 pb-3"
    >
      {state.buckets.map((bucket) => (
        <li key={bucket.id} role="group" aria-label={bucket.label}>
          <div className="bbl-section sticky top-0 z-10 flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <span className="truncate">{bucket.label}</span>
            <span className="bbl-count rounded-full px-1.5 py-px text-[10px] tabular-nums">
              {bucket.rows.length}
            </span>
          </div>
          <ul>
            {bucket.rows.map((row) => (
              <IssueRow
                key={row.id}
                row={row}
                selected={false}
                onOpen={onOpen}
                actions={actions}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** Every non-list state — connect, bind, refuse, fail — on the same measure
 *  as the list, so nothing jumps sideways when the panel changes what it is
 *  showing. */
function Body({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[56rem] space-y-3 p-4 md:p-5">{children}</div>;
}

function Notice({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={`${tone === "error" ? "bbl-danger" : "bbl-triage"} bbl-notice px-3 py-2`}
      // `status`, not `alert`: a stale panel is a fact, not an interruption,
      // and an assertive live region would talk over whatever the user is
      // doing every time a poll fails.
      role="status"
    >
      <p className="bbl-text text-sm">{children}</p>
    </div>
  );
}

/**
 * Shaped like the rows it stands in for.
 *
 * Same glyph size, same identifier width, same row height, same gaps — so the
 * list does not jump a single pixel when the real data lands. A skeleton whose
 * metrics differ from the content is a skeleton that makes the load feel
 * *worse* than a blank pane, because the arrival is a visible lurch.
 *
 * The title widths vary deterministically rather than randomly: a skeleton
 * that reshuffles on every render is an animation nobody asked for.
 */
function SkeletonList() {
  return (
    <ul className="px-1 pb-3" aria-hidden>
      {Array.from({ length: 9 }, (_, index) => (
        <li key={index} className="flex items-center gap-2.5 py-1.5 pl-2 pr-1.5">
          <span className="bbl-skeleton size-3.5 shrink-0 rounded-full" />
          <span className="bbl-skeleton h-2.5 w-[4.75rem] shrink-0 rounded-sm" />
          <span
            className="bbl-skeleton h-2.5 rounded-sm"
            style={{
              width: `${String(38 + ((index * 17) % 44))}%`,
              // Later rows fade out, so the list reads as continuing past the
              // fold rather than as nine items that happen to be loading.
              opacity: 1 - index * 0.08,
            }}
          />
          <span className="bbl-skeleton ml-auto size-5 shrink-0 rounded-full" />
        </li>
      ))}
    </ul>
  );
}

/**
 * `subPath` is the route remainder after the panel root, and it is the only
 * prop this panel gets. Deep links stay real: `/t/ENG` selects a team, and
 * `/i/ENG-123` opens an issue.
 *
 * Parsed defensively — the address bar is user input, and a malformed segment
 * must land on the list rather than throw inside a render.
 */
export function parseSubPath(subPath: string): {
  teamKey: string | null;
  identifier: string | null;
} {
  const parts = subPath.split("/").filter(Boolean);
  if (parts[0] === "t" && parts[1] !== undefined) {
    return { teamKey: parts[1], identifier: null };
  }
  if (parts[0] === "i" && parts[1] !== undefined) {
    return { teamKey: null, identifier: parts[1] };
  }
  return { teamKey: null, identifier: null };
}

/** Whether the chrome currently narrows the list. Re-exported here so the
 *  header and the body agree without importing the store twice. */
export { hasActiveFilters };
