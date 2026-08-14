import { describe, expect, it } from "vitest";
import { estimateComplexity, parseDocument } from "../src/linear/complexity.js";

/**
 * Linear's published formula, applied to shapes small enough to check by hand:
 *
 * > "Each property is 0.1 point, each object is 1 point and any connection
 * > multiplies its children's points based on the given pagination argument,
 * > or the default 50."
 */
describe("estimateComplexity", () => {
  it("charges 0.1 per leaf property", () => {
    expect(estimateComplexity("query A { viewer { id name } }")).toBeCloseTo(1.2, 5);
    //                                  ^ object 1 + two properties 0.2
  });

  it("charges 1 per object", () => {
    expect(estimateComplexity("query A { viewer { organization { id } } }")).toBeCloseTo(
      2.1,
      5,
    );
  });

  it("multiplies a connection's children by its page size", () => {
    const cost = estimateComplexity("query A { teams(first: 10) { nodes { id } } }");
    // teams 1 + 10 * (nodes 1 + id 0.1)
    expect(cost).toBeCloseTo(12, 5);
  });

  it("charges an omitted first: as 50, which is the mistake worth catching", () => {
    const withArgument = estimateComplexity("query A { teams(first: 1) { nodes { id } } }");
    const without = estimateComplexity("query A { teams { nodes { id } } }");
    expect(without).toBeGreaterThan(withArgument * 10);
  });

  it("resolves a page-size variable when the caller supplies one", () => {
    const source = "query A($n: Int!) { teams(first: $n) { nodes { id } } }";
    expect(estimateComplexity(source, { n: 2 })).toBeCloseTo(3.2, 5);
    // An unbound variable falls back to Linear's own default rather than
    // guessing small, because guessing small is how a document passes the
    // check and fails the request.
    expect(estimateComplexity(source)).toBeCloseTo(56, 5);
  });

  it("multiplies nested connections", () => {
    const cost = estimateComplexity(
      "query A { teams(first: 2) { nodes { id issues(first: 3) { nodes { id } } } } }",
    );
    // teams 1 + 2 * (nodes 1 + id 0.1 + (issues 1 + 3 * (nodes 1 + id 0.1)))
    expect(cost).toBeCloseTo(1 + 2 * (1 + 0.1 + (1 + 3 * 1.1)), 5);
  });

  it("expands fragments", () => {
    const cost = estimateComplexity(
      `query A { viewer { ...Bits } }
       fragment Bits on User { id name displayName }`,
    );
    expect(cost).toBeCloseTo(1.3, 5);
  });

  it("counts an inline fragment's selections", () => {
    const cost = estimateComplexity(
      "query A { notifications(first: 2) { nodes { id ... on IssueNotification { issueId } } } }",
    );
    expect(cost).toBeCloseTo(1 + 2 * (1 + 0.1 + 0.1), 5);
  });

  it("takes the most expensive operation in a multi-operation document", () => {
    const cost = estimateComplexity(
      "query A { viewer { id } } query B { teams(first: 10) { nodes { id } } }",
    );
    expect(cost).toBeCloseTo(12, 5);
  });
});

describe("the parser", () => {
  it("records aliases, which is how the batched tick names its lanes", () => {
    const parsed = parseDocument("query A { t0: issues(first: 1) { nodes { id } } }");
    const [field] = parsed.operations[0]!.selections;
    expect(field).toMatchObject({ kind: "field", name: "issues", alias: "t0" });
  });

  it("does not end an argument list on a bracket inside a string", () => {
    const parsed = parseDocument('query A { search(term: "a) b", first: 1) { nodes { id } } }');
    expect(parsed.operations[0]!.selections).toHaveLength(1);
  });

  it("ignores comments", () => {
    const parsed = parseDocument("query A {\n  # not a field\n  viewer { id }\n}");
    expect(parsed.operations[0]!.selections).toHaveLength(1);
  });

  it("terminates on a self-referential fragment instead of hanging", () => {
    // Not valid GraphQL — but a parser that trusts that is a parser that hangs
    // a build on a typo.
    const cost = estimateComplexity(
      "query A { viewer { ...Loop } } fragment Loop on User { id ...Loop }",
    );
    expect(Number.isFinite(cost)).toBe(true);
  });

  it("terminates on an unbalanced document", () => {
    expect(() => estimateComplexity("query A { viewer { id ")).not.toThrow();
  });
});
