import { useCallback } from "react";
import { useBbNavigate, useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAsync, useLinearRpc } from "./rpc.js";
import { StateGlyph } from "./StateGlyph.js";

/**
 * The thread header's one control: which issue this thread is working on.
 *
 * The header row is 48px chrome with 28px controls and the host clamps
 * anything taller, so this is a single button in all three states:
 *
 *  - **Bound** — state-toned dot + identifier. Click opens the issue panel.
 *  - **Suggested** — the fuzzy rung's candidate, drawn as a question
 *    ("LIN-3?") in muted chrome. Click accepts, which *is* a manual binding
 *    and records itself as one.
 *  - **Nothing to say** — renders nothing. An empty affordance in every
 *    thread header would be chrome for chrome's sake.
 */
export function HeaderChip({ threadId }: { threadId: string; projectId: string | null; isCompactViewport: boolean }) {
  const rpc = useLinearRpc();
  const navigate = useBbNavigate();

  const state = useAsync(
    useCallback(async () => rpc.call("threadIssue", { threadId }), [rpc, threadId]),
    [threadId],
  );
  useRealtime("linear:data", state.reload);

  if (state.status !== "ready") return null;
  const { binding, suggestion } = state.value;

  if (binding !== null) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1.5 px-2 text-xs font-medium"
        aria-label={`Linear issue ${binding.identifier} · ${binding.title} — ${binding.stateName}, bound via ${binding.origin}`}
        onClick={() => {
          navigate.openThreadPanel({ actionId: "issue", title: binding.identifier });
        }}
      >
        {/* The same shaped glyph the panel's rows draw — one state language
            everywhere, so "half-filled ring" means started in the header
            exactly as it does in the list. */}
        <StateGlyph tone={binding.tone} />
        {binding.identifier}
      </Button>
    );
  }

  if (suggestion !== null) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 border-dashed px-2 text-xs text-muted-foreground"
        aria-label={`Looks like Linear issue ${suggestion.identifier} · ${suggestion.title} — click to bind`}
        onClick={() => {
          void rpc
            .call("bindThread", { threadId, issueId: suggestion.issueId })
            .then((result) => {
              if (result.ok) {
                toast.success(`Bound to ${suggestion.identifier}. Undo: bb linear unlink`);
              } else {
                toast.error(result.message ?? "Couldn't bind.");
              }
              state.reload();
            });
        }}
      >
        {suggestion.identifier}?
      </Button>
    );
  }

  return null;
}
