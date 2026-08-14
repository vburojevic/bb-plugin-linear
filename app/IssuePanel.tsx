import { useCallback } from "react";
import { useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { JsonValue } from "@bb/plugin-sdk/app";
import { IssueDetail } from "./Detail.js";
import { useAsync, useLinearRpc } from "./rpc.js";

/**
 * The thread side panel's issue tab.
 *
 * Three states, mirroring the chip exactly — the two surfaces must never
 * disagree about what the thread is working on, so both read the same rpc:
 * bound renders the full detail pane; suggested renders the candidate with
 * an accept button; unbound says how to link, in one sentence.
 *
 * `params` may carry `{ issueId }` when another surface opened this tab for
 * a specific issue (untrusted — it round-trips through persistence, so it is
 * only ever used as an id to fetch fresh).
 */
export function IssuePanel({ threadId, params }: { threadId: string; params: JsonValue | null }) {
  const rpc = useLinearRpc();

  const pinnedIssueId =
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params["issueId"] === "string"
      ? params["issueId"]
      : null;

  const state = useAsync(
    useCallback(async () => rpc.call("threadIssue", { threadId }), [rpc, threadId]),
    [threadId],
  );
  useRealtime("linear:data", state.reload);

  if (pinnedIssueId !== null) {
    return <IssueDetail issueId={pinnedIssueId} />;
  }

  if (state.status === "loading") return null;
  if (state.status === "failed") {
    return <p className="text-sm text-destructive">{state.message}</p>;
  }

  const { binding, suggestion } = state.value;

  if (binding !== null) {
    return <IssueDetail issueId={binding.issueId} />;
  }

  if (suggestion !== null) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This thread isn&apos;t linked to a Linear issue, but it looks like:
        </p>
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-sm font-medium text-foreground">
            {suggestion.identifier} — {suggestion.title}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            void rpc
              .call("bindThread", { threadId, issueId: suggestion.issueId })
              .then((result) => {
                if (!result.ok) toast.error(result.message ?? "Couldn't bind.");
                state.reload();
              });
          }}
        >
          Bind to {suggestion.identifier}
        </Button>
      </div>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      This thread isn&apos;t linked to a Linear issue. Link one with{" "}
      <code className="text-foreground">bb linear link &lt;KEY-n&gt;</code>, or check out the
      issue&apos;s branch and it links itself.
    </p>
  );
}
