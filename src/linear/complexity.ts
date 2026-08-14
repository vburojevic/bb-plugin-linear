/**
 * A cost model for the documents this plugin sends, and the parser it needs.
 *
 * Linear publishes the formula, and it is three constants:
 *
 * > "Each property is 0.1 point, each object is 1 point and any connection
 * > multiplies its children's points based on the given pagination argument,
 * > or the default 50."
 *
 * A single query may not exceed **10,000 points** (verified — see
 * `docs/verified.md`). This plugin holds itself to 8,000, and the gap is the
 * whole reason the check is worth running: the batched tick document is built
 * from a *live* team list, so its cost changes when a user binds a project. A
 * document that sits at 9,900 passes today and fails on the day someone binds
 * their fourth team, in production, with no local reproduction. Sharding at
 * 8,000 keeps that headroom permanently.
 *
 * The parser is hand-written rather than `graphql`'s, because `graphql` is a
 * devDependency used by the offline validation test and must not enter the
 * shipped bundle for a 1.3 MB SDL's worth of machinery the runtime never
 * needs. What it has to understand is exactly the subset this repo writes:
 * operations, fragment definitions, aliases, arguments, fragment spreads and
 * inline fragments. No directives, no subscriptions, no variable definitions
 * beyond skipping them.
 */

const PROPERTY_COST = 0.1;
const OBJECT_COST = 1;
/** What Linear charges for a connection with no `first:`/`last:`. */
export const DEFAULT_PAGE_SIZE = 50;
/** Linear's published per-query ceiling. */
export const LINEAR_QUERY_COMPLEXITY_CEILING = 10_000;
/** This plugin's own ceiling; see the header comment for why it is lower. */
export const SELF_IMPOSED_COMPLEXITY_BUDGET = 8_000;

export type Selection =
  | {
      readonly kind: "field";
      readonly name: string;
      readonly alias: string | null;
      readonly args: string;
      readonly selections: readonly Selection[];
    }
  | { readonly kind: "spread"; readonly name: string }
  | { readonly kind: "inline"; readonly selections: readonly Selection[] };

export interface ParsedDocument {
  readonly operations: readonly {
    readonly name: string | null;
    readonly selections: readonly Selection[];
  }[];
  readonly fragments: ReadonlyMap<string, readonly Selection[]>;
}

class Scanner {
  private index = 0;

  constructor(private readonly source: string) {}

  get done(): boolean {
    return this.index >= this.source.length;
  }

  peek(): string {
    return this.source[this.index] ?? "";
  }

  /**
   * Advance past whitespace, commas (insignificant in GraphQL) and comments.
   *
   * `#` only starts a comment outside a string, and the only strings this
   * parser meets are inside argument lists, which `readArguments` consumes
   * wholesale — so by construction a `#` reached here is always a comment.
   */
  skipTrivia(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === "#") {
        while (this.index < this.source.length && this.source[this.index] !== "\n") {
          this.index += 1;
        }
        continue;
      }
      if (char === "," || /\s/.test(char)) {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  readName(): string {
    this.skipTrivia();
    const start = this.index;
    while (this.index < this.source.length && /[_A-Za-z0-9]/.test(this.source[this.index]!)) {
      this.index += 1;
    }
    return this.source.slice(start, this.index);
  }

  /** Consume one character if it matches, and report whether it did. */
  eat(char: string): boolean {
    this.skipTrivia();
    if (this.source[this.index] === char) {
      this.index += 1;
      return true;
    }
    return false;
  }

  /**
   * Consume a balanced `(...)` or `[...]`/`{...}` run, honouring strings and
   * block strings so a `)` inside a default value cannot end the run early.
   */
  readBalanced(open: string, close: string): string {
    this.skipTrivia();
    if (this.source[this.index] !== open) return "";
    const start = this.index;
    let depth = 0;
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === '"') {
        this.skipString();
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          this.index += 1;
          return this.source.slice(start, this.index);
        }
      }
      this.index += 1;
    }
    return this.source.slice(start, this.index);
  }

  private skipString(): void {
    if (this.source.startsWith('"""', this.index)) {
      this.index += 3;
      const end = this.source.indexOf('"""', this.index);
      this.index = end === -1 ? this.source.length : end + 3;
      return;
    }
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (char === '"') return;
    }
  }
}

function parseSelectionSet(scanner: Scanner): Selection[] {
  const selections: Selection[] = [];
  if (!scanner.eat("{")) return selections;

  while (!scanner.done) {
    scanner.skipTrivia();
    if (scanner.eat("}")) return selections;

    if (scanner.peek() === ".") {
      // `...Name` or `... on Type { … }`
      scanner.eat(".");
      scanner.eat(".");
      scanner.eat(".");
      const name = scanner.readName();
      if (name === "on") {
        scanner.readName(); // the type condition, which costs nothing
        selections.push({ kind: "inline", selections: parseSelectionSet(scanner) });
      } else if (name === "") {
        selections.push({ kind: "inline", selections: parseSelectionSet(scanner) });
      } else {
        selections.push({ kind: "spread", name });
      }
      continue;
    }

    const first = scanner.readName();
    if (first === "") {
      // Something unexpected: step past it rather than spinning forever. The
      // offline SDL validation is what catches malformed documents; this
      // estimator's job is to never be the thing that hangs a build.
      scanner.readBalanced("(", ")");
      if (scanner.peek() === "") break;
      scanner.eat(scanner.peek());
      continue;
    }

    let name = first;
    let alias: string | null = null;
    if (scanner.eat(":")) {
      alias = first;
      name = scanner.readName();
    }
    const args = scanner.readBalanced("(", ")");
    scanner.skipTrivia();
    const selections_ = scanner.peek() === "{" ? parseSelectionSet(scanner) : [];
    selections.push({ kind: "field", name, alias, args, selections: selections_ });
  }
  return selections;
}

export function parseDocument(source: string): ParsedDocument {
  const scanner = new Scanner(source);
  const operations: { name: string | null; selections: readonly Selection[] }[] = [];
  const fragments = new Map<string, readonly Selection[]>();

  while (!scanner.done) {
    scanner.skipTrivia();
    if (scanner.done) break;

    if (scanner.peek() === "{") {
      operations.push({ name: null, selections: parseSelectionSet(scanner) });
      continue;
    }

    const keyword = scanner.readName();
    if (keyword === "") break;

    if (keyword === "fragment") {
      const name = scanner.readName();
      scanner.readName(); // "on"
      scanner.readName(); // the type condition
      fragments.set(name, parseSelectionSet(scanner));
      continue;
    }

    if (keyword === "query" || keyword === "mutation" || keyword === "subscription") {
      scanner.skipTrivia();
      const name = /[_A-Za-z]/.test(scanner.peek()) ? scanner.readName() : null;
      scanner.readBalanced("(", ")"); // variable definitions
      operations.push({ name, selections: parseSelectionSet(scanner) });
      continue;
    }

    // Anything else at the top level is not something this repo writes.
    scanner.readBalanced("{", "}");
  }

  return { operations, fragments };
}

/**
 * Whether a field bills as a connection.
 *
 * Two signals, and the second is the one that earns its keep. A `first:` or
 * `last:` argument is the direct evidence. The presence of a `nodes` or
 * `edges` child is the *indirect* evidence, and it exists so that the one
 * mistake this whole module is guarding against — an inner connection with no
 * `first:` — is costed at Linear's 50 rather than as a plain object. Without
 * it, the estimator would under-report exactly the documents that are about to
 * be rejected.
 */
function connectionPageSize(
  field: Extract<Selection, { kind: "field" }>,
  variables: Readonly<Record<string, number>>,
): number | null {
  const paginated = /\b(?:first|last)\s*:\s*(\$?[A-Za-z0-9_]+)/.exec(field.args);
  const looksLikeConnection = field.selections.some(
    (child) => child.kind === "field" && (child.name === "nodes" || child.name === "edges"),
  );

  if (paginated) {
    const raw = paginated[1]!;
    if (raw.startsWith("$")) {
      const bound = variables[raw.slice(1)];
      return bound !== undefined && Number.isFinite(bound) ? bound : DEFAULT_PAGE_SIZE;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_PAGE_SIZE;
  }

  return looksLikeConnection ? DEFAULT_PAGE_SIZE : null;
}

function costSelections(
  selections: readonly Selection[],
  fragments: ReadonlyMap<string, readonly Selection[]>,
  variables: Readonly<Record<string, number>>,
  expanding: ReadonlySet<string>,
): number {
  let total = 0;
  for (const selection of selections) {
    if (selection.kind === "spread") {
      // A self-referential fragment is not valid GraphQL, but a parser that
      // trusts that is a parser that hangs on a typo.
      if (expanding.has(selection.name)) continue;
      const target = fragments.get(selection.name);
      if (target === undefined) continue;
      total += costSelections(
        target,
        fragments,
        variables,
        new Set([...expanding, selection.name]),
      );
      continue;
    }
    if (selection.kind === "inline") {
      total += costSelections(selection.selections, fragments, variables, expanding);
      continue;
    }
    if (selection.selections.length === 0) {
      total += PROPERTY_COST;
      continue;
    }
    const children = costSelections(selection.selections, fragments, variables, expanding);
    const pageSize = connectionPageSize(selection, variables);
    total +=
      pageSize === null ? OBJECT_COST + children : OBJECT_COST + pageSize * children;
  }
  return total;
}

/**
 * The estimate, in Linear's points.
 *
 * Deliberately an over-estimate in one place: a connection multiplies its
 * *entire* child subtree, including `pageInfo`, where Linear almost certainly
 * multiplies only the node subtree. Over-counting a `pageInfo` by 50 × 0.2
 * points is ten points of pessimism per connection; under-counting would mean
 * the check passes and the request does not.
 *
 * `variables` lets a caller resolve `first: $n` to the page size it will
 * actually send — the batched tick's whole cost depends on it. An unbound
 * variable falls back to Linear's own default of 50.
 */
export function estimateComplexity(
  document: string,
  variables: Readonly<Record<string, number>> = {},
): number {
  const parsed = parseDocument(document);
  let worst = 0;
  for (const operation of parsed.operations) {
    const cost = costSelections(operation.selections, parsed.fragments, variables, new Set());
    if (cost > worst) worst = cost;
  }
  // Points are compared against integer ceilings and printed in diagnostics;
  // carrying float noise from 0.1-per-property into either is pointless.
  return Math.round(worst * 10) / 10;
}
