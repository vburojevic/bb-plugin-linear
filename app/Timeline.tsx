import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CommentView, DetailView, TimelineEntry } from "../src/contract.js";
import { safeRemoteMarkdown } from "../src/security-boundaries.js";
import { firstUnreadTimelineEntry } from "../src/select/timeline-unread.js";
import { safeHref } from "./href.js";
import { useLinearRpc } from "./rpc.js";
import {
  displayReactionEmoji,
  PANE_REACTION_EMOJIS,
  reactionNameForPickerEmoji,
} from "../src/pane-frontend.js";

export function Timeline({
  detail,
  onReload,
  targetCommentId,
}: {
  detail: DetailView;
  onReload: () => void;
  targetCommentId?: string | null;
}) {
  const rpc = useLinearRpc();
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const timelineRef = useRef<HTMLElement>(null);
  const comments = useMemo(
    () => new Map(detail.comments.map((comment) => [comment.id, comment])),
    [detail.comments],
  );
  const entries = detail.activity.showActivity
    ? detail.timeline
    : detail.timeline.filter((entry) => entry.kind === "comment");
  const firstUnread = firstUnreadTimelineEntry(entries, comments, detail.unreadBoundaryAt);
  const targetAvailable =
    targetCommentId !== null &&
    targetCommentId !== undefined &&
    detail.comments.some(
      (comment) =>
        comment.id === targetCommentId ||
        comment.replies.some((reply) => reply.id === targetCommentId),
    );

  useEffect(() => {
    if (!targetAvailable || targetCommentId === null || targetCommentId === undefined) return;
    // Resolved threads expand in a child effect. Waiting one turn makes the
    // targeted reply exist before looking for it, without assuming that this
    // is the only issue pane mounted in bb.
    let highlightTimer: number | undefined;
    let targetElement: HTMLElement | undefined;
    const scrollTimer = window.setTimeout(() => {
      const wanted = `c-${targetCommentId}`;
      const target = Array.from(
        timelineRef.current?.querySelectorAll<HTMLElement>("[id]") ?? [],
      )
        .find((element) => element.id === wanted);
      if (target === undefined) return;
      targetElement = target;
      target.scrollIntoView({ block: "center" });
      target.classList.add("bbl-comment-highlight");
      highlightTimer = window.setTimeout(
        () => target.classList.remove("bbl-comment-highlight"),
        2_000,
      );
    }, 0);
    return () => {
      window.clearTimeout(scrollTimer);
      if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
      targetElement?.classList.remove("bbl-comment-highlight");
    };
  }, [targetCommentId, targetAvailable]);

  const setVisibility = async () => {
    setVisibilityBusy(true);
    try {
      const result = await rpc.call("setActivityVisibility", {
        showActivity: !detail.activity.showActivity,
      });
      if (!result.ok) {
        toast.error("Activity visibility wasn't changed.");
        return;
      }
      onReload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Activity visibility wasn't changed.");
    } finally {
      setVisibilityBusy(false);
    }
  };

  const loadOlder = async () => {
    setOlderBusy(true);
    try {
      const result = await rpc.call("olderActivity", { issueId: detail.id });
      if (!result.ok) {
        toast.error("Older activity couldn't be loaded.");
      }
      onReload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Older activity couldn't be loaded.");
    } finally {
      setOlderBusy(false);
    }
  };

  return (
    <section ref={timelineRef} className="border-t border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground opacity-80">
          Activity
        </h3>
        <button
          type="button"
          role="switch"
          aria-checked={detail.activity.showActivity}
          disabled={visibilityBusy}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
          onClick={() => void setVisibility()}
        >
          <Icon
            name={detail.activity.showActivity ? "Eye" : "EyeOff"}
            className="size-3.5"
            aria-hidden
          />
          Show activity
        </button>
      </div>

      {detail.activity.hasOlder ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 px-2 text-xs text-muted-foreground"
          disabled={olderBusy}
          onClick={() => void loadOlder()}
        >
          {olderBusy ? <Icon name="Spinner" className="size-3.5" aria-hidden /> : null}
          Show older activity
        </Button>
      ) : null}

      <ol className="mt-3 space-y-3.5">
        {entries.map((entry) => {
          const key = entry.kind === "event" ? entry.id : entry.commentId;
          const comment = entry.kind === "comment" ? comments.get(entry.commentId) : undefined;
          if (entry.kind === "comment" && comment === undefined) return null;
          return (
            <TimelineRow
              key={key}
              entry={entry}
              comment={comment}
              unread={key === firstUnread}
              targetCommentId={targetCommentId ?? null}
              issueId={detail.id}
              writable={detail.writable}
              onReload={onReload}
            />
          );
        })}
      </ol>
    </section>
  );
}

function TimelineRow({
  entry,
  comment,
  unread,
  targetCommentId,
  issueId,
  writable,
  onReload,
}: {
  entry: TimelineEntry;
  comment: CommentView | undefined;
  unread: boolean;
  targetCommentId: string | null;
  issueId: string;
  writable: boolean;
  onReload: () => void;
}) {
  return (
    <li
      id={comment === undefined ? undefined : `c-${comment.id}`}
      className={comment === undefined ? undefined : "scroll-m-8 rounded-md p-1"}
    >
      {unread ? (
        <div className="mb-3 flex items-center gap-2" role="separator" aria-label="New activity">
          <span className="h-px flex-1 bg-primary opacity-50" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">New</span>
          <span className="h-px flex-1 bg-primary opacity-50" />
        </div>
      ) : null}
      {entry.kind === "event" ? (
        <EventRow entry={entry} />
      ) : comment !== undefined ? (
        <CommentThread
          comment={comment}
          targetCommentId={targetCommentId}
          issueId={issueId}
          writable={writable}
          onReload={onReload}
        />
      ) : null}
    </li>
  );
}

function EventRow({ entry }: { entry: Extract<TimelineEntry, { kind: "event" }> }) {
  const name = entry.actor?.name ?? entry.bot ?? "Linear";
  const initials = entry.actor?.initials ?? "◇";
  return (
    <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
      <Avatar
        initials={initials}
        name={name}
        bot={entry.actor === null}
      />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-foreground">{name}</span> {entry.text}
        {entry.detail === undefined ? null : (
          <span className="ml-1 opacity-70">{entry.detail}</span>
        )}
      </p>
      <time className="shrink-0 text-[10px] opacity-70" title={entry.atAbsolute}>
        {entry.atRelative}
      </time>
    </div>
  );
}

function CommentThread({
  comment,
  targetCommentId,
  issueId,
  writable,
  onReload,
}: {
  comment: CommentView;
  targetCommentId: string | null;
  issueId: string;
  writable: boolean;
  onReload: () => void;
}) {
  const targeted =
    targetCommentId === comment.id || comment.replies.some((reply) => reply.id === targetCommentId);
  const [expanded, setExpanded] = useState(!comment.resolved || targeted);
  useEffect(() => {
    if (targeted) setExpanded(true);
  }, [targeted]);
  const resolvedLabel =
    comment.resolvedBy === null ? "Resolved" : `Resolved by ${comment.resolvedBy}`;

  return (
    <>
      {comment.resolved ? (
        <button
          type="button"
          className="mb-2 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3" aria-hidden />
          {resolvedLabel}
        </button>
      ) : null}
      {expanded ? (
        <>
          <Comment
            comment={comment}
            issueId={issueId}
            writable={writable}
            onReload={onReload}
          />
          {comment.replies.length > 0 ? (
            <ol className="bbl-rail ml-3 mt-3 space-y-3 pl-3">
              {comment.replies.map((reply) => (
                <li
                  id={`c-${reply.id}`}
                  key={reply.id}
                  className="scroll-m-8 rounded-md p-1"
                >
                  <Comment
                    comment={reply}
                    issueId={issueId}
                    writable={writable}
                    onReload={onReload}
                  />
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function Comment({
  comment,
  issueId,
  writable,
  onReload,
}: {
  comment: Omit<CommentView, "replies">;
  issueId: string;
  writable: boolean;
  onReload: () => void;
}) {
  const rpc = useLinearRpc();
  const href = safeHref(comment.url);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState(comment.bodySource);

  useEffect(() => {
    if (!editing) setBody(comment.bodySource);
  }, [comment.bodySource, editing]);

  const save = useCallback(() => {
    const next = body.trim();
    if (next === "" || busy) return;
    setBusy(true);
    void (async () => {
      try {
        const result = await rpc.call("editComment", { id: comment.id, body: next });
        if (!result.ok) {
          toast.error(result.message ?? "That comment wasn't changed.");
          return;
        }
        setEditing(false);
        onReload();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That comment wasn't changed.");
      } finally {
        setBusy(false);
      }
    })();
  }, [rpc, comment.id, body, busy, onReload]);

  const remove = useCallback(() => {
    setDeleting(false);
    setBusy(true);
    void (async () => {
      try {
        const result = await rpc.call("deleteComment", { id: comment.id });
        if (!result.ok) {
          toast.error(result.message ?? "That comment wasn't deleted.");
          return;
        }
        toast.success("Comment deleted.");
        onReload();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That comment wasn't deleted.");
      } finally {
        setBusy(false);
      }
    })();
  }, [rpc, comment.id, onReload]);

  return (
    <>
      <div className="flex gap-2.5">
        <Avatar
          initials={comment.authorInitials}
          name={comment.author}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{comment.author}</span>
            {comment.createdAtRelative !== null ? (
              <time
                className="shrink-0 text-[10px] text-muted-foreground opacity-70"
                title={comment.createdAtAbsolute ?? undefined}
              >
                {comment.createdAtRelative}
              </time>
            ) : null}
            {comment.edited ? (
              <span className="text-[10px] text-muted-foreground opacity-70">edited</span>
            ) : null}
            <CommentMenu
              comment={comment}
              href={href}
              writable={writable}
              onEdit={() => setEditing(true)}
              onDelete={() => setDeleting(true)}
            />
          </div>

          {editing ? (
            <div className="space-y-2">
              <Textarea
                autoFocus
                value={body}
                disabled={busy}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    save();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setBody(comment.bodySource);
                    setEditing(false);
                  }
                }}
                className="min-h-20 text-[13px]"
                aria-label="Edit comment"
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setBody(comment.bodySource);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" disabled={busy || body.trim() === ""} onClick={save}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <Markdown content={safeRemoteMarkdown(comment.body)} className="text-[13px]" />
          )}
          <ReactionChips
            reactions={comment.reactions}
            issueId={issueId}
            commentId={comment.id}
            writable={writable}
            onReload={onReload}
          />
        </div>
      </div>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the comment in Linear for everyone. Replies remain and move to the
              top level of the activity timeline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={remove}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CommentMenu({
  comment,
  href,
  writable,
  onEdit,
  onDelete,
}: {
  comment: Omit<CommentView, "replies">;
  href: string | undefined;
  writable: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 shrink-0 text-muted-foreground"
          aria-label={`More actions for ${comment.author}'s comment`}
        >
          <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {writable && comment.mine ? (
          <>
            <DropdownMenuItem onSelect={onEdit}>
              <Icon name="Edit" className="size-3.5" aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={onDelete}
            >
              <Icon name="Trash2" className="size-3.5" aria-hidden />
              Delete
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          disabled={comment.url === null}
          onSelect={() => {
            if (comment.url !== null) void navigator.clipboard?.writeText(comment.url);
          }}
        >
          <Icon name="Copy" className="size-3.5" aria-hidden />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {href === undefined ? (
          <DropdownMenuItem disabled>Open in Linear</DropdownMenuItem>
        ) : (
          <DropdownMenuItem asChild>
            <a href={href} target="_blank" rel="noreferrer">
              <Icon name="ExternalLink" className="size-3.5" aria-hidden />
              Open in Linear
            </a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({
  initials,
  name,
  bot = false,
}: {
  initials: string;
  name: string;
  bot?: boolean;
}) {
  return (
    <span
      className="mt-0.5 grid size-6 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[9px] font-medium text-muted-foreground"
      title={name}
      aria-hidden
    >
      {bot ? (
        <Icon name="Zap" className="size-3" aria-hidden />
      ) : (
        initials
      )}
    </span>
  );
}

export function ReactionChips({
  reactions,
  issueId,
  commentId,
  writable,
  onReload,
}: {
  reactions: DetailView["reactions"];
  issueId: string;
  commentId?: string;
  writable: boolean;
  onReload: () => void;
}) {
  const rpc = useLinearRpc();
  const [busyEmoji, setBusyEmoji] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const toggle = useCallback(
    (emoji: string) => {
      if (busyEmoji !== null) return;
      setBusyEmoji(emoji);
      void (async () => {
        try {
          const result = await rpc.call("react", {
            issueId,
            ...(commentId === undefined ? {} : { commentId }),
            emoji,
          });
          if (!result.ok) {
            toast.error(result.message ?? "That reaction wasn't changed.");
            return;
          }
          setPickerOpen(false);
          onReload();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "That reaction wasn't changed.");
        } finally {
          setBusyEmoji(null);
        }
      })();
    },
    [rpc, issueId, commentId, busyEmoji, onReload],
  );

  if (reactions.length === 0 && !writable) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1" aria-label="Reactions">
      {reactions.map((reaction) => {
        const className = `inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] ${
          reaction.mine
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground"
        }`;
        const content = (
          <>
            <span aria-hidden>{displayReactionEmoji(reaction.emoji)}</span>
            <span className="tabular-nums">{reaction.count}</span>
          </>
        );
        const title = `${String(reaction.count)} reaction${reaction.count === 1 ? "" : "s"}`;
        return writable ? (
          <button
            type="button"
            key={reaction.emoji}
            className={className}
            title={title}
            disabled={busyEmoji !== null}
            onClick={() => toggle(reaction.emoji)}
          >
            {content}
          </button>
        ) : (
          <span key={reaction.emoji} className={className} title={title}>
            {content}
          </span>
        );
      })}
      {writable ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex min-h-6 items-center rounded-full border border-dashed border-border px-2 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground"
              aria-label="Add reaction"
            >
              +
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-auto p-2"
            mobileTitle="Add reaction"
          >
            <div className="grid grid-cols-4 gap-1">
              {PANE_REACTION_EMOJIS.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  className="grid size-9 place-items-center rounded-md text-lg hover:bg-state-hover"
                  disabled={busyEmoji !== null}
                  aria-label={`React with ${emoji}`}
                  onClick={() => toggle(reactionNameForPickerEmoji(emoji))}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
