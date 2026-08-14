/**
 * A small argv parser, because the host hands the plugin raw `argv` and
 * parsing it is deliberately the plugin's job.
 *
 * `argv` **excludes the command name**: `bb linear issues --state started`
 * arrives as `["issues", "--state", "started"]`. Forgetting that is how a
 * subcommand table silently never matches.
 */

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
  /** Anything after a bare `--`, joined. Used by commands that take free text
   *  (`bb linear comment ENG-1 -- text with --dashes in it`). */
  readonly rest: readonly string[];
}

/**
 * Flags that take no value. Without this the parser cannot tell `--all` (a
 * boolean, followed by a positional) from `--limit` (a value flag), and the
 * ambiguity always resolves the wrong way for whichever one the user typed
 * first.
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "all",
  "yes",
  "full",
  "comments",
  "no-move",
  "verbose",
]);

export function parseArgs(
  argv: readonly string[],
  booleanFlags: ReadonlySet<string> = BOOLEAN_FLAGS,
): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];

  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      if (booleanFlags.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[body] = true;
        continue;
      }
      flags[body] = next;
      index += 1;
      continue;
    }

    positional.push(token);
  }

  return { positional, flags, rest };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  // A `--limit` of `abc` becomes "no limit given" rather than `NaN`, which
  // would flow into a SQL LIMIT and produce an error the user cannot map back
  // to what they typed.
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
