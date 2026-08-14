/**
 * `bb linear` — the plugin's CLI, as a pure function.
 *
 * `server.ts` registers it; everything here takes its dependencies as
 * arguments and returns `{ exitCode, stdout, stderr }`, so the whole command
 * surface is unit-testable without a host. Output is compact by intent: the
 * bb CLI proxies whole results (1 MiB ceiling, rejected atomically), and a
 * doctor that prints a screenful per slot is a doctor nobody pastes into a
 * bug report.
 */

import { flagString, parseArgs } from "./cli-args.js";
import type { Accounts } from "./accounts.js";
import { describeError, isLinearError } from "./linear/errors.js";
import type { BudgetSnapshot } from "./linear/budget.js";
import { KEY_SLOTS, type KeySlot } from "./settings.js";

export interface CliDeps {
  readonly accounts: Accounts;
  now?(): number;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const USAGE = `Linear for bb.

Usage:
  bb linear doctor              Connection, identity and budget, per key slot
  bb linear accounts            The configured accounts, one line each
  bb linear create --team <key-or-name> --title <title> [--description <md>] [--account <slot>]

Configure keys with: bb plugin config linear set apiKey <key>
(second workspace: set apiKey2, and so on — a Linear key is scoped to one workspace)`;

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<CliResult> {
  const args = parseArgs(argv);
  const command = args.positional[0];

  try {
    switch (command) {
      case undefined:
      case "help":
        return { exitCode: 0, stdout: USAGE };
      case "doctor":
        return await doctor(deps);
      case "accounts":
        return await accountsCommand(deps);
      case "create":
        return await create(args.positional, args, deps);
      default:
        return {
          exitCode: 1,
          stderr: `Unknown command "${command}".\n\n${USAGE}`,
        };
    }
  } catch (error) {
    return { exitCode: 1, stderr: describeError(error) };
  }
}

/* ── doctor ──────────────────────────────────────────────────────────────── */

async function doctor(deps: CliDeps): Promise<CliResult> {
  const configured = await deps.accounts.configuredSlots();
  if (configured.length === 0) {
    return {
      exitCode: 1,
      stderr:
        "No Linear API key is configured.\n" +
        "Add one with: bb plugin config linear set apiKey <key>\n" +
        "(created in Linear under Settings → Account → Security & access → Personal API keys)",
    };
  }

  const lines: string[] = [];
  let failures = 0;

  for (const slot of KEY_SLOTS) {
    if (!configured.includes(slot)) continue;
    // Force: doctor's whole job is to test the key now, not to report that it
    // worked last Tuesday.
    try {
      const identity = await deps.accounts.identity(slot, { force: true });
      lines.push(
        `Slot ${slot}: connected as ${identity.displayName} (${identity.email}) in ${identity.orgName} (${identity.orgUrlKey})`,
      );
      if (identity.gitBranchFormat !== null) {
        lines.push(`        branch format: ${identity.gitBranchFormat}`);
      }
    } catch (error) {
      failures += 1;
      lines.push(`Slot ${slot}: ${describeError(error)}`);
      if (isLinearError(error) && error.resetAt !== null) {
        lines.push(`        try again ${formatUntil(error.resetAt, now(deps))}`);
      }
      continue;
    }
    const budget = deps.accounts.transport(slot).budget();
    const budgetLine = formatBudget(budget, now(deps));
    if (budgetLine !== null) lines.push(`        ${budgetLine}`);
    const breaker = deps.accounts.transport(slot).breaker();
    if (breaker.open) {
      lines.push(
        `        reads paused after repeated failures${breaker.lastError === null ? "" : ` (${breaker.lastError})`}`,
      );
    }
  }

  lines.push("");
  lines.push("Webhooks: not built yet (M2) — nothing is listening.");
  lines.push("Mirror:   not built yet (M2) — reads go straight to Linear.");

  return { exitCode: failures === 0 ? 0 : 1, stdout: lines.join("\n") };
}

/* ── accounts ────────────────────────────────────────────────────────────── */

async function accountsCommand(deps: CliDeps): Promise<CliResult> {
  const configured = await deps.accounts.configuredSlots();
  if (configured.length === 0) {
    return {
      exitCode: 0,
      stdout: "No accounts configured. Add one with: bb plugin config linear set apiKey <key>",
    };
  }
  const lines: string[] = [];
  for (const slot of configured) {
    try {
      const identity = await deps.accounts.identity(slot);
      lines.push(
        `${slot}  ${identity.orgName} (${identity.orgUrlKey})  ${identity.displayName} <${identity.email}>`,
      );
    } catch (error) {
      lines.push(`${slot}  ${describeError(error)}`);
    }
  }
  return { exitCode: 0, stdout: lines.join("\n") };
}

/* ── create ──────────────────────────────────────────────────────────────── */

async function create(
  positional: readonly string[],
  args: ReturnType<typeof parseArgs>,
  deps: CliDeps,
): Promise<CliResult> {
  const title = flagString(args, "title") ?? (positional.slice(1).join(" ") || undefined);
  const teamQuery = flagString(args, "team");
  const description = flagString(args, "description");
  const slotFlag = flagString(args, "account");

  if (title === undefined || teamQuery === undefined) {
    return {
      exitCode: 1,
      stderr:
        'Usage: bb linear create --team <key-or-name> --title <title> [--description <markdown>] [--account <slot>]',
    };
  }

  const configured = await deps.accounts.configuredSlots();
  if (configured.length === 0) {
    return {
      exitCode: 1,
      stderr: "No Linear API key is configured — bb linear doctor explains how.",
    };
  }

  const slots = narrowSlots(configured, slotFlag);
  if (slots.length === 0) {
    return {
      exitCode: 1,
      stderr: `--account ${slotFlag} does not name a configured slot (configured: ${configured.join(", ")}).`,
    };
  }

  // Resolve the team by exact key or exact name, case-insensitively, across
  // the candidate accounts. Ambiguity is a refusal that names both sides, not
  // a guess — a cross-workspace create is precisely the mistake to prevent.
  const matches: { slot: KeySlot; teamId: string; teamKey: string; where: string }[] = [];
  for (const slot of slots) {
    const teams = await deps.accounts.teams(slot);
    const query = teamQuery.toLowerCase();
    for (const team of teams) {
      if (team.key.toLowerCase() === query || team.name.toLowerCase() === query) {
        const identity = await deps.accounts.identity(slot);
        matches.push({
          slot,
          teamId: team.id,
          teamKey: team.key,
          where: `${team.name} (${team.key}) in ${identity.orgName}`,
        });
      }
    }
  }

  if (matches.length === 0) {
    return {
      exitCode: 1,
      stderr: `No team named "${teamQuery}" in ${slots.length === 1 ? "that account" : "any configured account"}. bb linear accounts lists them.`,
    };
  }
  if (matches.length > 1) {
    return {
      exitCode: 1,
      stderr:
        `"${teamQuery}" matches more than one team:\n` +
        matches.map((match) => `  --account ${match.slot}: ${match.where}`).join("\n") +
        "\nSay which with --account <slot>.",
    };
  }

  const match = matches[0]!;
  const issue = await deps.accounts.createIssue(match.slot, {
    teamId: match.teamId,
    title,
    ...(description === undefined ? {} : { description }),
  });
  return {
    exitCode: 0,
    stdout: `${issue.identifier}  ${issue.title}\n${issue.url}\nbranch: ${issue.branchName}`,
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function narrowSlots(configured: KeySlot[], slotFlag: string | undefined): KeySlot[] {
  if (slotFlag === undefined) return configured;
  const wanted = Number(slotFlag);
  return configured.filter((slot) => slot === wanted);
}

function now(deps: CliDeps): number {
  return deps.now?.() ?? Date.now();
}

function formatBudget(snapshot: BudgetSnapshot | null, at: number): string | null {
  if (snapshot === null) return null;
  const { requests } = snapshot;
  if (requests.remaining === null || requests.limit === null) return null;
  const reset =
    requests.resetAt === null ? "" : ` (resets ${formatUntil(requests.resetAt, at)})`;
  return `budget: ${requests.remaining} of ${requests.limit} requests remaining${reset}`;
}

function formatUntil(resetAt: number, at: number): string {
  const deltaMs = resetAt - at;
  if (deltaMs <= 0) return "now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours}h ${minutes % 60}m`;
}
