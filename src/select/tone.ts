/**
 * State tone and glyph, derived from `WorkflowState.type` and never from a
 * state's name.
 *
 * A workspace's review column is called "In Review", or "Überprüfung", or
 * "レビュー", or "Almost there". Matching on the name means matching on
 * English, and the failure is silent: the row renders in the wrong colour, or
 * an automation resolves to the wrong column, and there is no error anywhere
 * to search for. `type` is Linear's own categorisation and it is the same
 * seven values in every workspace on earth.
 *
 * **Except that it is a `String`, not an enum.** Linear adds members. An
 * exhaustive switch over five of them silently drops issues on triage-enabled
 * teams, so an unrecognised value is a first-class case here: it renders as a
 * plain dot beside the team's own state name, which is a worse row than the
 * others and a much better row than a missing one.
 */

export const STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
] as const;

export type StateType = (typeof STATE_TYPES)[number];
export type Tone = StateType | "unknown";

export function toneForStateType(type: string | null | undefined): Tone {
  return type !== null && type !== undefined && (STATE_TYPES as readonly string[]).includes(type)
    ? (type as StateType)
    : "unknown";
}

/** The class that sets `--bbl` on an ancestor. Everything below it — the
 *  glyph, the identifier, a border tint, a chip — reads that one variable, so
 *  a state change recolours the whole row from a single class swap. */
export function toneClass(tone: Tone): string {
  return `bbl-${tone}`;
}

/**
 * The distinct shape each state gets.
 *
 * Three of the seven states are muted — `backlog`, `canceled` and
 * `duplicate` — so tone alone cannot tell them apart, and tone alone would be
 * a colour encoding besides. Each one gets a *shape* instead: a dashed ring, a
 * ring with a slash, a ring with an inward chevron. Colour then reinforces
 * rather than carries.
 */
export type GlyphShape =
  | "dotted-ring"
  | "dashed-ring"
  | "empty-ring"
  | "progress-ring"
  | "checked-ring"
  | "slashed-ring"
  | "folded-ring"
  | "dot";

const SHAPES: Record<Tone, GlyphShape> = {
  triage: "dotted-ring",
  backlog: "dashed-ring",
  unstarted: "empty-ring",
  started: "progress-ring",
  completed: "checked-ring",
  canceled: "slashed-ring",
  duplicate: "folded-ring",
  unknown: "dot",
};

export function glyphForTone(tone: Tone): GlyphShape {
  return SHAPES[tone];
}

/** A canceled issue's title is struck through as well as marked, because
 *  "this will not happen" is worth saying twice on a row somebody is
 *  scanning. */
export function isStruckThrough(tone: Tone): boolean {
  return tone === "canceled";
}

/**
 * Priority draws a mark only for Urgent and High.
 *
 * Medium, Low and None draw nothing at all. A column with a mark on every row
 * is a column nobody reads, and the two that change what you do next are the
 * two worth spending ink on. The *label* always comes from the workspace's own
 * `issuePriorityValues`, never from a constant in this file.
 */
export type PriorityMark = "urgent" | "high" | null;

export function priorityMark(priority: number): PriorityMark {
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  return null;
}

export function priorityToneClass(mark: PriorityMark): string {
  return mark === "urgent" ? "bbl-danger" : mark === "high" ? "bbl-triage" : "bbl-neutral";
}
