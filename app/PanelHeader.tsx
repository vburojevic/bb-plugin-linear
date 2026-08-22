import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Grouping, Sort } from "../src/contract.js";
import {
  chrome,
  hasActiveFilters,
  loadsForSegment,
  usePanelChrome,
} from "../src/panel-chrome.js";
import { NewIssueButton } from "./NewIssue.js";
import { useAsync, useLinearRpc } from "./rpc.js";

/**
 * The panel's header accessories, rendered by the host in the **shared app
 * title bar** — a different React tree from the panel body.
 *
 * That is the whole reason `src/panel-chrome.ts` exists: ordinary React state
 * and context cannot span two trees, so the team selector up here and the list
 * down there share one module-level store instead.
 *
 * A throwing `headerContent` hides the accessory without breaking the title
 * bar or the panel body, which is why the facet fetch degrades to an empty
 * list rather than propagating.
 */
export function LinearPanelHeader() {
  const rpc = useLinearRpc();
  const state = usePanelChrome();
  const isCompact = useIsCompactViewport();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const loads = loadsForSegment(state.segment);

  const bindings = useAsync(
    useCallback(async () => rpc.call("bindings", null), [rpc]),
    [],
  );
  const facets = useAsync(
    useCallback(async () => rpc.call("facets", { team: state.teamId }), [rpc, state.teamId]),
    [state.teamId],
    loads.facets,
  );

  const reloadStructure = useCallback(() => {
    bindings.reload();
    if (loads.facets) facets.reload();
  }, [bindings.reload, facets.reload, loads.facets]);
  useRealtime("linear:structure", reloadStructure);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const boundTeams =
    bindings.status === "ready" ? bindings.value.teams.filter((team) => team.bound) : [];

  // Nothing to choose between, so no chooser. A selector offering one option
  // is a control that costs a click and answers nothing.
  const showTeamSelector = boundTeams.length > 1;

  return (
    <div className="flex items-center gap-1.5">
      {showTeamSelector ? (
        <Select
          value={state.teamId ?? "all"}
          onValueChange={(value) => chrome.setTeam(value === "all" ? null : value)}
        >
          <SelectTrigger className="h-7 w-auto min-w-24 gap-1 border-none bg-transparent px-2 text-xs shadow-none hover:bg-state-hover">
            <SelectValue placeholder="All bound teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All bound teams</SelectItem>
            {boundTeams.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.key} · {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <NewIssueButton currentTeamId={state.teamId} />

      {/*
        On compact the header carries the team selector and ONE control: a
        search icon that expands over the row. Two chips' worth of horizontal
        room cannot hold six facets, so filters and sort move into the
        overflow menu rather than being crushed into it.
      */}
      {loads.panel ? isCompact && !searchOpen ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setSearchOpen(true)}
          aria-label="Search issues"
        >
          <Icon name="Search" className="size-4" aria-hidden />
        </Button>
      ) : (
        <div className="relative">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchRef}
            value={state.search}
            onChange={(event) => chrome.setSearch(event.target.value)}
            onBlur={() => {
              if (state.search === "") setSearchOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                chrome.setSearch("");
                setSearchOpen(false);
              }
            }}
            placeholder="Search issues"
            aria-label="Search issues"
            className="h-7 w-40 pl-7 text-xs md:w-56"
          />
        </div>
      ) : null}

      {loads.panel ? <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Sort and filter"
            aria-pressed={hasActiveFilters(state)}
          >
            <Icon name="SlidersHorizontal" className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Group by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.grouping}
            onValueChange={(value) => chrome.setGrouping(value as Grouping)}
          >
            <DropdownMenuRadioItem value="state">State</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="assignee">Assignee</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="project">Project</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="cycle">Cycle</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="none">Nothing</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.sort}
            onValueChange={(value) => {
              chrome.setSort(value as Sort);
              // Written through so the choice follows the account rather than
              // the browser. A failure here loses a preference, not a panel.
              void rpc.call("setSort", { sort: value as Sort }).catch(() => undefined);
            }}
          >
            <DropdownMenuRadioItem value="updated">Last updated</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="priority">Priority</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="due">Due date</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="created">Created</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="manual">Manual order</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>

          {/*
            The chips a team actually uses, never a fixed list of five: a
            triage-enabled team gets a Triage filter and a team without one
            does not. Derived from the bound teams' own workflow_state rows.
          */}
          {facets.status === "ready" && facets.value.stateTypes.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>State</DropdownMenuLabel>
              {facets.value.stateTypes.map((entry) => (
                <DropdownMenuCheckboxItem
                  key={entry.type}
                  checked={state.filters.stateTypes.includes(entry.type)}
                  onCheckedChange={() => chrome.toggleFacet("stateTypes", entry.type)}
                >
                  {entry.label}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          ) : null}

          {facets.status === "ready" && facets.value.members.some((member) => member.isMe) ? (
            <>
              <DropdownMenuSeparator />
              {facets.value.members
                .filter((member) => member.isMe)
                .map((member) => (
                  <DropdownMenuCheckboxItem
                    key={member.id}
                    checked={state.filters.assigneeIds.includes(member.id)}
                    onCheckedChange={() => chrome.toggleFacet("assigneeIds", member.id)}
                  >
                    Assigned to me
                  </DropdownMenuCheckboxItem>
                ))}
              <DropdownMenuCheckboxItem
                checked={state.filters.includeCompleted}
                onCheckedChange={(checked) =>
                  chrome.setFilters({ ...state.filters, includeCompleted: checked === true })
                }
              >
                Include done and cancelled
              </DropdownMenuCheckboxItem>
            </>
          ) : null}

          {hasActiveFilters(state) ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={false} onCheckedChange={() => chrome.clearFilters()}>
                Clear filters
              </DropdownMenuCheckboxItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu> : null}
    </div>
  );
}
