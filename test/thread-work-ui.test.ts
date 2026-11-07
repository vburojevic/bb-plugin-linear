// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createTestStore, issue, NOW, state, team } from "./helpers/store.js";
import { threadIssuesFor, threadWorkBinding } from "../src/thread-issues.js";
import type { WorkAction } from "../src/store/thread-work.js";

vi.mock("../app/Detail.js", () => ({ IssueDetail: ({ issueId }: { issueId: string }) =>
  React.createElement("p", { "data-testid": "detail" }, issueId) }));

let ThreadChip: typeof import("../app/ThreadChip.js").ThreadChip;
let useThreadChipVisible: typeof import("../app/ThreadChip.js").useThreadChipVisible;
let IssuePanel: typeof import("../app/IssuePanel.js").IssuePanel;
beforeAll(async () => {
  installTestPluginRuntime();
  ({ ThreadChip, useThreadChipVisible } = await import("../app/ThreadChip.js"));
  IssuePanel = (await import("../app/IssuePanel.js")).IssuePanel;
});
afterEach(cleanup);

function fixture() {
  const store = createTestStore();
  store.putTeams([team("team_eng", "ENG")], NOW);
  store.replaceWorkflowStates("team_eng", [state("todo", "team_eng", "unstarted")]);
  store.putIssues([issue({ id: "a", identifier: "ENG-1", title: "First task", stateId: "todo" }),
    issue({ id: "b", identifier: "ENG-2", title: "Second task", stateId: "todo" })], NOW);
  const link = (id: string) => ({ threadId: "t", issueId: id, teamId: "team_eng", projectId: "p", createdAt: NOW, origin: "manual" as const });
  store.linkThread(link("a"));
  store.changeThreadWork({ threadId: "t", action: "add", issue: link("b"), now: NOW + 1 });
  const read = () => {
    const entry = threadIssuesFor({ threadIds: ["t"], store, suggestions: new Map() }).t!;
    const history = store.threadWork("t").filter((row) => row.status === "previous");
    return { ...entry, binding: entry.binding && { ...entry.binding, stateOptions: [] },
      history: history.map((row) => threadWorkBinding(store, row)), historyCount: history.length,
      revision: store.threadWorkState("t").revision, alternates: [] };
  };
  const update = vi.fn(async ({ action, issue: id, expectedRevision }: { action: WorkAction; issue: string | null; expectedRevision: number }) =>
    store.changeThreadWork({ threadId: "t", action, now: NOW + 10, expectedRevision,
      ...(id === null ? {} : { issue: link(store.issueByIdentifier(id)?.id ?? id) }) }));
  const component = () => React.createElement(React.Fragment, null,
    React.createElement(ThreadChip, { threadId: "t" }),
    React.createElement(IssuePanel, { threadId: "t", params: null }));
  const slot = renderSlot({ component }, {}, { rpc: { threadIssue: read, updateThreadWork: update } });
  return { slot, store, update };
}

describe("thread work UI", () => {
  it("updates the chip and panel on focus and completion without reopening", async () => {
    const { slot, store } = fixture();
    await slot.findByRole("button", { name: /2 active Linear issues. Current issue ENG-1/ });
    expect(slot.getByText("+1")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Make current" }));
    await waitFor(() => expect(store.threadLink("t")?.issueId).toBe("b"));
    await slot.behavior.emitRealtime("linear:data", { at: NOW });
    await slot.findByRole("button", { name: /Current issue ENG-2/ });
    const row = slot.getByRole("button", { name: "ENG-2 · Second task" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Finish here" }));
    await waitFor(() => expect(store.threadLink("t")?.issueId).toBe("a"));
    await slot.behavior.emitRealtime("linear:data", { at: NOW + 1 });
    await slot.findByRole("button", { name: /1 active Linear issues. Current issue ENG-1/ });
    expect(slot.queryByText("+1")).toBeNull();
    expect(slot.getByText("Previous work (1)")).toBeTruthy();
  });

  it("viewing another issue keeps current work unchanged; switch keeps history", async () => {
    const { slot, store, update } = fixture();
    fireEvent.click(await slot.findByRole("button", { name: "ENG-2 · Second task" }));
    expect(slot.getByTestId("detail").textContent).toBe("b");
    expect(store.threadLink("t")?.issueId).toBe("a");
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(slot.getByLabelText("Add an issue by identifier or URL"), { target: { value: "ENG-2" } });
    fireEvent.click(slot.getByRole("button", { name: "Switch to" }));
    await waitFor(() => expect(store.threadWork("t").find((row) => row.issueId === "a")?.status).toBe("previous"));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ action: "start", issue: "ENG-2", expectedRevision: 2 }));
  });

  it("shows a stale-write refusal and preserves the newer work", async () => {
    const { slot, store } = fixture();
    await slot.findByRole("button", { name: "Make current" });
    store.changeThreadWork({ threadId: "t", action: "clear", now: NOW + 20 });
    fireEvent.click(slot.getByRole("button", { name: "Make current" }));
    await slot.findByRole("status");
    expect(slot.getByRole("status").textContent).toContain("Thread work changed");
    expect(store.threadLink("t")).toBeNull();
  });

  it("hides the chip's context segment while it has nothing to say", async () => {
    const { slot, store } = fixture();
    const Probe = () => React.createElement("p", { "data-testid": "visible" }, String(useThreadChipVisible({ threadId: "t" })));
    const probe = renderSlot({ component: Probe }, {}, { rpc: { threadIssue: async () => ({
      binding: null, suggestion: null, alternates: [], historyCount: 0, active: [], activeCount: 0, history: [], revision: 0,
    }) } });
    // Loading, then nothing bound: no segment, so bb draws no empty card.
    expect(probe.getByTestId("visible").textContent).toBe("false");
    await waitFor(() => expect(probe.getByTestId("visible").textContent).toBe("false"));
    // A bound thread shows it.
    const bound = renderSlot({ component: () => React.createElement("p", { "data-testid": "bound" },
      String(useThreadChipVisible({ threadId: "t" }))) }, {}, { rpc: { threadIssue: async () => {
        const entry = (await import("../src/thread-issues.js")).threadIssuesFor({ threadIds: ["t"], store, suggestions: new Map() }).t!;
        return { ...entry, history: [], historyCount: 0, revision: 1, alternates: [] };
      } } });
    await waitFor(() => expect(bound.getByTestId("bound").textContent).toBe("true"));
    slot.unmount?.();
  });
});
