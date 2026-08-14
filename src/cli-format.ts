import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "./sdk-runtime.js";

/**
 * Terminal output shaping, and the ceiling it must stay under.
 *
 * The host rejects an oversize CLI result **atomically** — it returns
 * `plugin_cli_output_too_large` and the user gets nothing, rather than a
 * clipped answer. So every command that can grow pages, and everything passes
 * through `capOutput` on the way out as the last line of defence.
 */

/**
 * Well under the host's 1,048,576. The margin is not superstition: the cap is
 * measured in UTF-8 *bytes* and this is measured in JavaScript string units,
 * so a result full of non-ASCII issue titles can be up to three times larger
 * on the wire than it looks here.
 */
const SAFE_OUTPUT_CHARS = 240_000;

export function capOutput(text: string): string {
  if (text.length <= SAFE_OUTPUT_CHARS) return text;
  const kept = text.slice(0, SAFE_OUTPUT_CHARS);
  const lastNewline = kept.lastIndexOf("\n");
  const body = lastNewline > SAFE_OUTPUT_CHARS / 2 ? kept.slice(0, lastNewline) : kept;
  return `${body}\n\n… output truncated. Narrow it with a filter, or use --json and page it.`;
}

/** The host's own ceiling, re-exported so a caller measuring a payload does
 *  not have to reach past this module for the number. */
export const HOST_OUTPUT_LIMIT = PLUGIN_CLI_OUTPUT_MAX_BYTES;

/**
 * A two-column block: labels padded to a common width, values after them.
 *
 * Padding is computed from the labels actually present rather than a constant,
 * so a block with short labels does not carry a gutter sized for a block
 * somewhere else in the file.
 */
export function definitionList(
  pairs: readonly (readonly [string, string])[],
  indent = "  ",
): string {
  const present = pairs.filter(([, value]) => value !== "");
  if (present.length === 0) return "";
  const width = Math.max(...present.map(([label]) => label.length));
  return present
    .map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`)
    .join("\n");
}

/**
 * Columns for a list of rows.
 *
 * Widths come from the content, and a column whose every cell is empty
 * disappears entirely — which is the table version of the rule that a row says
 * nothing when it has nothing to say.
 */
export function table(rows: readonly (readonly string[])[], indent = ""): string {
  if (rows.length === 0) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    widths.push(Math.max(...rows.map((row) => (row[column] ?? "").length)));
  }
  return rows
    .map((row) => {
      const cells: string[] = [];
      for (let column = 0; column < columnCount; column += 1) {
        if (widths[column] === 0) continue;
        const cell = row[column] ?? "";
        cells.push(column === columnCount - 1 ? cell : cell.padEnd(widths[column]!));
      }
      return `${indent}${cells.join("  ")}`.trimEnd();
    })
    .join("\n");
}

/** Machine output. Two-space indent because a human reads this too, usually
 *  while working out what to pipe it into. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout: capOutput(stdout) };
}

/**
 * A failure a person caused (a bad identifier, a missing flag) or a refusal
 * the plugin authored.
 *
 * Exit code 1 and the sentence on stderr — so `bb linear issue NOPE-1 --json |
 * jq` fails rather than piping a human-readable apology into a JSON parser.
 */
export function fail(message: string): CliResult {
  return { exitCode: 1, stderr: capOutput(message.endsWith("\n") ? message : `${message}\n`) };
}
