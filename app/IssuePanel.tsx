import { useCallback, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import { IssueDetail } from "./Detail.js";
import { useAsync, useLinearRpc } from "./rpc.js";
import { ThreadWorkControls } from "./ThreadWorkControls.js";

/** Viewing an issue is independent of changing the thread's current work. */
export function IssuePanel({ threadId, params }: { threadId: string; params: JsonValue | null }) {
  const rpc = useLinearRpc();
  const [selection, setSelection] = useState<{ threadId: string; issueId: string } | null>(null);
  const pinnedIssueId = params !== null && typeof params === "object" && !Array.isArray(params) &&
    typeof params["issueId"] === "string" ? params["issueId"] : null;
  const state = useAsync(useCallback(async () => rpc.call("threadIssue", { threadId }), [rpc, threadId]), [threadId]);
  useRealtime("linear:data", state.reload);
  if (state.status === "loading") return null;
  if (state.status === "failed") return <p className="text-sm text-destructive">{state.message}</p>;
  const selected = selection?.threadId === threadId ? selection.issueId : null;
  const issueId = selected ?? pinnedIssueId ?? state.value.binding?.issueId ?? null;
  return (
    <div className="space-y-4">
      <ThreadWorkControls key={threadId} threadId={threadId} work={state.value} reload={state.reload}
        onSelect={(id) => setSelection({ threadId, issueId: id })} />
      {issueId !== null && <IssueDetail key={issueId} issueId={issueId} />}
    </div>
  );
}
