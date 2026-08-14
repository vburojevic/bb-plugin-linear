/**
 * Every GraphQL document this plugin sends, as plain strings, in one file.
 *
 * Plain strings rather than a client library's builders because the offline
 * verification plan depends on it: `test/documents.test.ts` walks this
 * registry, parses each source and validates it against the checked-in SDL, so
 * a wrong field name, a wrong argument type or a nullable read as non-null
 * fails in milliseconds on a laptop with no Linear workspace. That test is the
 * entire reason a hand-written GraphQL client is a defensible choice here, and
 * it only works if the documents are inspectable text.
 *
 * Two rules hold for every document below, and both are asserted by tests:
 *
 *   1. **Every connection carries an explicit `first:`, including inner ones.**
 *      An omitted `first:` bills as 50 and nested connections multiply, so one
 *      forgotten argument on an inner selection is a 50× cost multiplier on
 *      everything beneath it.
 *   2. **No shipped document reads a `@deprecated` field.** Linear leaves
 *      deprecated fields in place and working, which is exactly what makes
 *      them easy to adopt and expensive to have adopted.
 */

export interface LinearDocument {
  /** The GraphQL operation name. Also the log and diagnostic label. */
  readonly name: string;
  readonly kind: "query" | "mutation";
  readonly source: string;
  /**
   * Page-size variables, resolved for the complexity estimate. A document that
   * paginates through `first: $n` cannot be costed without knowing what `$n`
   * will be, and guessing Linear's default of 50 would under-report every
   * document that asks for more.
   */
  readonly pageSizes?: Readonly<Record<string, number>>;
}

const registry: LinearDocument[] = [];

function doc(
  name: string,
  kind: LinearDocument["kind"],
  source: string,
  pageSizes: Readonly<Record<string, number>> = {},
): LinearDocument {
  const document: LinearDocument = { name, kind, source, pageSizes };
  registry.push(document);
  return document;
}

/** Every document, for the validation and complexity tests to walk. */
export const DOCUMENTS: readonly LinearDocument[] = registry;

/* ────────────────────────────────────────────────────────────────────────── */
/* Identity                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The one query that answers "does this key work, and whose is it?".
 *
 * It reads `organization` because the accounts surface's whole job is to name
 * the workspace a key belongs to — a user with two Linear accounts pastes the
 * wrong key roughly once, and "Connected as Ada Lovelace in Acme" is what
 * turns that into a two-second fix instead of a puzzling empty panel.
 *
 * `gitBranchFormat` comes along because it is free here and expensive later:
 * it is what makes the plugin's branch-name explanations match the workspace's
 * own convention instead of a guess.
 */
export const VIEWER = doc(
  "Viewer",
  "query",
  `query Viewer {
  viewer {
    id
    name
    displayName
    email
    avatarUrl
    organization {
      id
      name
      urlKey
      gitBranchFormat
    }
  }
}`,
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Discovery                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** One page of teams. 100 covers the overwhelming majority of workspaces in a
 *  single request, and the cursor covers the rest. */
export const TEAM_PAGE_SIZE = 100;

/**
 * The slim team list: enough to resolve "--team Eng" to an id and to label
 * where an issue is about to be created. The full team graph — states,
 * labels, members — is the mirror's job (M2), not this document's.
 *
 * `teams`, not `administrableTeams`: the SDL says `teams` returns "All teams
 * whose issues the user can access", while `administrableTeams` returns teams
 * whose *settings* the user can change but whose issues they may not see.
 */
export const TEAMS_SLIM = doc(
  "TeamsSlim",
  "query",
  `query TeamsSlim($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      key
      name
    }
  }
}`,
  { first: TEAM_PAGE_SIZE },
);

/* ────────────────────────────────────────────────────────────────────────── */
/* Creating                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Create an issue.
 *
 * The selection is deliberately slim in M1: id, identifier, url and
 * branchName are what the CLI prints and what a thread binding needs. When
 * the mirror lands (M2) this grows to the full issue shape so a created
 * issue is absorbed through the same path as a synced one.
 */
export const ISSUE_CREATE = doc(
  "IssueCreate",
  "mutation",
  `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
      branchName
      team {
        id
        key
      }
    }
  }
}`,
);
