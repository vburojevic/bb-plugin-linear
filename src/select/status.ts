import type { ConnectionState, WriteRefusal } from "../contract.js";
import { definitionList, table } from "../cli-format.js";
import { formatClock, formatRelativeCompact, pluralize } from "../format.js";
import type { SyncProfile } from "../settings.js";

/**
 * `bb linear status` and `bb linear doctor`, as a projection.
 *
 * The report is data and this file turns it into text, which means the same
 * assertions cover the terminal that cover the panel — and it means a
 * milestone that has not shipped yet simply leaves its field `null` and its
 * row does not render. That is the house rule doing the work rather than a
 * feature flag: **a row says nothing when it has nothing to say**, so a status
 * output never grows a `Sync   not implemented` line.
 */

export interface BindingLine {
  readonly projectName: string;
  readonly primaryTeamKey: string | null;
  readonly extra: readonly { readonly key: string; readonly role: "write" | "read" }[];
}

export interface SyncLine {
  readonly profile: SyncProfile;
  readonly intervalMs: number | null;
  readonly lastTickAt: number | null;
  readonly issues: number;
  readonly projects: number;
  readonly lastError: string | null;
}

export interface StatusReport {
  readonly connection: ConnectionState;
  readonly now: number;
  /** How many teams the credential can see. `null` until the graph is
   *  fetched — and note the count is only ever "teams this key can see",
   *  never "of N", because a team-restricted key cannot see what it is
   *  restricted away from, so the denominator is unknowable. */
  readonly teamsVisible: number | null;
  readonly bindings: readonly BindingLine[] | null;
  readonly unboundProjects: number;
  readonly sync: SyncLine | null;
  readonly webhook: string | null;
  readonly writeRefusal: WriteRefusal | null;
}

function connectionHeadline(state: ConnectionState): string {
  switch (state.kind) {
    case "connected":
      return "Linear · connected";
    case "no-credential":
      return "Linear · not connected";
    case "rate-limited":
      return "Linear · throttled";
    case "unreachable":
      return "Linear · unreachable";
    default:
      return "Linear · not connected";
  }
}

function budgetLine(state: ConnectionState): string {
  if (state.kind !== "connected" || state.budget === null) return "";
  const { remaining, limit, resetAt } = state.budget;
  if (remaining === null || limit === null) return "";
  const reset = resetAt === null ? "" : `, resets ${formatClock(resetAt)}`;
  return `${remaining.toLocaleString()} of ${limit.toLocaleString()} requests left${reset}`;
}

function bindingsLine(report: StatusReport): string {
  if (report.bindings === null) return "";
  const bound = report.bindings
    .filter((line) => line.primaryTeamKey !== null)
    .map((line) => {
      const extra = line.extra
        .map((team) => `+${team.key}${team.role === "read" ? " read" : ""}`)
        .join(" ");
      return `${line.projectName} → ${line.primaryTeamKey}${extra === "" ? "" : ` (${extra})`}`;
    });
  const unbound =
    report.unboundProjects === 0
      ? ""
      : `${report.unboundProjects} ${pluralize(report.unboundProjects, "project", "projects")} unbound`;
  if (bound.length === 0) return unbound === "" ? "" : unbound;
  return unbound === "" ? bound.join(" · ") : `${bound.join(" · ")} · ${unbound}`;
}

function syncLineText(sync: SyncLine, now: number): string {
  const cadence =
    sync.intervalMs === null
      ? `${sync.profile}`
      : `polling every ${Math.round(sync.intervalMs / 1000)}s`;
  const last =
    sync.lastTickAt === null ? "no tick yet" : `last tick ${formatRelativeCompact(sync.lastTickAt, now)} ago`;
  const cached = `${sync.issues} ${pluralize(sync.issues, "issue", "issues")}, ${sync.projects} ${pluralize(sync.projects, "project", "projects")} cached`;
  return `${cadence} · ${last} · ${cached}`;
}

export function renderStatus(report: StatusReport): string {
  const { connection, now } = report;
  const lines: (readonly [string, string])[] = [];

  if (connection.kind === "connected") {
    lines.push(["Workspace", `${connection.workspace.name} (${connection.workspace.urlKey})`]);
    lines.push(["You", connection.viewer.displayName]);
  }

  const key =
    connection.kind === "no-credential"
      ? "not set"
      : report.teamsVisible === null
        ? "set"
        : `set · ${report.teamsVisible} ${pluralize(report.teamsVisible, "team", "teams")} visible`;
  lines.push(["Key", key]);

  // The write line appears only once a write has actually come back refused.
  // Linear does not expose a key's scopes, so anything said before that would
  // be a guess dressed as a fact.
  if (report.writeRefusal !== null) {
    lines.push([
      "Write",
      `refused at ${formatClock(report.writeRefusal.at)} — ${report.writeRefusal.what}`,
    ]);
  }

  lines.push(["Bindings", bindingsLine(report)]);
  lines.push(["Sync", report.sync === null ? "" : syncLineText(report.sync, now)]);
  lines.push(["Budget", budgetLine(connection)]);
  lines.push(["Webhook", report.webhook ?? ""]);

  const body = definitionList(lines);
  const problem =
    connection.kind === "connected" || connection.kind === "no-credential"
      ? ""
      : `\n\n${connection.message}`;
  const hint =
    connection.kind === "no-credential"
      ? "\n\n  Add your Linear API key in this plugin's settings, or run:\n    bb plugin config linear set apiKey <key>"
      : "";

  return `${connectionHeadline(connection)}\n${body}${problem}${hint}\n`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Doctor                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about it. Present only when there is something to do — a
   *  passing check with advice attached is noise. */
  readonly fix?: string;
}

const MARK: Record<CheckStatus, string> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
  skip: "—   ",
};

/**
 * Failure-first, like every other surface in this plugin: anything wrong is
 * listed before anything right, because the reason someone runs `doctor` is
 * that something is wrong and they should not have to read past six green
 * lines to find it.
 */
export function renderDoctor(checks: readonly DoctorCheck[]): string {
  const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, skip: 2, ok: 3 };
  const ordered = [...checks].sort((a, b) => rank[a.status] - rank[b.status]);

  const rows = ordered.map((check) => [MARK[check.status], check.label, check.detail]);
  const body = table(rows, "  ");

  const fixes = ordered
    .filter((check) => check.fix !== undefined && check.status !== "ok")
    .map((check) => `  ${check.label}\n    ${check.fix}`);

  const failures = ordered.filter((check) => check.status === "fail").length;
  const warnings = ordered.filter((check) => check.status === "warn").length;
  const verdict =
    failures > 0
      ? `${failures} ${pluralize(failures, "problem", "problems")} to fix`
      : warnings > 0
        ? `nothing broken, ${warnings} ${pluralize(warnings, "thing", "things")} worth knowing`
        : "everything this can check is working";

  return `Linear · ${verdict}\n${body}\n${fixes.length === 0 ? "" : `\n${fixes.join("\n\n")}\n`}`;
}
