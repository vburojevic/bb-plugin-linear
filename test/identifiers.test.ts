import { describe, expect, it } from "vitest";
import { identifiersInText, MAX_IDENTIFIERS } from "../src/select/identifiers.js";

const found = (text: string): readonly string[] => identifiersInText(text).identifiers;

describe("identifiersInText", () => {
  it("finds a bare identifier", () => {
    expect(found("Fixed in ENG-42.")).toEqual(["ENG-42"]);
  });

  it("finds several, in the order they appear", () => {
    // The first identifier is overwhelmingly the one the message is about, so
    // order is not cosmetic — a single-match message opens straight to it and
    // a multi-match one lists them this way round.
    expect(found("ENG-9 blocks ENG-4, which duplicates ENG-7.")).toEqual([
      "ENG-9",
      "ENG-4",
      "ENG-7",
    ]);
  });

  it("de-duplicates", () => {
    expect(found("ENG-1 again: ENG-1 is still broken")).toEqual(["ENG-1"]);
  });

  it("reads an identifier out of a Linear URL", () => {
    expect(found("see https://linear.app/acme/issue/ENG-12/some-slug for detail")).toEqual([
      "ENG-12",
    ]);
  });

  it("reads a URL with no slug", () => {
    expect(found("https://linear.app/acme/issue/ENG-12")).toEqual(["ENG-12"]);
  });

  it("collapses a URL and a bare mention of the same issue", () => {
    // Otherwise linking an issue and then naming it opens two tabs for one
    // thing.
    expect(found("ENG-3 — https://linear.app/acme/issue/ENG-3/x")).toEqual(["ENG-3"]);
  });

  it("does not read a team key out of the middle of a longer key", () => {
    // `SHENG-12` yielding `ENG-12` would open somebody else's issue from a
    // string that merely ends with a team key. `SHENG` may itself be a real
    // team, so the whole thing is kept and only the substring is refused.
    expect(found("SHENG-12 and XENG-4")).toEqual(["SHENG-12", "XENG-4"]);
    expect(found("SHENG-12")).not.toContain("ENG-12");
  });

  it("does not match a trailing word character", () => {
    expect(found("ENG-12abc")).toEqual([]);
  });

  it("ignores lowercase, which Linear never produces", () => {
    expect(found("eng-42")).toEqual([]);
  });

  it("ignores a single-letter key, which would match every ordered list", () => {
    expect(found("A-1 then B-2")).toEqual([]);
  });

  it("ignores an implausibly long number", () => {
    expect(found("PAGE-1234567890123")).toEqual([]);
  });

  it("still matches the shapes that are not issues, because resolution decides", () => {
    // Deliberate. This parser runs with no team list and no store; being
    // precise here is impossible and being permissive here is free, because
    // every one of these resolves to nothing and the caller falls back
    // silently rather than reporting "no issue called UTF-8".
    expect(found("UTF-8 and SHA-256 and RFC-2119")).toEqual(["UTF-8", "SHA-256", "RFC-2119"]);
  });

  it("caps a pasted report rather than opening a picker of forty", () => {
    const text = Array.from({ length: 30 }, (_, index) => `ENG-${String(index)}`).join(" ");
    const result = identifiersInText(text);
    expect(result.identifiers).toHaveLength(MAX_IDENTIFIERS);
    expect(result.dropped).toBe(30 - MAX_IDENTIFIERS);
  });

  it("reports nothing dropped when nothing was", () => {
    expect(identifiersInText("ENG-1").dropped).toBe(0);
  });

  it("survives empty and identifier-free text", () => {
    expect(found("")).toEqual([]);
    expect(found("no issues here at all")).toEqual([]);
  });

  it("finds an identifier in markdown and code punctuation", () => {
    // Chat text is markdown: the identifier arrives wrapped in backticks,
    // brackets and parentheses far more often than it arrives alone.
    expect(found("`ENG-5`")).toEqual(["ENG-5"]);
    expect(found("(ENG-6)")).toEqual(["ENG-6"]);
    expect(found("[ENG-7]: done")).toEqual(["ENG-7"]);
    expect(found("branch feature/eng-8 vs ENG-8")).toEqual(["ENG-8"]);
  });
});
