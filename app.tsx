// bb-plugin-linear — frontend entry. Registration only; views live in app/.
import "./app.css";
import { useCallback } from "react";
import { definePluginApp, useRealtime } from "@bb/plugin-sdk/app";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LinearDirective } from "./app/Directive.js";
import { HeaderChip } from "./app/HeaderChip.js";
import { IssuePanel } from "./app/IssuePanel.js";
import { LinearPanel } from "./app/Panel.js";
import { LinearPanelHeader } from "./app/PanelHeader.js";
import { useAsync, useLinearRpc } from "./app/rpc.js";
import { identifiersInText } from "./src/select/identifiers.js";

function ConnectionCard() {
  const rpc = useLinearRpc();
  const state = useAsync(
    useCallback(async () => rpc.call("status"), [rpc]),
    [],
  );
  useRealtime("linear:connection", state.reload);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Linear</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-muted-foreground">
        {state.status === "failed" ? (
          <p className="text-destructive">{state.message}</p>
        ) : state.status === "loading" ? (
          <p>Checking the connection…</p>
        ) : !state.value.configured ? (
          <p>
            No API key yet — add one in this plugin&apos;s settings, or run{" "}
            <code className="text-foreground">bb plugin config linear set apiKey &lt;key&gt;</code>.
          </p>
        ) : (
          state.value.accounts.map((account) => (
            <p key={account.slot}>
              {account.error !== null
                ? `${account.label}: ${account.error}`
                : `Connected as ${account.displayName} in ${account.orgName} (${account.orgUrlKey})`}
            </p>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  /*
   * The front door: the list-first Linear browser at sidebar width. The host
   * draws the title bar (plugin icon + title) and mounts `headerContent` as
   * the actions on the right; the component owns a full-bleed body.
   */
  app.slots.navPanel({
    id: "linear",
    title: "Linear",
    icon: "Layers",
    path: "linear",
    component: LinearPanel,
    headerContent: LinearPanelHeader,
  });

  app.slots.homepageSection({
    id: "linear-connection",
    title: "Linear",
    component: ConnectionCard,
  });

  app.slots.experimental_threadHeaderAction({
    id: "issue-chip",
    title: "Linear issue",
    component: HeaderChip,
  });

  app.slots.threadPanelAction({
    id: "issue",
    title: "Linear issue",
    component: IssuePanel,
  });

  /*
   * Open the issues a message names, in the side panel — selection first,
   * because highlighting one identifier in a message that names six is an
   * unambiguous statement about which one you meant. The parser is loose
   * ("UTF-8" matches too); the panel resolves what it is given and shows a
   * plain miss for anything that is not a real issue, so a false positive
   * costs one glance. Several identifiers open several tabs: the host
   * de-duplicates tabs by params, so the tabs are the list.
   */
  app.slots.messageAction({
    id: "open-issue",
    title: "Open in Linear",
    icon: "Layers",
    run: ({ threadId: _threadId, message, selectedText, openPanel }) => {
      const source =
        selectedText !== undefined && selectedText !== "" ? selectedText : message.text;
      const { identifiers } = identifiersInText(source);
      if (identifiers.length === 0) {
        // No identifier named is not a failure: fall back to this thread's
        // own issue, which is what "Linear" means on such a message.
        openPanel({ actionId: "issue" });
        return;
      }
      for (const identifier of identifiers) {
        openPanel({
          actionId: "issue",
          title: identifier,
          params: { issueId: identifier },
        });
      }
    },
  });

  /*
   * `::linear{key="ENG-42"}` in an assistant message renders as the issue —
   * glyph, identifier, title — and opens the side panel on click. Unknown or
   * malformed keys degrade to the original text, never to an empty box.
   */
  app.slots.messageDirective({
    id: "linear",
    component: LinearDirective,
  });

  app.slots.sidebarFooterAction({
    id: "linear-settings",
    title: "Linear settings",
    icon: "Layers",
    run: ({ openSettings }) => openSettings(),
  });
});
