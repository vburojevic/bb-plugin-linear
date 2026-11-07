import { useCallback, type CSSProperties } from "react";
import {
  experimental_useAppPanel,
  useRealtime,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { useAsync, useLinearRpc } from "./rpc.js";
import { ISSUE_TAB } from "./tabs.js";
import { StateGlyph } from "./StateGlyph.js";
import { toneClass } from "../src/select/tone.js";

/**
 * The thread's chip: which issue this thread is working on.
 *
 * It sits in the context row above the composer, beside bb's parent thread,
 * changed files and pull request. The row's segments are 24px tall, so this
 * is a single button in all three states:
 *
 *  - **Bound** — state-toned dot + identifier. Click opens the issue panel.
 *  - **Suggested** — the fuzzy rung's candidate, drawn as a question
 *    ("LIN-3?") in muted chrome. Click opens the panel, where accepting it
 *    *is* a manual binding and records itself as one.
 *  - **Nothing to say** — renders nothing. An empty affordance in every
 *    thread would be chrome for chrome's sake.
 */
export function ThreadChip({ threadId }: Pick<ExperimentalThreadContextSegmentProps, "threadId">) {
  const rpc = useLinearRpc();
  const panel = experimental_useAppPanel();

  const state = useAsync(
    useCallback(async () => rpc.call("threadIssue", { threadId }), [rpc, threadId]),
    [threadId],
  );
  useRealtime("linear:data", state.reload);

  if (state.status !== "ready") return null;
  const { binding, suggestion, activeCount, historyCount, alternates } = state.value;

  if (binding !== null) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className={`${toneClass(binding.tone)} h-6 gap-1.5 rounded px-2 text-xs font-medium`}
        style={binding.glyph.color === null ? undefined : ({ "--bbl": binding.glyph.color } as CSSProperties)}
        aria-label={`${activeCount} active Linear issues. Current issue ${binding.identifier} · ${binding.title} — ${binding.stateName}, bound via ${binding.origin}${binding.provenance === null ? "" : ` — ${binding.provenance}`}`}
        onClick={() => {
          panel.openTab({ tab: ISSUE_TAB, title: binding.identifier });
        }}
      >
        {/* The same shaped glyph the panel's rows draw — one state language
            everywhere, so "half-filled ring" means started on the chip
            exactly as it does in the list. */}
        <StateGlyph tone={binding.tone} glyph={binding.glyph} />
        <span className="bbl-text">{binding.identifier}</span>
        {activeCount > 1 && <span className="text-muted-foreground">+{activeCount - 1}</span>}
      </Button>
    );
  }

  if (suggestion !== null || alternates.length > 0 || historyCount > 0) {
    return (
      <Button size="sm" variant="ghost" className="h-6 gap-1.5 rounded px-2 text-xs text-muted-foreground"
        aria-label={historyCount > 0 ? `Linear: no current issue, ${historyCount} previous issues` : "Review suggested Linear issues"}
        onClick={() => panel.openTab({ tab: ISSUE_TAB, title: "Linear work" })}>
        {historyCount > 0 ? `Linear · ${historyCount} previous` : `${suggestion?.identifier ?? alternates[0]?.identifier}?`}
      </Button>
    );
  }
  return null;
}
