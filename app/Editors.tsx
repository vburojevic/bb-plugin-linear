import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DetailView } from "../src/contract.js";
import { useAsync, useLinearRpc } from "./rpc.js";

/**
 * The editable half of the detail pane.
 *
 * Every one of these was already supported by the mutation layer and reachable
 * by nothing: the pane could change a state and nothing else, so a plugin that
 * mirrors a tracker could not do the most ordinary thing anybody does to a
 * ticket — hand it to someone.
 *
 * Three rules hold across all of them.
 *
 * **A row renders whether or not it has a value.** The read-only properties
 * list drops empties, which is right for scanning; an editor cannot, because
 * empty is exactly when you want to set one.
 *
 * **Options load on first open, once per issue.** They are a local read behind
 * an rpc, but they are also two hundred labels nobody is about to look at, and
 * attaching them to every detail payload would cost that on every issue you
 * merely glance at.
 *
 * **Every picker offers "none".** Clearing a field is as much an intention as
 * setting one, and `null` is how the patch says so — `undefined` means "not
 * part of this patch", which is a different thing.
 */

export type Patch = Parameters<ReturnType<typeof useLinearRpc>["call"]>[1];

/** Loads an issue's picker options once, on the first open of any picker. */
export function useEditorOptions(issueId: string) {
  const rpc = useLinearRpc();
  const [wanted, setWanted] = useState(false);

  const options = useAsync(
    useCallback(async () => {
      if (!wanted) return null;
      return rpc.call("editorOptions", { issueId });
    }, [rpc, issueId, wanted]),
    [issueId, wanted],
  );

  return {
    want: useCallback(() => {
      setWanted(true);
    }, []),
    value: options.status === "ready" ? options.value : null,
    loading: wanted && options.status === "loading",
  };
}

export type EditorOptions = ReturnType<typeof useEditorOptions>;

/**
 * One row: a label, and a control that reads as text until you touch it.
 *
 * The trigger is a ghost button rather than a bordered control on purpose —
 * six bordered inputs stacked in a 26rem pane is a form, and this is a
 * description of an issue that happens to be editable.
 */
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="contents">
      <dt className="flex h-7 items-center text-[11px] uppercase tracking-[0.06em] text-muted-foreground opacity-70">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * The control itself.
 *
 * Loading is driven by the menu's own `onOpenChange` rather than by an
 * `onClick` here: this button is `asChild`-cloned by Radix, which composes its
 * own pointer handlers with the child's, and relying on that composition to
 * fire a side effect is exactly the sort of thing that silently stops working.
 * The menu knows when it opened; nothing else has to guess.
 */
function Trigger({
  children,
  empty,
  busy,
}: {
  children: React.ReactNode;
  empty?: boolean;
  busy: boolean;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        className={`h-7 w-full justify-start gap-1.5 px-1.5 text-[13px] font-normal ${
          empty === true ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {children}
      </Button>
    </DropdownMenuTrigger>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
      <Icon name="Loading" className="size-3 animate-spin" aria-hidden />
      Reading the team&apos;s setup…
    </div>
  );
}

/** The tick beside whatever is currently set. */
function Current({ on }: { on: boolean }) {
  return on ? <Icon name="Check" className="ml-auto size-3.5" aria-hidden /> : null;
}

export function PropertyEditors({
  detail,
  options,
  busy,
  onPatch,
}: {
  detail: DetailView;
  options: EditorOptions;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const { fields } = detail;

  return (
    <dl className="grid grid-cols-[7rem_1fr] items-center gap-y-0.5 text-[13px]">
      <Row label="Assignee">
        <DropdownMenu onOpenChange={(open) => { if (open) options.want(); }}>
          <Trigger busy={busy} empty={fields.assignee === null}>
            {fields.assignee === null ? (
              <>
                <Icon name="UserRound" className="size-3.5 opacity-60" aria-hidden />
                Unassigned
              </>
            ) : (
              <>
                <Avatar
                  initials={fields.assignee.initials}
                  avatarUrl={fields.assignee.avatarUrl}
                />
                <span className="truncate">{fields.assignee.name}</span>
              </>
            )}
          </Trigger>
          <DropdownMenuContent align="start" className="w-56">
            {options.value === null ? (
              <Loading />
            ) : (
              <>
                <DropdownMenuItem onSelect={() => onPatch({ assigneeId: null })}>
                  <Icon name="UserRound" className="size-3.5 opacity-60" aria-hidden />
                  Unassigned
                  <Current on={fields.assignee === null} />
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="bbl-scroller max-h-64 overflow-y-auto">
                  {options.value.members.map((member) => (
                    <DropdownMenuItem
                      key={member.id}
                      onSelect={() => onPatch({ assigneeId: member.id })}
                    >
                      <Avatar initials={member.initials} avatarUrl={member.avatarUrl} />
                      <span className="truncate">{member.name}</span>
                      {/* "you" rather than the viewer's own name, which they
                          already know and would have to read to recognise. */}
                      {member.isMe ? (
                        <span className="text-xs text-muted-foreground">you</span>
                      ) : null}
                      <Current on={member.id === fields.assignee?.id} />
                    </DropdownMenuItem>
                  ))}
                </div>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>

      <Row label="Priority">
        <DropdownMenu onOpenChange={(open) => { if (open) options.want(); }}>
          <Trigger busy={busy} empty={fields.priority === 0}>
            <PriorityMark priority={fields.priority} />
            <span className="truncate">{fields.priorityLabel}</span>
          </Trigger>
          <DropdownMenuContent align="start" className="w-48">
            {options.value === null ? (
              <Loading />
            ) : (
              /* The workspace's own priority strings, in the workspace's own
                 language — never five English constants compiled in. */
              options.value.priorities.map((entry) => (
                <DropdownMenuItem
                  key={entry.priority}
                  onSelect={() => onPatch({ priority: entry.priority })}
                >
                  <PriorityMark priority={entry.priority} />
                  <span>{entry.label}</span>
                  <Current on={entry.priority === fields.priority} />
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>

      {/* Estimates only exist where the team turned them on, which is a
          minority — the row is absent rather than empty on every other team. */}
      {detail.usesEstimates ? (
        <Row label="Estimate">
          <DropdownMenu onOpenChange={(open) => { if (open) options.want(); }}>
            <Trigger busy={busy} empty={fields.estimate === null}>
              <span className="truncate">{fields.estimateLabel ?? "No estimate"}</span>
            </Trigger>
            <DropdownMenuContent align="start" className="w-44">
              {options.value === null ? (
                <Loading />
              ) : (
                <>
                  <DropdownMenuItem onSelect={() => onPatch({ estimate: null })}>
                    No estimate
                    <Current on={fields.estimate === null} />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* The team's own scale, not a free number: 7 on a fibonacci
                      team is a value Linear accepts and then renders as
                      something that is not on the board. */}
                  {options.value.estimates.map((entry) => (
                    <DropdownMenuItem
                      key={entry.value}
                      onSelect={() => onPatch({ estimate: entry.value })}
                    >
                      {entry.label}
                      <Current on={entry.value === fields.estimate} />
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
      ) : null}

      <Row label="Labels">
        <DropdownMenu onOpenChange={(open) => { if (open) options.want(); }}>
          <Trigger busy={busy} empty={detail.labels.length === 0}>
            {detail.labels.length === 0 ? (
              <>
                {/* The dots below ARE the glyph once there are labels; the tag
                    only stands in for them while there are none, so the
                    column keeps its shape. */}
                <Icon name="Tag" className="size-3.5 shrink-0 opacity-60" aria-hidden />
                <span>No labels</span>
              </>
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                {detail.labels.slice(0, 3).map((label) => (
                  <span
                    key={label.id}
                    className="bbl-label-dot size-1.5 shrink-0 rounded-full"
                    style={
                      label.color === null
                        ? undefined
                        : ({ "--bbl-label": label.color } as React.CSSProperties)
                    }
                    aria-hidden
                  />
                ))}
                <span className="truncate">
                  {detail.labels.map((label) => label.name).join(", ")}
                </span>
              </span>
            )}
          </Trigger>
          <DropdownMenuContent align="start" className="w-56">
            {options.value === null ? (
              <Loading />
            ) : (
              <div className="bbl-scroller max-h-64 overflow-y-auto">
                {options.value.labels.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    This team has no labels.
                  </p>
                ) : (
                  options.value.labels.map((label) => {
                    const on = detail.labels.some((entry) => entry.id === label.id);
                    return (
                      <DropdownMenuItem
                        key={label.id}
                        // Never closes: picking labels is a multi-step act, and
                        // a menu that shuts after each one turns four labels
                        // into four round trips through the trigger.
                        onSelect={(event) => {
                          event.preventDefault();
                          // Add and remove, never a replacement set — a set
                          // built from a read taken thirty seconds ago deletes
                          // whatever somebody added in between.
                          onPatch(
                            on
                              ? { removeLabelIds: [label.id] }
                              : { addLabelIds: [label.id] },
                          );
                        }}
                      >
                        <span
                          className="bbl-label-dot size-2 shrink-0 rounded-full"
                          style={
                            label.color === null
                              ? undefined
                              : ({ "--bbl-label": label.color } as React.CSSProperties)
                          }
                          aria-hidden
                        />
                        <span className="truncate">{label.name}</span>
                        <Current on={on} />
                      </DropdownMenuItem>
                    );
                  })
                )}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>

      <Row label="Project">
        <DropdownMenu onOpenChange={(open) => { if (open) options.want(); }}>
          <Trigger busy={busy} empty={fields.projectId === null}>
            <Icon name="Folder" className="size-3.5 shrink-0 opacity-60" aria-hidden />
            <span className="truncate">{fields.projectName ?? "No project"}</span>
          </Trigger>
          <DropdownMenuContent align="start" className="w-56">
            {options.value === null ? (
              <Loading />
            ) : (
              <>
                <DropdownMenuItem onSelect={() => onPatch({ projectId: null })}>
                  No project
                  <Current on={fields.projectId === null} />
                </DropdownMenuItem>
                {options.value.projects.length > 0 ? <DropdownMenuSeparator /> : null}
                <div className="bbl-scroller max-h-64 overflow-y-auto">
                  {options.value.projects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      onSelect={() => onPatch({ projectId: project.id })}
                    >
                      <span className="truncate">{project.name}</span>
                      <Current on={project.id === fields.projectId} />
                    </DropdownMenuItem>
                  ))}
                </div>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>

      <Row label="Cycle">
        <DropdownMenu onOpenChange={(open) => { if (open) options.want(); }}>
          <Trigger busy={busy} empty={fields.cycleId === null}>
            <Icon name="Repeat" className="size-3.5 shrink-0 opacity-60" aria-hidden />
            <span className="truncate">{fields.cycleName ?? "No cycle"}</span>
          </Trigger>
          <DropdownMenuContent align="start" className="w-48">
            {options.value === null ? (
              <Loading />
            ) : options.value.cycles.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                This team does not use cycles.
              </p>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => onPatch({ cycleId: null })}>
                  No cycle
                  <Current on={fields.cycleId === null} />
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {options.value.cycles.map((cycle) => (
                  <DropdownMenuItem
                    key={cycle.id}
                    onSelect={() => onPatch({ cycleId: cycle.id })}
                  >
                    {cycle.name}
                    <Current on={cycle.id === fields.cycleId} />
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>

      <Row label="Due">
        <DueDateEditor
          value={fields.dueDate}
          label={fields.dueDateLabel}
          busy={busy}
          onPatch={onPatch}
        />
      </Row>
    </dl>
  );
}

/**
 * A native date input, because a hand-rolled calendar is a month of work to
 * get worse than the one the platform ships with a locale already applied.
 *
 * The value stays a `TimelessDate` string end to end — `YYYY-MM-DD`, which is
 * exactly what `<input type="date">` reads and writes. No `Date` is ever
 * constructed: a due date is a calendar fact, and turning it into an instant
 * picks a timezone on somebody's behalf and is wrong by a day for half the
 * planet.
 */
function DueDateEditor({
  value,
  label,
  busy,
  onPatch,
}: {
  value: string | null;
  label: string | null;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => setOpen(true)}
        className={`h-7 w-full justify-start gap-1.5 px-1.5 text-[13px] font-normal ${
          value === null ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        <Icon name="Calendar" className="size-3.5 opacity-60" aria-hidden />
        {label ?? "No due date"}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        type="date"
        autoFocus
        defaultValue={value ?? ""}
        className="h-7 text-[13px]"
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          const next = event.target.value;
          onPatch({ dueDate: next === "" ? null : next });
        }}
      />
      {value === null ? null : (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Clear the due date"
          onClick={() => {
            onPatch({ dueDate: null });
            setOpen(false);
          }}
        >
          <Icon name="CircleX" className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}

function Avatar({
  initials,
  avatarUrl,
}: {
  initials: string;
  avatarUrl: string | null;
}) {
  return (
    <span
      className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[8px] font-medium text-muted-foreground"
      aria-hidden
    >
      {avatarUrl === null ? initials : <img src={avatarUrl} alt="" className="size-4 object-cover" />}
    </span>
  );
}

/**
 * Urgent and High get a mark; Medium, Low and None do not.
 *
 * The same rule the list rows follow, for the same reason: a column with a
 * mark on every row is a column nobody reads. Here it doubles as the only
 * thing distinguishing five otherwise identical menu items at a glance.
 */
function PriorityMark({ priority }: { priority: number }) {
  // Every level draws something. In a *list* a mark on every row is noise —
  // that rule still governs the panel's rows — but this is a labelled
  // property beside Assignee's avatar and Due's calendar, so a level with no
  // glyph does not read as "quiet", it reads as broken.
  //
  // Linear's own vocabulary: three ascending bars, filled as far as the level
  // goes, with unreached bars left faint so all four bar states share one
  // silhouette and differ only in fill. Urgent breaks the pattern on purpose
  // — it is the one that should not look like "more of the same".
  const bars = (filled: number) => (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      className="bbl-neutral bbl-text w-3.5 shrink-0"
      aria-hidden
      focusable="false"
    >
      {[
        { x: 2, y: 10, height: 4 },
        { x: 6.5, y: 7, height: 7 },
        { x: 11, y: 4, height: 10 },
      ].map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.height}
          rx="1"
          fill="currentColor"
          opacity={index < filled ? 1 : 0.3}
        />
      ))}
    </svg>
  );

  if (priority === 1) {
    // Urgent: a filled square with the bar the others are missing — the only
    // solid shape in the set, so it separates at a glance in a menu of five.
    return (
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        className="bbl-danger bbl-text w-3.5 shrink-0"
        aria-hidden
        focusable="false"
      >
        <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" />
        <rect x="7.1" y="4.5" width="1.8" height="5" rx="0.9" fill="var(--background)" />
        <rect x="7.1" y="10.6" width="1.8" height="1.9" rx="0.9" fill="var(--background)" />
      </svg>
    );
  }
  if (priority === 2) return bars(3); // High
  if (priority === 3) return bars(2); // Medium
  if (priority === 4) return bars(1); // Low

  // No priority: dashes rather than empty bars, because "none" is a different
  // statement from "the lowest one".
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      className="bbl-neutral bbl-text w-3.5 shrink-0"
      aria-hidden
      focusable="false"
    >
      {[2, 6.5, 11].map((x) => (
        <rect key={x} x={x} y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" />
      ))}
    </svg>
  );
}

export { DropdownMenuLabel };
