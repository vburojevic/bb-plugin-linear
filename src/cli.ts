import type { PluginCliCommandInfo, PluginCliContext, PluginCliResult } from "@bb/plugin-sdk";
import { flagBoolean, parseArgs, type ParsedArgs } from "./cli-args.js";
import { fail, json, ok, table } from "./cli-format.js";
import { describeError } from "./linear/errors.js";
import { renderDoctor, renderStatus, type DoctorCheck, type StatusReport } from "./select/status.js";
import type { BudgetSnapshot } from "./linear/budget.js";
import { formatClock, pluralize } from "./format.js";
import type { SyncProfile } from "./settings.js";
import type { BindingRole, TeamRow } from "./store/rows.js";
import { flagString } from "./cli-args.js";

/**
 * `bb linear`.
 *
 * Every subcommand carries a real `summary` and `usage`, because agents
 * discover plugin commands through bb's generated `plugin-commands` skill and
 * those two strings are the entire description they get. A command documented
 * as "Linear stuff" is a command a model will use wrongly and then explain
 * confidently.
 *
 * The runner is a pure dispatch over an injected environment, so every command
 * is testable without a bb server: the tests drive `createCliRunner` with
 * hand-built reports and assert on the text.
 *
 * **The multi-machine rule applies here.** `run` executes on the *server*, so
 * a path or "current branch" argument names something on the *invoking*
 * machine. Anything host-local resolves through
 * `ctx.threadId → threads.get → environmentId → environments.get().hostId` and
 * then goes through `bb.sdk.files` / `bb.sdk.environments` with that explicit
 * host. `node:fs` is used only for this plugin's own data directory.
 */

export interface CliEnvironment {
  status(): Promise<StatusReport>;
  doctor(): Promise<readonly DoctorCheck[]>;
  budget(): Promise<{ snapshot: BudgetSnapshot | null; profile: SyncProfile }>;
  teams(): Promise<{
    /** `workspaceName` is null unless more than one workspace is connected —
     *  naming the only one on every row is noise, and `table` drops a column
     *  whose every cell is empty. */
    teams: readonly (TeamRow & { workspaceName: string | null })[];
    bound: ReadonlySet<string>;
  }>;
  bind(args: {
    teamKey: string;
    projectId: string | undefined;
    role: BindingRole;
  }): Promise<{ ok: boolean; message: string }>;
  unbind(args: {
    teamKey: string;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  sync(full: boolean): Promise<number>;
  /** Reads are scoped to every bound team, because the mirror only ever holds
   *  bound teams' issues. Writes take a project so the binding's write set can
   *  be checked. */
  issue(args: {
    identifier: string;
    comments: boolean;
  }): Promise<{ ok: boolean; text: string }>;
  move(args: {
    identifier: string;
    state: string;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  assign(args: {
    identifier: string;
    who: string;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  comment(args: {
    identifier: string;
    body: string;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  create(args: {
    title: string;
    description: string | undefined;
    team: string | undefined;
    assignee: string | undefined;
    priority: number | undefined;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  issues(args: {
    state: string | undefined;
    assignee: string | undefined;
    team: string | undefined;
    limit: number;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; rows: string[][]; message: string | null }>;
  attach(args: {
    identifier: string;
    url: string;
    title: string | undefined;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  archive(args: {
    identifier: string;
    confirmed: boolean;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  set(args: {
    identifier: string;
    priority: string | undefined;
    estimate: string | undefined;
    due: string | undefined;
    project: string | undefined;
    cycle: string | undefined;
    title: string | undefined;
    addLabel: string | undefined;
    removeLabel: string | undefined;
    projectId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  webhook(args: {
    action: string | undefined;
    target: string | undefined;
  }): Promise<{ ok: boolean; text: string }>;
  refresh(): Promise<{ ok: boolean; text: string }>;
  forget(args: { confirmed: boolean }): Promise<{ ok: boolean; text: string }>;
  inbox(args: { all: boolean; dismiss: string | null }): Promise<{ ok: boolean; text: string }>;
  start(args: {
    identifier: string;
    projectId: string | undefined;
    move: boolean;
  }): Promise<{ ok: boolean; message: string }>;
  link(args: {
    identifier: string | null;
    threadId: string | undefined;
  }): Promise<{ ok: boolean; message: string }>;
  now(): number;
}

export const CLI_COMMANDS: readonly PluginCliCommandInfo[] = [
  {
    name: "status",
    summary: "Which workspace this bb is connected to, and what it has cached",
    usage: "bb linear status [--json]",
  },
  {
    name: "doctor",
    summary: "Check every precondition and name the ones that are not met",
    usage: "bb linear doctor [--json]",
  },
  {
    name: "budget",
    summary: "How much of Linear's hourly request budget is left",
    usage: "bb linear budget [--json]",
  },
  {
    name: "teams",
    summary: "Every Linear team this API key can see, and which are bound",
    usage: "bb linear teams [--json]",
  },
  {
    name: "bind",
    summary: "Bind a bb project to a Linear team",
    usage: "bb linear bind <TEAM-KEY> [--project <id>] [--role primary|write|read]",
  },
  {
    name: "unbind",
    summary: "Remove a bb project's binding to a Linear team",
    usage: "bb linear unbind <TEAM-KEY> [--project <id>]",
  },
  {
    name: "refresh",
    summary: "Re-read the workspace: which teams exist, and each team's own states, labels and people",
    usage: "bb linear refresh",
  },
  {
    name: "sync",
    summary: "Read the bound teams' open issues into the local copy now",
    usage: "bb linear sync [--full]",
  },
  {
    name: "issue",
    summary: "Read one issue in full",
    usage: "bb linear issue <ENG-123> [--comments]",
  },
  {
    name: "create",
    summary: "Create an issue in the bound team",
    usage:
      "bb linear create <title…> [--description <text>] [--team <KEY>] [--assignee me] [--priority 0-4]",
  },
  {
    name: "issues",
    summary: "List the bound teams' issues, filtered",
    usage:
      "bb linear issues [--state <type|name>] [--assignee me|none|@name] [--team <KEY>] [--limit <n>] [--json]",
  },
  {
    name: "attach",
    summary: "Attach a link to an issue",
    usage: "bb linear attach <ENG-123> <url> [--title <text>]",
  },
  {
    name: "archive",
    summary: "Archive an issue — reversible in Linear, and never a delete",
    usage: "bb linear archive <ENG-123> --yes",
  },
  {
    name: "move",
    summary: "Move an issue to one of its team's states",
    usage: "bb linear move <ENG-123> <state-name|state-type>",
  },
  {
    name: "assign",
    summary: "Assign an issue to yourself, to someone else, or to nobody",
    usage: "bb linear assign <ENG-123> <me|@name|none>",
  },
  {
    name: "set",
    summary: "Change an issue's priority, estimate, due date, project, cycle, title or labels",
    usage:
      "bb linear set <ENG-123> [--priority 0-4] [--estimate <n>] [--due YYYY-MM-DD|none] [--project <name|none>] [--cycle <name|none>] [--title <text>] [--label +name|-name]",
  },
  {
    name: "comment",
    summary: "Comment on an issue",
    usage: "bb linear comment <ENG-123> <text…>",
  },
  {
    name: "forget",
    summary: "Delete the local copy of your Linear workspace from this machine",
    usage: "bb linear forget --yes",
  },
  {
    name: "webhook",
    summary: "Whether webhooks are delivering, and how to turn them off",
    usage: "bb linear webhook status | enable <url> | disable",
  },
  {
    name: "inbox",
    summary: "What Linear wants you for, and dismiss what you have handled",
    usage: "bb linear inbox [--all] | bb linear inbox dismiss <key|--all>",
  },
  {
    name: "start",
    summary: "Start a bb thread from an issue, with its context and status move",
    usage: "bb linear start <ENG-123> [--project <id>] [--no-move]",
  },
  {
    name: "link",
    summary: "Link this thread to an issue",
    usage: "bb linear link <ENG-123> [--thread <id>]",
  },
  {
    name: "unlink",
    summary: "Remove this thread's link to an issue",
    usage: "bb linear unlink [--thread <id>]",
  },
];

const USAGE = `bb linear — Linear issues, and the bb threads and pull requests attached to them.

  bb linear status              Which workspace this bb is connected to
  bb linear doctor              Check every precondition and name what is missing
  bb linear budget              How much of Linear's hourly request budget is left

  bb linear teams               Every team this key can see, and which are bound
  bb linear bind <TEAM-KEY>     Bind a bb project to a Linear team
  bb linear unbind <TEAM-KEY>   Remove a binding
  bb linear refresh             Re-read the workspace after changing the key
  bb linear sync [--full]       Read the bound teams' open issues now

  bb linear create <title…>     Create an issue in the bound team
  bb linear issues              List the bound teams' issues, filtered
  bb linear issue <ENG-123>     Read one issue in full
  bb linear move <ENG-123> <s>  Move it to one of its team's states
  bb linear assign <ENG-123> me Assign it
  bb linear set <ENG-123> --priority 1   Change anything else about it
  bb linear comment <ENG-123> … Comment on it
  bb linear attach <ENG-123> <url>  Attach a link to it
  bb linear archive <ENG-123> --yes Archive it (reversible in Linear)
  bb linear webhook             Whether webhooks are delivering
  bb linear forget --yes        Delete the local copy from this machine
  bb linear inbox               What Linear wants you for
  bb linear start <ENG-123>     Start a bb thread from it
  bb linear link <ENG-123>      Link this thread to it
  bb linear unlink              Remove this thread's link

Run any read command with --json for machine output.`;

export type CliRunner = (
  argv: readonly string[],
  ctx: PluginCliContext,
) => Promise<PluginCliResult>;

/** Linear's priority scale is 0-4, where **0 means no priority** rather than
 *  lowest. Anything outside it is dropped rather than clamped: clamping would
 *  silently mark something Urgent. */
function readPriority(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 4 ? parsed : undefined;
}

/** A limit the user typed. Nonsense falls back to the default rather than
 *  becoming `NaN`, which SQLite would happily accept and return nothing for. */
function readLimit(value: string | undefined, fallback = 30): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 200);
}

/**
 * Which bb project a command is scoped to.
 *
 * `--project` wins, then the project the command was **run from** — bb passes
 * it, and until this existed every project-scoped command fell through to "the
 * only project", which does not exist in a bb with fifteen of them. The
 * symptom was `bb linear issues` answering "no bb project is bound to a Linear
 * team" from inside a bound project, which reads as a broken binding rather
 * than a missing flag.
 */
function projectId(args: ParsedArgs, ctx: PluginCliContext): string | undefined {
  return flagString(args, "project") ?? ctx.projectId;
}

export function createCliRunner(env: CliEnvironment): CliRunner {
  return async (argv, ctx) => {
    const args = parseArgs(argv);
    const [command] = args.positional;
    const wantsJson = flagBoolean(args, "json");

    try {
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return ok(USAGE);

        case "status": {
          const report = await env.status();
          return ok(wantsJson ? json(statusAsJson(report)) : renderStatus(report));
        }

        case "doctor": {
          const checks = await env.doctor();
          return ok(wantsJson ? json({ checks }) : renderDoctor(checks));
        }

        case "budget": {
          const { snapshot, profile } = await env.budget();
          return ok(wantsJson ? json({ profile, budget: snapshot }) : renderBudget(snapshot, profile));
        }

        case "teams": {
          const { teams, bound } = await env.teams();
          if (wantsJson) {
            return ok(
              json({
                teams: teams.map((team) => ({
                  id: team.id,
                  key: team.key,
                  name: team.name,
                  parentId: team.parentId,
                  bound: bound.has(team.id),
                })),
              }),
            );
          }
          if (teams.length === 0) {
            return ok(
              "No teams yet. Either the key has not been checked, or it can see none.\n",
            );
          }
          // The workspace column is empty for every row on a single-workspace
          // install, and `table` drops a column whose every cell is empty.
          const rows = teams.map((team) => [
            bound.has(team.id) ? "bound" : "",
            team.key,
            team.name,
            team.workspaceName ?? "",
          ]);
          // Never a denominator: `teams` returns the teams whose issues this
          // key can access, so what it cannot see is unknowable.
          return ok(
            `${teams.length} ${pluralize(teams.length, "team", "teams")} visible\n${table(rows, "  ")}\n`,
          );
        }

        case "bind": {
          const teamKey = args.positional[1];
          if (teamKey === undefined) {
            return fail("Which team? bb linear bind <TEAM-KEY> [--project <id>]");
          }
          const role = readRole(flagString(args, "role"));
          if (role === null) {
            return fail("--role must be primary, write or read.");
          }
          const result = await env.bind({
            teamKey,
            projectId: projectId(args, ctx),
            role,
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        case "unbind": {
          const teamKey = args.positional[1];
          if (teamKey === undefined) {
            return fail("Which team? bb linear unbind <TEAM-KEY> [--project <id>]");
          }
          const result = await env.unbind({
            teamKey,
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        case "refresh": {
          const result = await env.refresh();
          return result.ok ? ok(result.text) : fail(result.text);
        }

        case "sync": {
          const issues = await env.sync(flagBoolean(args, "full"));
          // A backfill is several requests and does not fit in the CLI's
          // two-second budget, so it runs in the background and this says so
          // rather than inventing a count it never saw.
          if (issues < 0) {
            return ok("Reading from Linear — `bb linear status` shows the result.\n");
          }
          return ok(
            issues === 0
              ? "Nothing new to read.\n"
              : `Read ${issues} ${pluralize(issues, "issue", "issues")}.\n`,
          );
        }

        case "create": {
          const title = args.positional.slice(1).join(" ") || args.rest.join(" ");
          if (title === "") {
            return fail("What should it be called? bb linear create <title…>");
          }
          const priority = flagString(args, "priority");
          const result = await env.create({
            title,
            description: flagString(args, "description"),
            team: flagString(args, "team"),
            assignee: flagString(args, "assignee"),
            priority: priority === undefined ? undefined : readPriority(priority),
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(`${result.message}\n`);
        }

        case "issues": {
          const result = await env.issues({
            state: flagString(args, "state"),
            assignee: flagString(args, "assignee"),
            team: flagString(args, "team"),
            limit: readLimit(flagString(args, "limit")),
            projectId: projectId(args, ctx),
          });
          if (!result.ok) return fail(`${result.message ?? "Could not list issues."}\n`);
          if (wantsJson) {
            return ok(json({ issues: result.rows }));
          }
          if (result.rows.length === 0) {
            return ok(`${result.message ?? "Nothing matches that."}\n`);
          }
          return ok(`${table(result.rows, "  ")}\n`);
        }

        case "attach": {
          const identifier = args.positional[1];
          const url = args.positional[2];
          if (identifier === undefined || url === undefined) {
            return fail("bb linear attach <ENG-123> <url> [--title <text>]");
          }
          const result = await env.attach({
            identifier,
            url,
            title: flagString(args, "title"),
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(`${result.message}\n`);
        }

        case "archive": {
          const identifier = args.positional[1];
          if (identifier === undefined) {
            return fail("Which issue? bb linear archive <ENG-123> --yes");
          }
          // The confirmation is required rather than prompted for: a plugin
          // command has no tty it can trust, and the flag is the same
          // confirmation `forget` asks for.
          const result = await env.archive({
            identifier,
            confirmed: flagBoolean(args, "yes"),
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(`${result.message}\n`);
        }

        case "issue": {
          const identifier = args.positional[1];
          if (identifier === undefined) return fail("Which issue? bb linear issue <ENG-123>");
          const result = await env.issue({
            identifier,
            comments: flagBoolean(args, "comments"),
          });
          return result.ok ? ok(`${result.text}\n`) : fail(result.text);
        }

        case "move": {
          const identifier = args.positional[1];
          const state = args.positional.slice(2).join(" ") || args.rest.join(" ");
          if (identifier === undefined || state === "") {
            return fail("bb linear move <ENG-123> <state-name|state-type>");
          }
          const result = await env.move({
            identifier,
            state,
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        case "assign": {
          const identifier = args.positional[1];
          const who = args.positional[2];
          if (identifier === undefined || who === undefined) {
            return fail("bb linear assign <ENG-123> <me|@name|none>");
          }
          const result = await env.assign({
            identifier,
            who,
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        case "set": {
          const identifier = args.positional[1];
          if (identifier === undefined) {
            return fail("Which issue? bb linear set <ENG-123> --priority 1");
          }
          const result = await env.set({
            identifier,
            priority: flagString(args, "priority"),
            estimate: flagString(args, "estimate"),
            due: flagString(args, "due"),
            project: flagString(args, "project"),
            cycle: flagString(args, "cycle"),
            title: flagString(args, "title"),
            addLabel: flagString(args, "label"),
            removeLabel: flagString(args, "unlabel"),
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(`${result.message}\n`);
        }

        case "comment": {
          const identifier = args.positional[1];
          // Everything after the identifier is the comment. `--` is the escape
          // hatch for text that starts with a dash, which the parser would
          // otherwise read as a flag.
          const body = [...args.positional.slice(2), ...args.rest].join(" ");
          if (identifier === undefined || body.trim() === "") {
            return fail("bb linear comment <ENG-123> <text…>");
          }
          const result = await env.comment({
            identifier,
            body,
            projectId: projectId(args, ctx),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        case "forget": {
          // Destructive, so the flag is required rather than prompted for:
          // `run` executes on the server and has no terminal to prompt into.
          const result = await env.forget({ confirmed: flagBoolean(args, "yes") });
          return result.ok ? ok(result.text) : fail(result.text);
        }

        case "webhook": {
          const result = await env.webhook({
            action: args.positional[1],
            target: args.positional[2],
          });
          return result.ok ? ok(result.text) : fail(result.text);
        }

        case "inbox": {
          const dismiss = args.positional[1] === "dismiss";
          const result = await env.inbox({
            all: flagBoolean(args, "all"),
            dismiss: dismiss ? (args.positional[2] ?? null) : null,
          });
          return result.ok ? ok(`${result.text}\n`) : fail(result.text);
        }

        case "start": {
          const identifier = args.positional[1];
          if (identifier === undefined) return fail("Which issue? bb linear start <ENG-123>");
          const result = await env.start({
            identifier,
            projectId: projectId(args, ctx),
            move: !flagBoolean(args, "no-move"),
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        case "link": {
          const identifier = args.positional[1];
          if (identifier === undefined) return fail("Which issue? bb linear link <ENG-123>");
          const result = await env.link({
            identifier,
            threadId: flagString(args, "thread") ?? ctx.threadId,
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        case "unlink": {
          const result = await env.link({
            identifier: null,
            threadId: flagString(args, "thread") ?? ctx.threadId,
          });
          return result.ok ? ok(`${result.message}\n`) : fail(result.message);
        }

        default:
          return fail(`Unknown command "${command}".\n\n${USAGE}`);
      }
    } catch (error) {
      // Every failure leaves through one place, redacted. A stack trace on
      // stdout would be both useless to the reader and the most likely thing
      // in the whole plugin to carry a key.
      return fail(describeError(error));
    }
  };
}

/**
 * `--json` output is the report, not the rendering.
 *
 * A machine consumer wants `remaining: 2381`, not `"2,381 of 2,500 requests
 * left"` — and the moment a JSON field carries a formatted number, somebody
 * downstream parses it back and the locale bug from `format.ts` returns.
 */
function statusAsJson(report: StatusReport): unknown {
  return {
    connection: report.connection,
    teamsVisible: report.teamsVisible,
    bindings: report.bindings,
    unboundProjects: report.unboundProjects,
    sync: report.sync,
    webhook: report.webhook,
    writeRefusal: report.writeRefusal,
  };
}

function renderBudget(snapshot: BudgetSnapshot | null, profile: SyncProfile): string {
  if (snapshot === null) {
    return [
      "Linear has not reported a budget yet.",
      "",
      "  That is not a problem by itself — the headers arrive with the first request.",
      "  Until one does, the plugin polls at its careful cadence rather than assuming",
      "  it has room.",
      "",
    ].join("\n");
  }

  const bucket = (
    label: string,
    values: { limit: number | null; remaining: number | null; resetAt: number | null },
  ): string => {
    if (values.limit === null && values.remaining === null) return "";
    const used =
      values.limit !== null && values.remaining !== null
        ? `${values.remaining.toLocaleString()} of ${values.limit.toLocaleString()} left`
        : `${(values.remaining ?? 0).toLocaleString()} left`;
    const reset = values.resetAt === null ? "" : `, resets ${formatClock(values.resetAt)}`;
    return `  ${label.padEnd(12)}  ${used}${reset}`;
  };

  const rows = [
    bucket("Requests", snapshot.requests),
    bucket("Complexity", snapshot.complexity),
    bucket(snapshot.endpoint.name ?? "Endpoint", snapshot.endpoint),
  ].filter((row) => row !== "");

  const cost =
    snapshot.lastComplexity === null
      ? ""
      : `\n  Last query cost ${snapshot.lastComplexity} points.`;

  return `Linear · budget (sync cadence: ${profile})\n${rows.join("\n")}${cost}\n`;
}

/**
 * `--role` defaults to primary, because binding a project to its first team is
 * overwhelmingly the common case and typing `--role primary` every time is
 * ceremony. An unrecognised value is refused rather than silently defaulted:
 * a typo that quietly created a read-only binding would surface much later, as
 * tools missing from a thread.
 */
function readRole(raw: string | undefined): BindingRole | null {
  if (raw === undefined) return "primary";
  return raw === "primary" || raw === "write" || raw === "read" ? raw : null;
}
