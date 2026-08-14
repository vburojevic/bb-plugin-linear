// bb-plugin-linear — frontend entry. Registration only; views grow under
// app/ as the milestones land (nav panel M4, header chip and issue panel M3).
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Status = Awaited<
  ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>
>;

function ConnectionCard() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("status")
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
    // The rpc handle is stable for the mounted surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Linear</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-muted-foreground">
        {error !== null ? (
          <p className="text-destructive">{error}</p>
        ) : status === null ? (
          <p>Checking the connection…</p>
        ) : !status.configured ? (
          <p>
            No API key yet — add one in this plugin&apos;s settings, or run{" "}
            <code className="text-foreground">bb plugin config linear set apiKey &lt;key&gt;</code>.
          </p>
        ) : (
          status.accounts.map((account) => (
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
});
