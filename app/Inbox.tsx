import { useCallback, useEffect, useRef } from "react";
import { useBbNavigate, useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { formatBadgeCount } from "../src/format.js";
import { useAsync, useLinearRpc } from "./rpc.js";

/**
 * The Inbox segment.
 *
 * This is a notification's **home**. The homepage section and the composer
 * banner are echoes of it, and nothing else carries a count.
 *
 * The seen/dismiss model, stated so it cannot drift: opening the segment marks
 * visible rows seen, and a row stays until it is dismissed — so **seen is not
 * handled**. A row whose Linear notification has been read elsewhere loses its
 * dot on the next tick but does not vanish, because a row disappearing under
 * your cursor is worse than a stale dot.
 */
export function InboxSegment() {
  const rpc = useLinearRpc();
  const navigate = useBbNavigate();

  const inbox = useAsync(
    useCallback(async () => rpc.call("inbox", {}), [rpc]),
    [],
  );
  useRealtime("linear:inbox", inbox.reload);

  // Opening the segment is what marks rows seen. Deliberately a separate call
  // from the read: a refetch triggered by the poller must not mark anything
  // seen behind the user's back.
  useEffect(() => {
    void rpc.call("inbox", { markSeen: true });
  }, [rpc]);

  const dismiss = useCallback(
    async (keys: string[], all = false) => {
      await rpc.call("dismissInbox", { keys, all });
      inbox.reload();
    },
    [rpc, inbox],
  );

  if (inbox.status === "loading") {
    return <p className="p-4 text-sm text-muted-foreground">Reading your Linear inbox…</p>;
  }
  if (inbox.status === "failed") {
    return <p className="p-4 text-sm text-destructive">{inbox.message}</p>;
  }

  const { items } = inbox.value;

  if (items.length === 0) {
    /* An empty inbox is a good outcome, so it says so and then teaches what
       would put something here — which is the difference between "nothing" and
       "nothing, and here is what you are watching for". */
    // Centred within the list's own measure, not across the whole pane — an
    // empty state that drifts to the middle of a wide panel has left the
    // control that produced it behind.
    return (
      <div className="flex w-full max-w-[56rem] flex-1 flex-col items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm space-y-2 text-center">
          <p className="text-sm font-medium text-foreground">
            Nothing is waiting for you in Linear.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Assignments, replies, mentions and anything that blocks your work land here.
          </p>
        </div>
      </div>
    );
  }

  const seen = items.filter((item) => !item.unseen);

  return (
    <div className="flex h-full flex-col">
      <ul className="bbl-scroller w-full max-w-[56rem] flex-1 overflow-y-auto px-1 pb-3">
        {items.map((item) => (
          <li
            key={item.key}
            className="bbl-row group flex items-center gap-2.5 rounded-md py-1.5 pl-2 pr-1 hover:bg-state-hover"
          >
            {/* Unseen rows carry a dot. The space is reserved either way, so
                rows do not shift horizontally as they are read. */}
            <span
              className={`size-1.5 shrink-0 rounded-full ${item.unseen ? "bg-primary" : "bg-transparent"}`}
              aria-hidden
            />

            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-[13px]"
              onClick={() => {
                if (item.issueId !== null) {
                  navigate.toPluginPanel("linear", { subPath: `i/${item.identifier ?? item.issueId}` });
                }
              }}
            >
              {/* Weight rather than colour carries "unread": a muted row is
                  already how everything else says "less important", and using
                  it twice makes neither reading reliable. */}
              <span
                className={
                  item.unseen ? "font-medium text-foreground" : "text-muted-foreground"
                }
              >
                {item.text}
              </span>
              {/* Only present with a second workspace connected — a merged
                  inbox without labels is a guessing game, and labels on a
                  single workspace are noise. */}
              {item.workspace !== null ? (
                <span className="ml-1.5 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                  {item.workspace}
                </span>
              ) : null}
            </button>

            {/* The age and the dismiss button share one cell and crossfade,
                so approaching a row never moves anything in it. */}
            <span className="grid shrink-0 place-items-center">
              <span className="bbl-row-meta col-start-1 row-start-1 w-7 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                {item.age}
              </span>
              <span className="bbl-row-actions col-start-1 row-start-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={`Dismiss: ${item.text}`}
                  onClick={() => void dismiss([item.key])}
                >
                  <Icon name="CircleX" className="size-3.5" aria-hidden />
                </Button>
              </span>
            </span>
          </li>
        ))}
      </ul>

      {seen.length > 0 ? (
        <div className="border-t border-border px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void dismiss(seen.map((item) => item.key))}
          >
            Dismiss {seen.length} seen
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The count on the segment label. Capped at 99+, because the difference
 *  between 100 and 340 has never changed anybody's next action. */
export function useInboxCount(): number {
  const rpc = useLinearRpc();
  const summary = useAsync(
    useCallback(async () => rpc.call("inboxSummary", null), [rpc]),
    [],
  );
  useRealtime("linear:inbox", summary.reload);

  /*
   * Rung 3 of the delivery ladder: the toast.
   *
   * **The backend never toasts.** It publishes `linear:inbox` and this is what
   * decides whether anything is shown — which is the only place that can,
   * because only the frontend knows whether the inbox is already on screen.
   *
   * Fires on a *rise* in the unseen count, never on the first load: mounting
   * the panel with four things already waiting is not four new events, and a
   * toast on mount is the fastest way to teach someone to ignore toasts. The
   * ref rather than state, so the comparison itself never causes a render.
   */
  const previous = useRef<number | null>(null);
  const ready = summary.status === "ready" ? summary.value : null;
  const unseen = ready?.unseen ?? 0;
  const newestText = ready?.newest?.text ?? null;
  const newestIdentifier = ready?.newest?.identifier ?? null;

  useEffect(() => {
    if (ready === null) return;
    const before = previous.current;
    previous.current = unseen;
    if (before === null || unseen <= before) return;

    const added = unseen - before;
    // The newest item names itself; anything more is counted. A stack of
    // toasts for one poll is one event rendered five times.
    toast(
      added === 1 && newestText !== null
        ? newestText
        : `${String(added)} new things in your Linear inbox`,
      added === 1 && newestIdentifier !== null ? { description: newestIdentifier } : undefined,
    );
    // `ready` is intentionally excluded: it is a fresh object on every poll,
    // and the effect must run on a change in the *count*, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseen]);

  return unseen;
}

export function InboxBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground tabular-nums">
      {formatBadgeCount(count)}
    </span>
  );
}
