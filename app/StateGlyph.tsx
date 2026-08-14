import type { BbFact } from "../src/contract.js";
import { glyphForTone, toneClass, type Tone } from "../src/select/tone.js";

/**
 * One 14px glyph per state, drawn rather than imported.
 *
 * Three of the seven states share the muted tone — backlog, cancelled and
 * duplicate — so colour alone cannot separate them, and colour alone would be
 * a colour encoding besides. Each gets a distinct *shape*: a dashed ring, a
 * ring with a slash, a ring with an inward chevron. The tone then reinforces
 * what the shape already says.
 *
 * Every path uses `currentColor`, and the colour comes from `--bbl` on an
 * ancestor via `.bbl-glyph`. One class swap on the row recolours the glyph,
 * the identifier and the border tint together.
 *
 * `aria-hidden` throughout: the state is already in the row's accessible name,
 * and a second announcement of it is noise in a list of forty.
 */
export function StateGlyph({ tone, className }: { tone: Tone; className?: string }) {
  const shape = glyphForTone(tone);
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      className={`${toneClass(tone)} bbl-glyph shrink-0 ${className ?? ""}`}
      aria-hidden
      focusable="false"
    >
      {shape === "dotted-ring" ? (
        <circle
          cx="8"
          cy="8"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="0.5 2.6"
          strokeLinecap="round"
        />
      ) : null}

      {shape === "dashed-ring" ? (
        <circle
          cx="8"
          cy="8"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeDasharray="2.6 2.2"
        />
      ) : null}

      {shape === "empty-ring" ? (
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      ) : null}

      {/* A ring with a filled half-wedge: started work is visibly partway
          through, and the wedge is the only glyph in the set that fills. */}
      {shape === "progress-ring" ? (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.2A3.8 3.8 0 0 1 8 11.8Z" fill="currentColor" />
        </>
      ) : null}

      {shape === "checked-ring" ? (
        <>
          <circle cx="8" cy="8" r="5.5" fill="currentColor" />
          <path
            d="M5.4 8.2 7.2 10l3.4-3.6"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}

      {shape === "slashed-ring" ? (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M4.6 11.4 11.4 4.6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      ) : null}

      {/* Folded into another issue: a chevron pointing inward, which reads as
          "absorbed" rather than as "cancelled". */}
      {shape === "folded-ring" ? (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M6.2 5.4 8.8 8l-2.6 2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}

      {/* A type Linear added after this release. A plain dot beside the team's
          own state name is a worse row than the others and a much better row
          than a missing one. */}
      {shape === "dot" ? <circle cx="8" cy="8" r="2.6" fill="currentColor" /> : null}
    </svg>
  );
}

/**
 * The bb-native lead: what bb knows about an issue that Linear cannot.
 *
 * Deliberately drawn from the same 14px grid as the state glyph so the two
 * lead columns line up when the grouping changes and the column swaps meaning.
 * `none` renders an empty box rather than nothing, so rows do not shift
 * horizontally as facts arrive.
 */
export function BbFactGlyph({ fact }: { fact: BbFact }) {
  const label = BB_FACT_LABEL[fact];
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      className={`${fact === "none" ? "bbl-neutral" : "bbl-started"} bbl-glyph shrink-0`}
      aria-hidden
      focusable="false"
      data-fact={label}
    >
      {fact === "thread-running" ? (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor">
            <animate
              attributeName="opacity"
              values="1;0.35;1"
              dur="1.8s"
              repeatCount="indefinite"
            />
          </circle>
        </>
      ) : null}

      {fact === "thread-idle" ? (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" />
        </>
      ) : null}

      {/* git's own glyph vocabulary, borrowed rather than reinvented: a branch
          is two nodes and a curve, a pull request adds the arrow. */}
      {fact === "branch" || fact === "pull-request" ? (
        <>
          <circle cx="5" cy="4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="5" cy="12" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 5.7v4.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          {fact === "pull-request" ? (
            <>
              <circle
                cx="11.5"
                cy="4"
                r="1.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M11.5 5.7v3.1a2 2 0 0 1-2 2H6.9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </>
          ) : null}
        </>
      ) : null}
    </svg>
  );
}

const BB_FACT_LABEL: Record<BbFact, string> = {
  "thread-running": "thread running",
  "thread-idle": "thread",
  "pull-request": "pull request",
  branch: "branch",
  none: "",
};

export function describeBbFact(fact: BbFact): string {
  return BB_FACT_LABEL[fact];
}
