import { useCallback, useState } from "react";
import { Markdown, useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DetailResult, DetailView } from "../src/contract.js";
import { formatDateTime } from "../src/format.js";
import { toneClass } from "../src/select/tone.js";
import { StateGlyph } from "./StateGlyph.js";
import { PropertyEditors, useEditorOptions } from "./Editors.js";
import { safeHref } from "./href.js";
import { useAsync, useLinearRpc } from "./rpc.js";
import { safeRemoteMarkdown } from "../src/security-boundaries.js";

/**
 * One issue, in the order you need it.
 *
 * Content before controls: identifier and state, description, properties,
 * sub-issues, comments — and the facts nobody needs first (created, creator)
 * at the bottom. Destructive actions live in the overflow menu, last.
 *
 * **Every mutating control renders enabled.** Linear does not expose a key's
 * scopes, so rendering them disabled would be a claim the plugin cannot
 * substantiate, and hiding them would make a read-only key look like a broken
 * build. They fail in a sentence on click instead, and the Connection section
 * grows a line saying so.
 */
export function IssueDetail({ issueId, onClose }: { issueId: string; onClose?: () => void }) {
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
        if (!result.ok) toast.error(result.message ?? "That didn't work.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That didn't work.");
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
    <DetailBody result={detail.value} busy={busy} onChange={change} onClose={onClose} />
  );
}

function DetailBody({
  result,
  busy,
  onChange,
  onClose,
}: {
  result: DetailResult;
  busy: boolean;
  onChange: (patch: Record<string, unknown> & { id: string }) => void;
  onClose?: () => void;
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
          Bindings live in this plugin&apos;s settings — the Linear button in bb&apos;s sidebar
          footer opens that page.
        </p>
      </div>
    );
  }

  return (
    <IssueBody detail={result.detail} busy={busy} onChange={onChange} onClose={onClose} />
  );
}

function IssueBody({
  detail,
  busy,
  onChange,
  onClose,
}: {
  detail: DetailView;
  busy: boolean;
  onChange: (patch: Record<string, unknown> & { id: string }) => void;
  onClose?: () => void;
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

  return (
    <div className={`${toneClass(detail.tone)} flex h-full flex-col`}>
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
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
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
          <h2
            className={`text-[15px] font-semibold leading-snug ${
              detail.struckThrough ? "text-muted-foreground line-through" : "text-foreground"
            }`}
          >
            {detail.title}
          </h2>

          <div className="flex flex-wrap items-center gap-1.5">
            <StatePicker detail={detail} busy={busy} onChange={onChange} issueId={id} />

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
          {detail.description !== null && detail.description.trim() !== "" ? (
            <Markdown content={safeRemoteMarkdown(detail.description)} />
          ) : (
            <p className="text-sm italic text-muted-foreground opacity-70">No description.</p>
          )}
        </div>

        <div className="border-t border-border px-4 py-3">
          <PropertyEditors
            detail={detail}
            options={options}
            busy={busy}
            onPatch={(patch) => onChange({ id, ...patch })}
          />
        </div>

        {detail.subIssues.length > 0 ? (
          <section className="border-t border-border px-4 py-3">
            <SectionLabel>
              Sub-issues
              <span className="bbl-count ml-1.5 rounded-full px-1.5 py-px tabular-nums">
                {detail.subIssues.filter((child) => child.done).length} of{" "}
                {detail.subIssues.length}
              </span>
            </SectionLabel>
            <ul className="mt-2 space-y-1">
              {detail.subIssues.map((child) => (
                <li
                  key={child.id}
                  className={`${toneClass(child.tone)} flex items-center gap-2.5 rounded-md px-1 py-1`}
                >
                  <StateGlyph tone={child.tone} />
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

        <Comments detail={detail} />

        {detail.footnotes.length > 0 ? (
          <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-3 text-[11px] text-muted-foreground opacity-70">
            {detail.footnotes.map((note) => (
              <span key={note.key}>
                {note.label}: {note.value}
              </span>
            ))}
          </footer>
        ) : null}
      </div>

      <CommentComposer issueId={detail.id} identifier={detail.identifier} />
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
          <StateGlyph tone={detail.tone} />
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
            onSelect={() => onChange({ id: issueId, stateId: option.id })}
          >
            <StateGlyph tone={option.tone} />
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

/**
 * A conversation, not a stack of cards.
 *
 * Six comments as six bordered boxes is six competing containers. An avatar
 * column and one continuous rail down the left says "this is one thread" and
 * costs a single pixel — and it is the same rail a reply hangs off, so nesting
 * needs no second vocabulary.
 */
function Comments({ detail }: { detail: DetailView }) {
  if (detail.comments.length === 0) return null;
  return (
    <section className="border-t border-border px-4 py-3">
      <SectionLabel>
        Comments
        <span className="bbl-count ml-1.5 rounded-full px-1.5 py-px tabular-nums">
          {detail.comments.length}
        </span>
      </SectionLabel>

      <ul className="mt-3 space-y-3.5">
        {detail.comments.map((comment) => (
          <li
            key={comment.id}
            className={`flex gap-2.5 ${comment.parentId === null ? "" : "bbl-rail ml-3 pl-3"}`}
          >
            <span
              className="mt-0.5 grid size-6 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
              aria-hidden
            >
              {comment.authorInitials}
            </span>

            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-foreground">{comment.author}</span>
                {comment.createdAt !== null ? (
                  <span className="text-[11px] text-muted-foreground opacity-70">
                    {formatDateTime(comment.createdAt)}
                  </span>
                ) : null}
                {comment.edited ? (
                  <span className="text-[11px] text-muted-foreground opacity-70">edited</span>
                ) : null}
              </div>
              <Markdown content={safeRemoteMarkdown(comment.body)} className="text-[13px]" />
            </div>
          </li>
        ))}
      </ul>

      {detail.commentsTruncated ? (
        <p className="mt-3 text-[11px] text-muted-foreground opacity-70">
          Older comments are in Linear.
        </p>
      ) : null}
    </section>
  );
}

/**
 * A plain textarea, by choice.
 *
 * Markdown in, markdown out: no mention autocomplete, no paste-image, no
 * toolbar. bb owns the rich composer and this plugin refuses to ship a second
 * one — a textarea that posts is honest, while a half-rich composer that
 * silently drops an `@mention` is not.
 *
 * Posting is optimistic with a **named rollback**: on failure the text comes
 * back to the box, because losing what somebody typed is a much worse failure
 * than the one that actually happened.
 */
function CommentComposer({ issueId, identifier }: { issueId: string; identifier: string }) {
  const rpc = useLinearRpc();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const post = useCallback(async () => {
    const text = body.trim();
    if (text === "") return;
    setBusy(true);
    setBody("");
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
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void post();
          }
        }}
        placeholder={`Comment on ${identifier} — markdown, no autocomplete`}
        aria-label={`Comment on ${identifier}`}
        rows={2}
        className="resize-none text-sm"
      />
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
