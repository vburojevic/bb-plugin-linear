import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { createStore } from "../src/store/store.js";
import { issue, NOW, state, team } from "./helpers/store.js";

/*
 * `bb linear set` run from outside any bb project, with several bound. Its
 * `--project` is the Linear project to move the issue into, so the refusal
 * must name the flag that actually picks the bb project.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function twoBoundProjects() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "linear",
    sdk: { projects: { list: async () => ({ projects: [] }) as never } },
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb as never);
  const store = createStore(bb.storage.database() as never);
  store.putTeams([team("team_eng", "ENG")], NOW);
  store.replaceWorkflowStates("team_eng", [state("todo", "team_eng", "unstarted")]);
  store.putIssues([issue({ id: "a", identifier: "ENG-1", stateId: "todo" })], NOW);
  for (const project of ["p_one", "p_two"]) {
    expect((await harness.behavior.runCli(["bind", "ENG", "--project", project])).exitCode).toBe(0);
  }
  return harness;
}

describe("bb linear set with several bound projects", () => {
  it("names --bb-project, the flag that picks the bb project", async () => {
    const harness = await twoBoundProjects();
    const result = await harness.behavior.runCli(["set", "ENG-1", "--priority", "1"], {});
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("name one with --bb-project <id>");
  });

  it("resolves the issue once --bb-project names one", async () => {
    const harness = await twoBoundProjects();
    const result = await harness.behavior.runCli(
      ["set", "ENG-1", "--priority", "1", "--bb-project", "p_one"],
      {},
    );
    // Past project resolution: what stops it now is the write gate (writes
    // are off in a fresh install), not the ambiguity.
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).not.toContain("More than one project is bound");
    expect(output).toContain("ENG-1");
  });
});
