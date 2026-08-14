import { useCallback } from "react";
import type { PluginMessageDirectiveProps } from "@bb/plugin-sdk/app";
import { useBbNavigate } from "@bb/plugin-sdk/app";
import { StateGlyph } from "./StateGlyph.js";
import { useAsync, useLinearRpc } from "./rpc.js";

/**
 * `::linear{key="ENG-42"}` — an issue named in chat, rendered as the issue.
 *
 * Attributes are attacker-controlled even though the model emitted them, so
 * `key` is validated to an identifier shape before it goes anywhere near an
 * rpc, and every failure renders the original source text — an unknown key
 * must degrade to exactly what was written, never to an empty box.
 */
export function LinearDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const raw = attributes["key"] ?? "";
  const key = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(raw) ? raw.toUpperCase() : null;

  if (key === null) return <span>{source}</span>;
  return <DirectiveCard identifier={key} source={source} />;
}

function DirectiveCard({ identifier, source }: { identifier: string; source: string }) {
  const rpc = useLinearRpc();
  const navigate = useBbNavigate();
  const state = useAsync(
    useCallback(async () => rpc.call("issue", { id: identifier }), [rpc, identifier]),
    [identifier],
  );

  if (state.status === "loading") {
    return <span className="text-muted-foreground">{identifier}…</span>;
  }
  if (state.status === "failed" || state.value.result.kind !== "issue") {
    return <span>{source}</span>;
  }

  const detail = state.value.result.detail;
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-0.5 align-middle text-[13px] hover:bg-accent"
      onClick={() => {
        navigate.openThreadPanel({
          actionId: "issue",
          title: detail.identifier,
          params: { issueId: detail.identifier },
        });
      }}
      title={`${detail.identifier} — ${detail.title}`}
    >
      <StateGlyph tone={detail.tone} />
      <span className="font-medium text-foreground">{detail.identifier}</span>
      <span className={`truncate text-muted-foreground${detail.struckThrough ? " line-through" : ""}`}>
        {detail.title}
      </span>
    </button>
  );
}
