import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Markdown, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArchiveDialog } from "./ArchiveDialog.js";
import type { DetailResult, DetailView } from "../src/contract.js";
import { toneClass } from "../src/select/tone.js";
import { StateGlyph } from "./StateGlyph.js";
import { PropertyEditors, useEditorOptions } from "./Editors.js";
import { safeHref } from "./href.js";
import { useAsync, useLinearRpc } from "./rpc.js";
import { safeRemoteMarkdown } from "../src/security-boundaries.js";
import { ReactionChips, Timeline } from "./Timeline.js";
import { NewIssueDialog } from "./NewIssue.js";
import { ProgressRing } from "./ProgressRing.js";
import { ProjectGlyph } from "./ProjectGlyph.js";
import {
  AddLinkDialog,
  ParentPickerDialog,
  RelationPickerDialog,
} from "./PaneWriteDialogs.js";
import type { PaneRelationType } from "../src/pane-write.js";
import {
  insertMention,
  mentionRangeAtCaret,
  mentionRangeAtCaretUnlessDismissed,
  type MentionRange,
} from "../src/pane-frontend.js";

/**
 * One issue, in the order you need it.
 *
 * Content before controls: identifier and state, description, properties,
 * sub-issues, comments — and the facts nobody needs first (created, creator)
 * at the bottom. Destructive actions live in the overflow menu, last.
 *
 * Linear write controls are absent when the pane's detail projection says the
 * team is not writable. That one fact combines the master switch and project
 * binding scope, so every control follows the same boundary.
 */
export function IssueDetail({
  issueId,
  onClose,
  targetCommentId,
}: {
  issueId: string;
  onClose?: () => void;
  targetCommentId?: string | null;
}) {
  const rpc = useLinearRpc();
  const [busy, setBusy] = useState(false);

  const detail = useAsync(
    useCallback(async () => (await rpc.call("issue", { id: issueId })).result, [rpc, issueId]),
    [issueId],
  );
  useRealtime("linear:data", detail.reload);

  const change = useCallback(
    async (patch: Parameters<typeof rpc.call<"updateIssue">>[1]) => {
      setBusy(true);
      try {
        const result = await rpc.call("updateIssue", patch);
        if (!result.ok) {
          toast.error(result.message ?? "That didn't work.");
          return false;
        }
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That didn't work.");
        return false;
      } finally {
        setBusy(false);
        detail.reload();
      }
    },
    [rpc, detail],
  );

  if (detail.status === "loading") {
    return <p className="p-4 text-sm text-muted-foreground">Reading the issue…</p>;
  }
  if (detail.status === "failed") {
    return <p className="p-4 text-sm text-destructive">{detail.message}</p>;
  }

  return (
    <DetailBody
      result={detail.value}
      busy={busy}
      onChange={change}
      onClose={onClose}
      onReload={detail.reload}
      targetCommentId={targetCommentId}
    />
  );
}

function DetailBody({
  result,
  busy,
  onChange,
  onClose,
  onReload,
  targetCommentId,
}: {
  result: DetailResult;
  busy: boolean;
  onChange: (patch: Record<string, unknown> & { id: string }) => Promise<boolean>;
  onClose?: () => void;
  onReload: () => void;
  targetCommentId?: string | null;
}) {
  if (result.kind === "loading") {
    return <p className="p-4 text-sm text-muted-foreground">Reading the issue…</p>;
  }

  if (result.kind === "missing") {
    return (
      <div className="space-y-2 p-4">
        <p className="text-sm text-foreground">
          There is no issue called <strong>{result.identifier}</strong> in this workspace.
        </p>
        <p className="text-sm text-muted-foreground">
          It may have been deleted, or the identifier may be from a different workspace.
        </p>
      </div>
    );
  }

  if (result.kind === "refused") {
    // The one place in the UI where a stranger meets the scoping rule — and
    // where the rule teaches itself, by naming both teams and the way out.
    return (
      <div className="space-y-3 p-4">
        <div className="bbl-triage bbl-notice px-3 py-2" role="status">
          <p className="bbl-text text-sm">{result.message}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Bind teams from the Linear panel, or on the command line:{" "}
          <code className="text-foreground">bb linear bind &lt;TEAM-KEY&gt;</code>.
        </p>
      </div>
    );
  }

  return (
    <IssueBody
      detail={result.detail}
      busy={busy}
      onChange={onChange}
      onClose={onClose}
      onReload={onReload}
      targetCommentId={targetCommentId}
    />
  );
}

function IssueBody({
  detail,
  busy,
  onChange,
  onClose,
  onReload,
  targetCommentId,
}: {
  detail: DetailView;
  busy: boolean;
  onChange: (patch: Record<string, unknown> & { id: string }) => Promise<boolean>;
  onClose?: () => void;
  onReload: () => void;
  targetCommentId?: string | null;
}) {
  /*
   * `detail.id` and never the `issueId` prop.
   *
   * The prop is whatever the caller had: the nav panel opens this from a deep
   * link and passes an *identifier* ("ENG-42"), the thread panel passes a
   * UUID. Every mutation and every option lookup keys on the real id, so
   * taking it from the loaded issue is the only thing that is right for both —
   * and it is what the comment composer has always done, which is why comments
   * worked from a pane whose state picker did not.
   */
  const id = detail.id;
  const options = useEditorOptions(id);
  const rpc = useLinearRpc();
  const navigate = useBbNavigate();
  const parent = detail.parent;

  const clearParent = useCallback(() => {
    void (async () => {
      try {
        const result = await rpc.call("setParent", { issueId: id, parentId: null });
        if (!result.ok) toast.error(result.message ?? "The parent wasn't removed.");
        else onReload();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The parent wasn't removed.");
      }
    })();
  }, [rpc, id, onReload]);

  return (
    <div
      className={`${toneClass(detail.tone)} flex h-full flex-col`}
      style={detail.stateColor === null ? undefined : ({ "--bbl": detail.stateColor } as CSSProperties)}
    >
      {/* The body scrolls inside a fixed cap and the composer is pinned
          outside the scroller — a control that scrolls out of its own panel is
          one you have to hunt for. */}
      <div className="bbl-scroller flex-1 overflow-y-auto">
        {/*
          The identifier bar is sticky and the only thing in the pane that is.
          Scrolled forty comments down, "which issue am I in" is the one
          question the pane must never make you scroll back up to answer.
        */}
        <header className="bbl-section sticky top-0 z-10 flex items-center gap-2 px-4 py-2">
          <span className="bbl-text font-mono text-[11px] tabular-nums">
            {detail.identifier}
          </span>
          {detail.teamName === "" ? null : (
            <span className="truncate text-[11px] text-muted-foreground opacity-70">
              {detail.teamName}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
              {safeHref(detail.url) !== undefined ? (
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" asChild>
                  <a href={safeHref(detail.url)} target="_blank" rel="noreferrer">
                    Open in Linear
                    <Icon name="ExternalLink" className="size-3" aria-hidden />
                  </a>
                </Button>
              ) : null}
            <DetailMenu detail={detail} onClose={onClose} onReload={onReload} />
            {onClose !== undefined ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onClose}
                aria-label="Close this issue"
              >
                <Icon name="CircleX" className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        </header>

        {/*
          Zones, separated by a hairline rather than by spacing alone.

          The pane holds four different kinds of thing — what this issue is,
          what is true about it, what it contains, and what people said — and
          run together at one rhythm they read as a single long column that has
          to be parsed from the top. The rules cost 1px and let you jump.
        */}
        <div className="space-y-3 px-4 py-3">
          {parent === null ? null : (
            <div className="flex max-w-full items-center gap-1 text-[11px] text-muted-foreground">
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 text-left hover:text-foreground"
                onClick={() =>
                  navigate.toPluginPanel("linear", { subPath: `i/${parent.identifier}` })
                }
              >
                <Icon name="ArrowTurnBackward" className="size-3 shrink-0" aria-hidden />
                <span className="shrink-0">Sub-issue of</span>
                <span className="shrink-0 font-mono tabular-nums">{parent.identifier}</span>
                <span className="truncate">{parent.title}</span>
              </button>
              {detail.writable ? (
                <button
                  type="button"
                  className="grid size-5 shrink-0 place-items-center rounded hover:bg-state-hover hover:text-foreground"
                  aria-label={`Remove parent ${parent.identifier}`}
                  onClick={clearParent}
                >
                  <Icon name="X" className="size-3" aria-hidden />
                </button>
              ) : null}
            </div>
          )}
          <InlineTitle
            detail={detail}
            busy={busy}
            onSave={(title) => onChange({ id, title })}
          />

          <div className="flex flex-wrap items-center gap-1.5">
            {detail.writable ? (
              <StatePicker detail={detail} busy={busy} onChange={onChange} issueId={id} />
            ) : (
              <span className="inline-flex h-7 items-center gap-1.5 text-xs text-foreground">
                <StateGlyph tone={detail.tone} glyph={detail.glyph} />
                {detail.stateName}
              </span>
            )}

            {/* Labels sit with the state rather than in their own band: they
                are the same kind of fact, and a row of pills alone under a
                heading is a band that looks like it lost its label. */}
            {detail.labels.map((label) => (
              <span
                key={label.id}
                className="bbl-label inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]"
                // Inline rather than a class: the workspace picks this hue at
                // runtime, and there is no class name for a colour nobody knew
                // about at build time.
                style={label.color === null ? undefined : { "--bbl-label": label.color } as React.CSSProperties}
              >
                <span className="bbl-label-dot size-1.5 shrink-0 rounded-full" aria-hidden />
                {label.name}
              </span>
            ))}
          </div>
        </div>

        {/* bb's own chat-message renderer, so a Linear description reads like
            the rest of the app rather than like a differently-styled bundled
            renderer. */}
        <div className="border-t border-border px-4 py-3">
          <DescriptionEditor
            detail={detail}
            busy={busy}
            onSave={(description) => onChange({ id, description })}
          />
          <ReactionChips
            reactions={detail.reactions}
            writable={detail.writable}
            issueId={detail.id}
            onReload={onReload}
          />
        </div>

        <div className="border-t border-border px-4 py-3">
          {detail.writable ? (
            <PropertyEditors
              detail={detail}
              options={options}
              busy={busy}
              onPatch={(patch) => onChange({ id, ...patch })}
            />
          ) : (
            <ReadOnlyProperties properties={detail.properties} />
          )}
          <Subscribers subscribers={detail.subscribers} />
        </div>

        {detail.subIssues.length > 0 || detail.writable ? (
          <section className="border-t border-border px-4 py-3">
            <SubIssuesHeader detail={detail} onReload={onReload} />
            <ul className="mt-2 space-y-1">
              {detail.subIssues.map((child) => (
                <li
                  key={child.id}
                  className={`${toneClass(child.tone)} flex items-center gap-2.5 rounded-md px-1 py-1`}
                  style={child.glyph.color === null ? undefined : ({ "--bbl": child.glyph.color } as CSSProperties)}
                >
                  <StateGlyph tone={child.tone} glyph={child.glyph} />
                  <span className="w-[4.75rem] shrink-0 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                    {child.identifier}
                  </span>
                  <span
                    className={`truncate text-[13px] ${
                      child.done ? "text-muted-foreground line-through" : "text-foreground"
                    }`}
                  >
                    {child.title}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <Relations
          detail={detail}
          relations={detail.relations}
          onReload={onReload}
          onOpen={(identifier) =>
            navigate.toPluginPanel("linear", { subPath: `i/${identifier}` })
          }
        />

        <Resources groups={detail.resources.groups} />

        <CustomerRequests requests={detail.customerRequests} />

        {detail.footnotes.length > 0 ? (
          <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-3 text-[11px] text-muted-foreground opacity-70">
            {detail.footnotes.map((note) => (
              <span key={note.key}>
                {note.label}: {note.value}
              </span>
            ))}
          </footer>
        ) : null}

        <Timeline
          detail={detail}
          onReload={onReload}
          targetCommentId={targetCommentId}
        />
      </div>

      {detail.writable ? (
        <CommentComposer
          issueId={detail.id}
          teamId={detail.teamId}
          identifier={detail.identifier}
        />
      ) : null}
    </div>
  );
}

function StatePicker({
  detail,
  busy,
  onChange,
  issueId,
}: {
  detail: DetailView;
  busy: boolean;
  onChange: (patch: Record<string, unknown> & { id: string }) => void;
  issueId: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={busy}
          // The visible text is just the state's name, which reads as a fact,
          // not a control — and collides with the list's group headers for
          // anything navigating by accessible name.
          aria-label={`Change state — currently ${detail.stateName}`}
        >
          <StateGlyph tone={detail.tone} glyph={detail.glyph} />
          {detail.stateName}
          <Icon name="ChevronDown" className="size-3" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {/* The team's own state names, grouped by type in position order —
            Linear's ordering, which puts Triage above Backlog above In
            Progress rather than alphabetically. */}
        {detail.stateOptions.map((option) => (
          <DropdownMenuItem
            key={option.id}
            className={toneClass(option.tone)}
            style={option.glyph.color === null ? undefined : ({ "--bbl": option.glyph.color } as CSSProperties)}
            onSelect={() => onChange({ id: issueId, stateId: option.id })}
          >
            <StateGlyph tone={option.tone} glyph={option.glyph} />
            <span>{option.name}</span>
            {option.id === detail.stateId ? (
              <Icon name="Check" className="ml-auto size-3.5" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InlineTitle({
  detail,
  busy,
  onSave,
}: {
  detail: DetailView;
  busy: boolean;
  onSave: (title: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(detail.title);
  const cancelRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(detail.title);
  }, [detail.title, editing]);

  const titleClass = `text-[15px] font-semibold leading-snug ${
    detail.struckThrough ? "text-muted-foreground line-through" : "text-foreground"
  }`;

  if (!detail.writable) return <h2 className={titleClass}>{detail.title}</h2>;
  if (!editing) {
    return (
      <h2 className={titleClass}>
        <button
          type="button"
          className="w-full rounded text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setEditing(true)}
          aria-label="Edit issue title"
        >
          {detail.title}
        </button>
      </h2>
    );
  }

  const commit = async () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setEditing(false);
      return;
    }
    const title = value.trim();
    if (title === "" || title === detail.title) {
      setValue(detail.title);
      setEditing(false);
      return;
    }
    if (await onSave(title)) {
      setEditing(false);
    } else {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      value={value}
      disabled={busy}
      className="h-8 text-[15px] font-semibold"
      aria-label="Issue title"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelRef.current = true;
          setValue(detail.title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function DescriptionEditor({
  detail,
  busy,
  onSave,
}: {
  detail: DetailView;
  busy: boolean;
  onSave: (description: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(detail.descriptionSource ?? "");

  useEffect(() => {
    if (!editing) setValue(detail.descriptionSource ?? "");
  }, [detail.descriptionSource, editing]);

  if (editing) {
    return (
      <div className="space-y-2">
        <Textarea
          autoFocus
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          className="min-h-28 text-sm"
          aria-label="Issue description"
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setValue(detail.descriptionSource ?? "");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              void onSave(value).then((ok) => {
                if (ok) setEditing(false);
              });
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {detail.writable ? (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0 size-7 text-muted-foreground"
          aria-label="Edit issue description"
          onClick={() => setEditing(true)}
        >
          <Icon name="Edit" className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      <div className={detail.writable ? "pr-8" : undefined}>
        {detail.description !== null && detail.description.trim() !== "" ? (
          <Markdown content={safeRemoteMarkdown(detail.description)} />
        ) : (
          <p className="text-sm italic text-muted-foreground opacity-70">No description.</p>
        )}
      </div>
    </div>
  );
}

function ReadOnlyProperties({ properties }: { properties: DetailView["properties"] }) {
  if (properties.length === 0) return null;
  return (
    <dl className="grid grid-cols-[7rem_1fr] items-center gap-y-0.5 text-[13px]">
      {properties.map((property) => (
        <div key={property.key} className="contents">
          <dt className="flex min-h-7 items-center text-[11px] uppercase tracking-[0.06em] text-muted-foreground opacity-70">
            {property.label}
          </dt>
          <dd className="flex min-w-0 items-center gap-1.5 truncate px-1.5 text-foreground">
            {property.projectGlyph === undefined ? null : (
              <ProjectGlyph glyph={property.projectGlyph} />
            )}
            <span className="truncate">{property.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SubIssuesHeader({ detail, onReload }: { detail: DetailView; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2">
        <SectionLabel>
          Sub-issues
          <span
            className="ml-1.5 inline-flex items-center gap-1.5 tabular-nums"
            role="img"
            aria-label={`${detail.subIssues.filter((child) => child.done).length} of ${detail.subIssues.length} done`}
            title={`${detail.subIssues.filter((child) => child.done).length} of ${detail.subIssues.length} done`}
          >
            <ProgressRing
              done={detail.subIssues.filter((child) => child.done).length}
              total={detail.subIssues.length}
              color={detail.completedStateColor}
            />
            <span aria-hidden="true">
              {detail.subIssues.filter((child) => child.done).length}/{detail.subIssues.length}
            </span>
          </span>
        </SectionLabel>
        {detail.writable ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1 px-2 text-xs"
            onClick={() => setOpen(true)}
          >
            <Icon name="Plus" className="size-3.5" aria-hidden />
            Add sub-issue…
          </Button>
        ) : null}
      </div>
      {detail.writable ? (
        <NewIssueDialog
          open={open}
          onOpenChange={setOpen}
          currentTeamId={detail.teamId}
          parent={{ id: detail.id, identifier: detail.identifier }}
          onCreated={onReload}
        />
      ) : null}
    </>
  );
}

/**
 * The pane's own copy of the row actions.
 *
 * The list offers these on hover and right-click — two affordances a touch
 * pointer does not have, which made the detail pane the only surface a phone
 * can reach and the one surface with no actions on it. Same items, same
 * order, destructive last behind a separator.
 */
function DetailMenu({
  detail,
  onClose,
  onReload,
}: {
  detail: DetailView;
  onClose?: () => void;
  onReload: () => void;
}) {
  const rpc = useLinearRpc();
  const navigate = useBbNavigate();
  const [archiving, setArchiving] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const [settingParent, setSettingParent] = useState(false);

  const start = useCallback(() => {
    void (async () => {
      const result = await rpc.call("startThread", { issueId: detail.id });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.note === null ? result.message : `${result.message} ${result.note}`);
      if (result.threadId !== null) navigate.toThread(result.threadId);
    })();
  }, [rpc, navigate, detail.id]);

  const confirmArchive = useCallback(() => {
    setArchiving(false);
    void (async () => {
      const result = await rpc.call("archiveIssue", { id: detail.id });
      if (result.ok) {
        toast.success(`Archived ${detail.identifier}.`);
        // The pane is showing an issue that is no longer in the mirror;
        // leaving it open would render a ghost.
        onClose?.();
      } else {
        toast.error(result.message ?? `Couldn't archive ${detail.identifier}.`);
      }
    })();
  }, [rpc, detail.id, detail.identifier, onClose]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`More actions for ${detail.identifier}`}
          >
            <Icon name="MoreHorizontal" className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={start}>
            Start a thread from this issue
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void navigator.clipboard?.writeText(detail.identifier)}
          >
            Copy identifier
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void navigator.clipboard?.writeText(detail.branchName ?? detail.identifier)
            }
          >
            Copy branch name
          </DropdownMenuItem>
          {detail.writable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setAddingLink(true)}>
                Add link…
              </DropdownMenuItem>
              {detail.parent === null ? (
                <DropdownMenuItem onSelect={() => setSettingParent(true)}>
                  Set parent…
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setArchiving(true)}
              >
                Archive
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {detail.writable ? (
        <>
          <AddLinkDialog
            issueId={detail.id}
            open={addingLink}
            onOpenChange={setAddingLink}
            onAdded={onReload}
          />
          <ParentPickerDialog
            issueId={detail.id}
            teamId={detail.teamId}
            open={settingParent}
            onOpenChange={setSettingParent}
            onSet={async (parentId) => {
              try {
                const result = await rpc.call("setParent", { issueId: detail.id, parentId });
                if (!result.ok) {
                  toast.error(result.message ?? "The parent wasn't changed.");
                  return false;
                }
                onReload();
                return true;
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "The parent wasn't changed.");
                return false;
              }
            }}
          />
          <ArchiveDialog
            target={archiving ? detail : null}
            onCancel={() => setArchiving(false)}
            onConfirm={confirmArchive}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * A section's label, in the one voice the pane uses for them.
 *
 * Micro-caps at 11px with wide tracking reads as a label rather than as
 * content, which is the whole job: it has to name the zone underneath without
 * competing with anything in it.
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="flex items-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground opacity-80">
      {children}
    </h3>
  );
}

function Subscribers({ subscribers }: { subscribers: DetailView["subscribers"] }) {
  const [expanded, setExpanded] = useState(false);
  const names = subscribers.people.map((person) => person.displayName).join(", ");
  return (
    <div className="mt-0.5 grid grid-cols-[7rem_1fr] items-start text-[13px]">
      <span className="flex h-7 items-center text-[11px] uppercase tracking-[0.06em] text-muted-foreground opacity-70">
        Subscribers
      </span>
      <div className="min-w-0">
        <button
          type="button"
          className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-state-hover"
          title={names === "" ? "No subscribers" : names}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="flex min-w-10 -space-x-1.5" aria-hidden>
            {subscribers.people.slice(0, 4).map((person) => (
              <span
                key={person.id}
                className="grid size-5 place-items-center rounded-full border border-background bg-muted text-[8px] font-medium text-muted-foreground"
              >
                {person.initials}
              </span>
            ))}
            {subscribers.people.length === 0 ? (
              <Icon name="UserRound" className="size-4 text-muted-foreground" aria-hidden />
            ) : null}
          </span>
          <span className="truncate text-[12px] text-muted-foreground">
            {subscribers.count} subscriber{subscribers.count === 1 ? "" : "s"}
          </span>
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            className="ml-auto size-3 text-muted-foreground"
            aria-hidden
          />
        </button>
        {expanded ? (
          <ul className="mt-1 space-y-1 px-1.5">
            {subscribers.people.length === 0 ? (
              <li className="text-[11px] text-muted-foreground">No subscribers.</li>
            ) : (
              subscribers.people.map((person) => (
                <li key={person.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                  <span
                    className="grid size-5 place-items-center rounded-full bg-muted text-[8px] text-muted-foreground"
                    aria-hidden
                  >
                    {person.initials}
                  </span>
                  {person.displayName}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Relations({
  detail,
  relations,
  onOpen,
  onReload,
}: {
  detail: DetailView;
  relations: DetailView["relations"];
  onOpen: (identifier: string) => void;
  onReload: () => void;
}) {
  const rpc = useLinearRpc();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const groups = [
    { label: "Blocked by", items: relations.blockedBy },
    { label: "Blocks", items: relations.blocks },
    { label: "Related", items: relations.related },
    // Two directions, two headings: being a duplicate OF ABC-12 and HAVING
    // duplicate ABC-12 are opposite facts, and one heading would swap them.
    { label: "Duplicate of", items: relations.duplicateOf },
    { label: "Duplicates", items: relations.duplicates },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0 && !detail.writable) return null;

  const remove = (relationId: string) => {
    if (removing !== null) return;
    setRemoving(relationId);
    void (async () => {
      try {
        const result = await rpc.call("unrelate", { relationId });
        if (!result.ok) toast.error(result.message ?? "That relation wasn't removed.");
        else onReload();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That relation wasn't removed.");
      } finally {
        setRemoving(null);
      }
    })();
  };

  return (
    <section className="border-t border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <SectionLabel>Relations</SectionLabel>
        {detail.writable ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1 px-2 text-xs"
            onClick={() => setAdding(true)}
          >
            <Icon name="Plus" className="size-3.5" aria-hidden />
            Add relation…
          </Button>
        ) : null}
      </div>
      <div className="mt-2 space-y-3">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="mb-1 text-[11px] text-muted-foreground">
              {group.label} <span className="tabular-nums opacity-70">{group.items.length}</span>
            </p>
            <ul className="space-y-1">
              {group.items.map((relation) => (
                <li key={relation.relationId} className="flex items-center gap-1">
                  <button
                    type="button"
                    className={`${toneClass(relation.tone)} flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left hover:bg-state-hover`}
                    style={relation.glyph.color === null ? undefined : ({ "--bbl": relation.glyph.color } as CSSProperties)}
                    onClick={() => onOpen(relation.identifier)}
                  >
                    <StateGlyph tone={relation.tone} glyph={relation.glyph} />
                    <span className="w-[4.75rem] shrink-0 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                      {relation.identifier}
                    </span>
                    <span
                      className={`truncate text-[13px] ${
                        relation.done ? "text-muted-foreground line-through" : "text-foreground"
                      }`}
                    >
                      {relation.title}
                    </span>
                  </button>
                  {detail.writable && relation.removable ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 text-muted-foreground"
                      disabled={removing === relation.relationId}
                      aria-label={`Remove relation to ${relation.identifier}`}
                      onClick={() => remove(relation.relationId)}
                    >
                      <Icon name="X" className="size-3" aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {detail.writable ? (
        <RelationPickerDialog
          issueId={detail.id}
          teamId={detail.teamId}
          open={adding}
          onOpenChange={setAdding}
          onRelate={async (relatedIssueId, type: PaneRelationType) => {
            try {
              const result = await rpc.call("relate", {
                issueId: detail.id,
                relatedIssueId,
                type,
              });
              if (!result.ok) {
                toast.error(result.message ?? "That relation wasn't added.");
                return false;
              }
              onReload();
              return true;
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "That relation wasn't added.");
              return false;
            }
          }}
        />
      ) : null}
    </section>
  );
}

function Resources({ groups }: { groups: DetailView["resources"]["groups"] }) {
  if (groups.length === 0) return null;
  return (
    <section className="border-t border-border px-4 py-3">
      <SectionLabel>Resources</SectionLabel>
      <div className="mt-2 space-y-3">
        {groups.map((group) => (
          <div key={group.source}>
            <p className="mb-1 text-[11px] text-muted-foreground">
              {group.label} <span className="tabular-nums opacity-70">{group.items.length}</span>
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const href = safeHref(item.url);
                const content = (
                  <>
                    <Icon
                      name={resourceIcon(group.source, item.kind)}
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{item.title}</span>
                      {item.subtitle === null || item.subtitle === "" ? null : (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                    <Icon name="ExternalLink" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  </>
                );
                return (
                  <li key={item.id}>
                    {href === undefined ? (
                      <div className="flex items-center gap-2 rounded-md px-1 py-1">{content}</div>
                    ) : (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-state-hover"
                      >
                        {content}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function resourceIcon(
  source: string,
  kind: DetailView["resources"]["groups"][number]["items"][number]["kind"],
): "Github" | "FileText" | "ExternalLink" | "Paperclip" {
  if (kind === "document") return "FileText";
  if (source.toLowerCase() === "github") return "Github";
  // Every row already ends in the external-link glyph; a second one in the
  // leading slot reads as a typo.
  return "Paperclip";
}

function CustomerRequests({ requests }: { requests: DetailView["customerRequests"] }) {
  if (requests.length === 0) return null;
  return (
    <section className="border-t border-border px-4 py-3">
      <SectionLabel>Customer requests</SectionLabel>
      <ul className="mt-2 space-y-1">
        {requests.map((request) => {
          const href = request.url === null ? undefined : safeHref(request.url);
          const content = (
            <>
              <span
                className={`${request.priority >= 3 ? "bbl-danger" : request.priority >= 2 ? "bbl-triage" : "bbl-neutral"} bbl-glyph`}
                title={`Priority ${String(request.priority)}`}
              >
                <Icon name="AlertTriangle" className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-foreground">
                  {request.customer}
                </span>
                <span className="block text-[12px] leading-snug text-muted-foreground">
                  {request.excerpt}
                </span>
              </span>
              {href === undefined ? null : (
                <Icon name="ExternalLink" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              )}
            </>
          );
          return (
            <li key={request.id}>
              {href === undefined ? (
                <div className="flex items-start gap-2 rounded-md px-1 py-1.5">{content}</div>
              ) : (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start gap-2 rounded-md px-1 py-1.5 hover:bg-state-hover"
                >
                  {content}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * A plain textarea, by choice.
 *
 * Markdown in, markdown out: mention insertion, but no paste-image or toolbar.
 * bb owns the rich composer and this plugin refuses to ship a second one — a
 * textarea that posts is honest, while a half-rich editor is not.
 *
 * Posting is optimistic with a **named rollback**: on failure the text comes
 * back to the box, because losing what somebody typed is a much worse failure
 * than the one that actually happened.
 */
function CommentComposer({
  issueId,
  teamId,
  identifier,
}: {
  issueId: string;
  teamId: string;
  identifier: string;
}) {
  const rpc = useLinearRpc();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<MentionRange | null>(null);
  const dismissedMentionRef = useRef<Pick<
    MentionRange,
    "start" | "query"
  > | null>(null);
  const [debouncedMention, setDebouncedMention] = useState<MentionRange | null>(null);
  const [activeCandidate, setActiveCandidate] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const updateMentionFromSelection = useCallback(
    (value: string, caret: number) => {
      const dismissedMention = dismissedMentionRef.current;
      const next = mentionRangeAtCaretUnlessDismissed(value, caret, dismissedMention);
      if (dismissedMention !== null && next !== null) dismissedMentionRef.current = null;
      setMention(next);
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedMention(mention), 150);
    return () => window.clearTimeout(timer);
  }, [mention]);

  const candidates = useAsync(
    useCallback(async () => {
      if (debouncedMention === null) return { candidates: [] };
      return rpc.call("mentionCandidates", {
        teamId,
        query: debouncedMention.query,
      });
    }, [rpc, teamId, debouncedMention]),
    [teamId, debouncedMention?.query],
    debouncedMention !== null,
  );
  const mentionSearchCurrent =
    mention !== null &&
    debouncedMention !== null &&
    mention.start === debouncedMention.start &&
    mention.end === debouncedMention.end &&
    mention.query === debouncedMention.query;
  const mentionSearching =
    candidates.status === "loading" ||
    (candidates.status === "ready" && candidates.refreshing);
  const mentionCandidates =
    candidates.status === "ready" && !candidates.refreshing && mentionSearchCurrent
      ? candidates.value.candidates
      : [];

  useEffect(() => {
    setActiveCandidate(0);
  }, [debouncedMention?.query]);

  const chooseMention = useCallback(
    (candidate: { id: string; displayName: string }) => {
      if (mention === null) return;
      const insertion = insertMention(body, mention, candidate);
      setBody(insertion.value);
      setMention(null);
      setDebouncedMention(null);
      dismissedMentionRef.current = null;
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(insertion.caret, insertion.caret);
      });
    },
    [body, mention],
  );

  const post = useCallback(async () => {
    const text = body.trim();
    if (text === "") return;
    setBusy(true);
    setBody("");
    setMention(null);
    dismissedMentionRef.current = null;
    try {
      const result = await rpc.call("comment", { issueId, body: text });
      if (!result.ok) {
        setBody(text);
        toast.error(
          result.message ??
            `Couldn't post that comment on ${identifier}. It's still here — try again.`,
        );
      }
    } catch (error) {
      setBody(text);
      toast.error(
        error instanceof Error
          ? `Couldn't post that comment: ${error.message} It's still here — try again.`
          : "Couldn't post that comment. It's still here — try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [body, issueId, identifier, rpc]);

  return (
    <div className="border-t border-border p-3">
      <Textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => {
          const next = event.target.value;
          setBody(next);
          dismissedMentionRef.current = null;
          setMention(mentionRangeAtCaret(next, event.target.selectionStart));
        }}
        onClick={(event) =>
          updateMentionFromSelection(body, event.currentTarget.selectionStart)
        }
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void post();
          } else if (mention !== null && mentionCandidates.length > 0 && event.key === "ArrowDown") {
            event.preventDefault();
            setActiveCandidate((value) => (value + 1) % mentionCandidates.length);
          } else if (mention !== null && mentionCandidates.length > 0 && event.key === "ArrowUp") {
            event.preventDefault();
            setActiveCandidate(
              (value) => (value - 1 + mentionCandidates.length) % mentionCandidates.length,
            );
          } else if (mention !== null && mentionCandidates.length > 0 && event.key === "Enter") {
            event.preventDefault();
            const candidate = mentionCandidates[activeCandidate];
            if (candidate !== undefined) chooseMention(candidate);
          } else if (mention !== null && event.key === "Escape") {
            event.preventDefault();
            dismissedMentionRef.current = { start: mention.start, query: mention.query };
            setMention(null);
            setDebouncedMention(null);
          }
        }}
        onSelect={(event) =>
          updateMentionFromSelection(body, event.currentTarget.selectionStart)
        }
        placeholder={`Comment on ${identifier} — Markdown`}
        aria-label={`Comment on ${identifier}`}
        rows={2}
        className="resize-none text-sm"
      />
      {mention !== null && debouncedMention !== null ? (
        <div className="mt-1 rounded-md border border-border bg-popover p-1 shadow-sm">
          {mentionSearching || !mentionSearchCurrent ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Finding people…</p>
          ) : mentionCandidates.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching people.</p>
          ) : (
            <ul className="bbl-scroller max-h-48 overflow-y-auto">
              {mentionCandidates.map((candidate, index) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                      index === activeCandidate ? "bg-state-active" : "hover:bg-state-hover"
                    }`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseMention(candidate)}
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {candidate.displayName}
                    </span>
                    <span className="shrink-0 text-muted-foreground">@{candidate.handle}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {/*
        `pr-12` clears bb's own floating action button, which is fixed to the
        bottom-right of the window and sits directly over this corner. Found by
        screenshotting the pane rather than by reading it: the Comment button
        was half-covered and looked disabled.
      */}
      <div className="mt-2 flex items-center justify-end gap-2 pr-12">
        <span className="text-[11px] text-muted-foreground opacity-70">⌘↵ to post</span>
        <Button size="sm" disabled={busy || body.trim() === ""} onClick={() => void post()}>
          Comment
        </Button>
      </div>
    </div>
  );
}
