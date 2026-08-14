import { memo } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import type { IssueRowView } from "../src/contract.js";
import { priorityToneClass, toneClass } from "../src/select/tone.js";
import { BbFactGlyph, describeBbFact, StateGlyph } from "./StateGlyph.js";

export interface RowActions {
  start: (id: string) => void;
  copyIdentifier: (row: IssueRowView) => void;
  copyBranch: (id: string) => void;
  /** Opens the confirmation. The archive itself never happens from a menu
   *  click — see `ArchiveDialog`. */
  askToArchive: (row: IssueRowView) => void;
}

/**
 * One line by default. A second line only when it earns one.
 *
 * The trailing items drop in a fixed order as the pane narrows — age first,
 * then priority, then assignee — because age is recoverable from the detail
 * pane and identity is not. That order is expressed in CSS breakpoints rather
 * than in a resize observer: a row that re-renders on every pointer move
 * during a drag is a row that makes the whole list feel heavy.
 */
export const IssueRow = memo(function IssueRow({
  row,
  selected,
  onOpen,
  actions,
}: {
  row: IssueRowView;
  selected: boolean;
  onOpen: (id: string) => void;
  actions: RowActions;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <RowBody row={row} selected={selected} onOpen={onOpen} onStart={actions.start} />
      </ContextMenuTrigger>
      {/*
        The order is the same here and in the detail pane, because two views of
        one issue must not disagree about what can be done to it. Destructive
        actions come last, behind a separator.
      */}
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => actions.start(row.id)}>
          Start a thread from this issue
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.copyIdentifier(row)}>
          Copy identifier
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copyBranch(row.id)}>
          Copy branch name
        </ContextMenuItem>
        {row.url !== null ? (
          <ContextMenuItem asChild>
            <a href={row.url} target="_blank" rel="noreferrer">
              Open in Linear
            </a>
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => actions.askToArchive(row)}
        >
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

function RowBody({
  row,
  selected,
  onOpen,
  onStart,
  ...rest
}: {
  row: IssueRowView;
  selected: boolean;
  onOpen: (id: string) => void;
  onStart: (id: string) => void;
}) {
  return (
    <li
      {...rest}
      role="option"
      id={`bbl-row-${row.id}`}
      aria-selected={selected}
      aria-label={row.accessibleName}
      data-bbl-row={row.id}
      className={`${toneClass(row.tone)} bbl-row group relative flex cursor-pointer flex-col gap-0.5 rounded-md py-1.5 pl-2 pr-1.5 ${
        selected ? "bbl-row-selected" : "hover:bg-state-hover"
      }`}
      onClick={() => onOpen(row.id)}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {row.lead === "state" ? (
          <StateGlyph tone={row.tone} />
        ) : (
          <BbFactGlyph fact={row.bbFact} />
        )}

        {/* Tabular and fixed-width so the identifier column aligns down the
            whole list. Muted and a step smaller than the title, because it is
            a coordinate rather than content — you scan past it until the one
            time you are looking for exactly it. */}
        <span className="w-[4.75rem] shrink-0 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
          {row.identifier}
        </span>

        {/* The title carries the row. Medium rather than regular: at 13px in a
            list of forty, weight is the only thing separating the thing you
            are reading from the metadata around it. */}
        <span
          className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
            row.struckThrough ? "text-muted-foreground line-through" : "text-foreground"
          }`}
        >
          {row.title}
        </span>

        {/*
          One grid cell, two layers, crossfaded.

          The metadata and the row's actions occupy the same space, so
          approaching a row reveals what you can do to it without moving
          anything. A list that reflows under the pointer is a list you
          cannot click.
        */}
        <span className="ml-auto grid shrink-0 place-items-center">
          <span className="bbl-row-meta col-start-1 row-start-1 flex items-center gap-2">
            {row.assignee !== null ? (
              <span
                className="hidden size-5 place-items-center overflow-hidden rounded-full bg-muted text-[10px] font-medium text-muted-foreground sm:grid"
                title={row.assignee.name}
                aria-hidden
              >
                {row.assignee.avatarUrl !== null ? (
                  <img
                    src={row.assignee.avatarUrl}
                    alt=""
                    className="size-5 rounded-full object-cover"
                  />
                ) : (
                  row.assignee.initials
                )}
              </span>
            ) : (
              // An empty slot rather than no slot: without it the age column
              // steps left on every unassigned row and the column stops being
              // a column.
              <span className="hidden size-5 sm:block" aria-hidden />
            )}

            {/* A mark for Urgent and High only. Medium, Low and None draw
                nothing at all: a column with a mark on every row is a column
                nobody reads. */}
            <span className="hidden w-3 text-center sm:block" aria-hidden>
              {row.priorityMark !== null ? (
                <span
                  className={`${priorityToneClass(row.priorityMark)} bbl-text text-xs font-semibold`}
                >
                  {row.priorityMark === "urgent" ? "!!" : "!"}
                </span>
              ) : null}
            </span>

            <span className="w-7 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {row.age}
            </span>
          </span>

          <span className="bbl-row-actions col-start-1 row-start-1 flex items-center">
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={(event) => {
                // The row underneath opens the issue. This does something
                // else, so it must not also do that.
                event.stopPropagation();
                onStart(row.id);
              }}
              tabIndex={-1}
            >
              <Icon name="Play" className="size-3" aria-hidden />
              Start
            </button>
          </span>
        </span>
      </div>

      {row.secondLine !== null ? (
        <div className={`${toneClass(row.secondLine.tone)} flex items-center gap-2.5 pl-[1.5rem]`}>
          <span className="w-[4.75rem] shrink-0" aria-hidden />
          <span className="bbl-text truncate text-[11px]">{row.secondLine.text}</span>
        </div>
      ) : null}

      {/* The lead glyph's meaning, for anything that is not looking at it. */}
      {row.lead === "bb-fact" && row.bbFact !== "none" ? (
        <span className="sr-only">{describeBbFact(row.bbFact)}</span>
      ) : null}
    </li>
  );
}
