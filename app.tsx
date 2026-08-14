// bb-plugin-linear — a BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @bb/plugin-sdk/app are provided by the BB app at load time (never bundled),
// so this file must be loaded by BB, not imported directly.
//
// The components under components/ui/ are YOURS: vendored source (shadcn
// model), edit freely. Add more from the BB registry with
// `npx shadcn add @bb/<name>` (see components.json) — dialogs, dropdowns,
// tables, the full shadcn set, version-matched to this BB install. Run
// `npm install` once before `bb plugin build`.
import { useState } from "react";
import { definePluginApp, useBbContext, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function HelloCard() {
  const { projectId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const [greeting, setGreeting] = useState("Say hello");
  // Tailwind classes compile against the host theme's live CSS variables —
  // derive colors from the theme tokens, never hardcoded grays.
  return (
    <Card>
      <CardHeader>
        <CardTitle>bb-plugin-linear</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          {projectId === null
            ? "No project selected."
            : `Project: ${projectId}.`}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void rpc.call("greeting").then((result) => {
              setGreeting(`${result.greeting} (#${result.loadCount})`);
            });
          }}
        >
          {greeting}
        </Button>
      </CardContent>
    </Card>
  );
}

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. Register general UI under app.slots and composer actions,
// plus-menu rows, banners, or rich-text rules with app.composer.customize(...)
// (see the bb guide's plugins chapter).
export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "linear-hello",
    title: "bb-plugin-linear",
    component: HelloCard,
  });
});
