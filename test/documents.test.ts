import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildSchema,
  getNamedType,
  isObjectType,
  parse,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type GraphQLSchema,
} from "graphql";
import { describe, expect, it } from "vitest";
import { DOCUMENTS } from "../src/linear/documents.js";
import {
  estimateComplexity,
  LINEAR_QUERY_COMPLEXITY_CEILING,
  SELF_IMPOSED_COMPLEXITY_BUDGET,
} from "../src/linear/complexity.js";

/**
 * What replaces a live API.
 *
 * The checked-in SDL is the authority: every shipped document is parsed and
 * validated against it, which catches the whole class of failure a
 * hand-written GraphQL client is exposed to — a wrong field name, a wrong
 * argument type, a nullable read as non-null — offline, in milliseconds, with
 * no Linear workspace anywhere near CI.
 *
 * `Issue.gitBranchName` would have failed here. It does not exist; the field
 * is `Issue.branchName`, and the difference is one query that returns an
 * unknown-field error at runtime for a user who then files a bug.
 */

const schemaPath = fileURLToPath(new URL("../src/schema/linear.graphql", import.meta.url));

let cached: GraphQLSchema | undefined;
function schema(): GraphQLSchema {
  // 1.3 MB of SDL, built once for the whole file.
  cached ??= buildSchema(readFileSync(schemaPath, "utf8"), { assumeValidSDL: true });
  return cached;
}

describe("every shipped document", () => {
  it("has at least one document to check", () => {
    expect(DOCUMENTS.length).toBeGreaterThan(0);
  });

  for (const document of DOCUMENTS) {
    describe(document.name, () => {
      it("parses and validates against the checked-in SDL", () => {
        const ast = parse(document.source);
        const errors = validate(schema(), ast);
        expect(
          errors.map((error) => error.message),
          `${document.name} does not validate`,
        ).toEqual([]);
      });

      it("names its operation, so a log line and an error can identify it", () => {
        expect(document.source).toMatch(
          new RegExp(`\\b(query|mutation)\\s+${document.name}\\b`),
        );
      });

      it("declares the operation kind it actually is", () => {
        const isMutation = /^\s*mutation\b/m.test(document.source);
        expect(isMutation ? "mutation" : "query").toBe(document.kind);
      });

      it("reads no @deprecated field or argument", () => {
        // Linear leaves deprecated fields working, which is exactly what makes
        // them easy to adopt and expensive to have adopted:
        // `Team.reviewWorkflowState` still answers, and it is the wrong
        // answer.
        const found: string[] = [];
        const typeInfo = new TypeInfo(schema());
        visit(
          parse(document.source),
          visitWithTypeInfo(typeInfo, {
            Field(node) {
              const field = typeInfo.getFieldDef();
              if (field?.deprecationReason) {
                found.push(`${node.name.value} (${field.deprecationReason})`);
              }
            },
            Argument(node) {
              const argument = typeInfo.getArgument();
              if (argument?.deprecationReason) {
                found.push(`argument ${node.name.value} (${argument.deprecationReason})`);
              }
            },
          }),
        );
        expect(found).toEqual([]);
      });

      it("passes an explicit first: to every connection", () => {
        // An omitted `first:` bills as 50 and nested connections multiply, so
        // one forgotten argument on an inner selection is a 50x multiplier on
        // everything beneath it.
        const missing: string[] = [];
        const typeInfo = new TypeInfo(schema());
        visit(
          parse(document.source),
          visitWithTypeInfo(typeInfo, {
            Field(node) {
              const type = typeInfo.getType();
              if (type === undefined || type === null) return;
              const named = getNamedType(type);
              if (!isObjectType(named) || !named.name.endsWith("Connection")) return;
              const paginated = (node.arguments ?? []).some(
                (argument) =>
                  argument.name.value === "first" || argument.name.value === "last",
              );
              if (!paginated) missing.push(node.name.value);
            },
          }),
        );
        expect(missing).toEqual([]);
      });

      it("costs less than this plugin's own complexity budget", () => {
        // Linear's ceiling is 10,000 points. This plugin holds itself to 8,000
        // because the batched tick is built from a live team list: a document
        // sitting at 9,900 passes today and fails on the day a user binds
        // their fourth team, in production, with no local reproduction.
        const cost = estimateComplexity(document.source, document.pageSizes ?? {});
        expect(cost, `${document.name} costs ${cost} points`).toBeLessThan(
          SELF_IMPOSED_COMPLEXITY_BUDGET,
        );
        expect(SELF_IMPOSED_COMPLEXITY_BUDGET).toBeLessThan(
          LINEAR_QUERY_COMPLEXITY_CEILING,
        );
      });
    });
  }
});
