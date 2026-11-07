import { describe, expect, it } from "vitest";
import {
  normalizeAgentToolRegistration,
  parsePluginRowPresentation,
} from "@get-bb/plugin-sdk/internal/host-policy";
import { registerTools } from "../src/tools.js";

/**
 * BB rejected v0.1.2 because SDK 0.4.16 refuses `experimental_statusLabels` at
 * registration, so the plugin errored out before its surface was registered.
 * These run every tool this plugin declares through the SDK's own host policy —
 * the same code that runs at startup — so the failure is caught here, not by a
 * reviewer installing the plugin.
 */

/** The SDK's own registration path: stale fields, presentation, parameters. */
function register(tool: any) {
  return normalizeAgentToolRegistration({ pluginId: "linear", declaredIconNames: new Set(), tool } as never);
}
function registeredTools(): any[] {
  const tools: any[] = [];
  const bb: any = {
    agents: {
      registerTool: (tool: any) => tools.push(tool),
      configure: () => {},
    },
  };
  const deps = new Proxy({}, { get: () => deps }) as any;
  registerTools(bb, deps);
  return tools;
}

describe("agent tools satisfy the SDK host policy", () => {
  const tools = registeredTools();

  it("declares tools to check", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it("passes the SDK's registration policy, with no renamed or unknown experimental_ fields", () => {
    for (const tool of tools) {
      expect(() => register(tool), `tool "${tool.name}"`).not.toThrow();
    }
  });

  it("every declared presentation survives the SDK parser with its label intact", () => {
    const labelled = tools.filter((tool) => tool.presentation !== undefined);
    expect(labelled.length).toBeGreaterThan(0);

    for (const tool of labelled) {
      const parsed = register(tool).presentation as any;
      // The parser drops keys it does not know, so a misspelled field would
      // leave the tool activating with no label at all rather than failing.
      expect(parsed?.label, `tool "${tool.name}" kept its label`).toBeDefined();
      expect(parsed.label.pending.length).toBeGreaterThan(0);
      expect(parsed.label.completed.length).toBeGreaterThan(0);
    }
  });

  it("labels stay within the SDK's 80 character budget", () => {
    for (const tool of tools) {
      const label = tool.presentation?.label;
      if (label === undefined) continue;
      expect(label.pending.length, `tool "${tool.name}" pending`).toBeLessThanOrEqual(80);
      expect(label.completed.length, `tool "${tool.name}" completed`).toBeLessThanOrEqual(80);
    }
  });
});

describe("the shapes that silently lose labels", () => {
  it("rejects the pre-0.4.16 experimental_statusLabels field", () => {
    expect(() =>
      register({
        name: "linear_team_context",
        description: "Read the team.",
        parameters: { type: "object", properties: {} },
        execute: async () => "",
        experimental_statusLabels: { pending: "Reading", completed: "Read" },
      }),
    ).toThrow(/experimental_statusLabels/);
  });

  it("drops presentation.labels — the plural spelling keeps no label", () => {
    const parsed = parsePluginRowPresentation("tool \"linear_team_context\"", {
      labels: { pending: "Reading", completed: "Read" },
    } as never);
    expect(parsed?.label).toBeUndefined();
  });

  it("keeps presentation.label — the spelling this plugin ships", () => {
    const parsed = parsePluginRowPresentation("tool \"linear_team_context\"", {
      label: { pending: "Reading", completed: "Read" },
    });
    expect(parsed?.label).toEqual({ pending: "Reading", completed: "Read" });
  });
});
