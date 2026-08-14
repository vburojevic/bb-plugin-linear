// bb-plugin-linear — frontend entry. Registration only; views live in app/.
import "./app.css";
import { useCallback } from "react";
import { definePluginApp } from "@bb/plugin-sdk/app";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { HeaderChip } from "./app/HeaderChip.js";
import { IssuePanel } from "./app/IssuePanel.js";
import { useAsync, useLinearRpc } from "./app/rpc.js";

function ConnectionCard() {
  const rpc = useLinearRpc();
  const state = useAsync(
    useCallback(async () => rpc.call("status"), [rpc]),
    [],
  );

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
});
