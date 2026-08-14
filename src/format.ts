/**
 * Formatting, and the arithmetic that must never be done on formatted text.
 *
 * The rule this file exists to enforce: **formatting is a leaf operation.**
 * Nothing that has been through `Intl` is ever parsed, compared, summed or
 * stored. The sibling Xcode plugin found `xcresulttool` emitting `"0,55s"`
 * under a European locale, where `parseFloat` returns `0` — which silently
 * deleted every duration it had. The failure is invisible in the developer's
 * own locale and total in half the world's, which is why CI runs a second leg
 * under `TZ=Pacific/Kiritimati LANG=de_DE.UTF-8`.
 *
 * So every function here splits in two: a pure integer half that tests assert
 * on, and a thin `Intl` half that nothing reads back.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Instants                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The one place Linear's ISO-8601 timestamps become numbers.
 *
 * Called exactly at the transport/store boundary, never again. `Date.parse`
 * returns `NaN` rather than throwing on a value it does not understand, and a
 * `NaN` written into a column silently poisons every comparison it takes part
 * in — so a value that does not parse becomes `null`, which the schema already
 * allows and every reader already handles.
 */
export function parseInstant(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

/** Back to the wire format Linear expects for a `DateTimeOrDuration` filter. */
export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export type RelativeUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The average Gregorian month and year, in milliseconds. Used only to pick a
 *  *unit* for display — never to do calendar arithmetic, which is what
 *  `daysBetweenDates` is for. */
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

/**
 * Pure, integer, locale-free. Negative values mean the past, matching
 * `Intl.RelativeTimeFormat`'s own sign convention so the formatter below is a
 * one-liner and tests never have to know about a locale.
 */
export function relativeParts(
  from: number,
  now: number,
): { readonly value: number; readonly unit: RelativeUnit } {
  const delta = from - now;
  const magnitude = Math.abs(delta);
  const sign = delta < 0 ? -1 : 1;
  const pick = (span: number, unit: RelativeUnit) => ({
    value: sign * Math.max(1, Math.round(magnitude / span)),
    unit,
  });
  if (magnitude < MINUTE) return { value: sign * Math.round(magnitude / 1000), unit: "second" };
  if (magnitude < HOUR) return pick(MINUTE, "minute");
  if (magnitude < DAY) return pick(HOUR, "hour");
  if (magnitude < WEEK) return pick(DAY, "day");
  if (magnitude < MONTH) return pick(WEEK, "week");
  if (magnitude < YEAR) return pick(MONTH, "month");
  return pick(YEAR, "year");
}

const COMPACT_UNIT: Record<RelativeUnit, string> = {
  second: "s",
  minute: "m",
  hour: "h",
  day: "d",
  week: "w",
  month: "mo",
  year: "y",
};

/**
 * The dense form, for a list row's trailing age column: `4s`, `2h`, `3d`.
 *
 * Not localised, deliberately. This is a fixed-width tabular column where the
 * alternative is "vor 3 Tagen" wrapping the row, and the abbreviations are the
 * same ones Linear and every git host already use. The words are not lost —
 * `formatRelative` supplies them, and every row that shows a compact age puts
 * the full sentence in its accessible name, so a screen reader hears
 * "3 days ago" while the eye reads `3d`.
 */
export function formatRelativeCompact(from: number, now: number): string {
  const { value, unit } = relativeParts(from, now);
  const magnitude = Math.abs(value);
  if (unit === "second" && magnitude < 5) return "now";
  return `${magnitude}${COMPACT_UNIT[unit]}`;
}

/** The prose form, in the reader's own language. Never parsed back. */
export function formatRelative(from: number, now: number): string {
  const { value, unit } = relativeParts(from, now);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
}

/** A wall clock, for "resets 15:42". The reader's locale decides 24- or
 *  12-hour; the plugin does not have an opinion about that. */
export function formatClock(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(epochMs);
}

export function formatDateTime(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(epochMs);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Calendar dates                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Linear's `TimelessDate` is `YYYY-MM-DD` and it stays a string, end to end.
 *
 * A due date is a *calendar* fact — "the 3rd" — not an instant. Converting it
 * to epoch milliseconds picks a timezone on the user's behalf, and whichever
 * one is picked is wrong for half the planet by exactly one day: the issue due
 * today reads as overdue, or the overdue one reads as due tomorrow.
 */
export function isTimelessDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Split into integers without going through `Date`. */
function dateParts(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`.
 *
 * Both sides are projected onto UTC midnight *only* to subtract them, which is
 * safe precisely because both get the identical treatment — the timezone
 * cancels. Negative means `to` is in the past.
 */
export function daysBetweenDates(from: string, to: string): number | null {
  const a = dateParts(from);
  const b = dateParts(to);
  if (a === null || b === null) return null;
  const left = Date.UTC(a.y, a.m - 1, a.d);
  const right = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((right - left) / DAY);
}

/** Today, in the reader's own timezone, as a `TimelessDate`. The comparison
 *  point for "overdue": a date is overdue relative to the reader's calendar,
 *  not to UTC's. */
export function todayAsTimelessDate(now: number): string {
  const local = new Date(now);
  const y = local.getFullYear();
  const m = `${local.getMonth() + 1}`.padStart(2, "0");
  const d = `${local.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Render a calendar date without letting it become an instant. `timeZone:
 *  "UTC"` neutralises the projection done to build the value. */
export function formatTimelessDate(value: string): string {
  const parts = dateParts(value);
  if (parts === null) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(parts.y, parts.m - 1, parts.d));
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Sorting                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Human-facing text sorts by the reader's collation: `ä` belongs next to `a`
 * for a German reader and the plugin has no business overruling that.
 * `numeric` so `ENG-2` precedes `ENG-10`.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareTitles(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * Ids, keys and cache keys sort by codepoint.
 *
 * A locale-sensitive sort on a cache key produces a *different ordering on
 * different machines*, which turns a stable key into an unstable one and makes
 * two bb hosts on one workspace disagree about what they have already seen.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Text                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Cap a count for a badge. `99+` rather than `100+` because it is one glyph
 *  narrower and the difference between them has never changed a decision. */
export function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : `${count}`;
}

/** Truncate on a word boundary where one is close by, so a title does not lose
 *  its last word to a mid-syllable cut. Counts UTF-16 units, which is what the
 *  callers' length limits are expressed in. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, max - 1);
  const lastSpace = hard.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard.trimEnd();
  return `${body}…`;
}

/** Join a list the way a sentence does: `A`, `A and B`, `A, B and C`. Used in
 *  refusals and empty states, which are sentences and must read as sentences. */
export function joinSentence(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}

export function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
