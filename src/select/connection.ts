import type { BudgetSnapshot } from "../linear/budget.js";
import { describeError, isLinearError } from "../linear/errors.js";
import type { ViewerResult } from "../linear/types.js";
import type { BudgetView, ConnectionState } from "../contract.js";

/**
 * Pure projection: a verification attempt's outcome becomes exactly what the
 * Connection section renders.
 *
 * This is what replaces a DOM test. `renderSlot` lives in
 * `@bb/plugin-sdk/testing/app`, which is part of a package that is not on npm,
 * so it cannot run in a fork's CI — and a plugin whose UI is only verifiable
 * on the author's machine is a plugin whose UI regresses. Making the states a
 * discriminated union and the components thin switches over it moves every
 * interesting assertion into plain vitest.
 */

export function budgetView(snapshot: BudgetSnapshot | null): BudgetView | null {
  if (snapshot === null) return null;
  const { requests } = snapshot;
  if (requests.limit === null && requests.remaining === null) return null;
  return {
    remaining: requests.remaining,
    limit: requests.limit,
    resetAt: requests.resetAt,
  };
}

export function connectedState(input: {
  readonly result: ViewerResult;
  readonly budget: BudgetSnapshot | null;
  readonly writeRefusal: { at: number; what: string } | null;
  readonly checkedAt: number;
}): ConnectionState {
  const { viewer } = input.result;
  return {
    kind: "connected",
    viewer: {
      id: viewer.id,
      name: viewer.name,
      displayName: viewer.displayName,
      avatarUrl: viewer.avatarUrl,
    },
    workspace: {
      id: viewer.organization.id,
      name: viewer.organization.name,
      urlKey: viewer.organization.urlKey,
    },
    budget: budgetView(input.budget),
    writeRefusal: input.writeRefusal,
    checkedAt: input.checkedAt,
  };
}

/**
 * One failure, one sentence, and the sentence carries the fix.
 *
 * `hasVerifiedBefore` is the whole reason *invalid* and *revoked* can be told
 * apart. Linear answers 401 for both, so without that fact the plugin would
 * have to tell a user who has been working all week that their key "may be
 * mistyped", which sends them to check a field that is fine.
 */
export function classifyVerificationFailure(input: {
  readonly error: unknown;
  readonly hasVerifiedBefore: boolean;
}): ConnectionState {
  const { error, hasVerifiedBefore } = input;

  if (!isLinearError(error)) {
    return { kind: "error", message: describeError(error) };
  }

  switch (error.code) {
    case "unauthorized":
      return hasVerifiedBefore
        ? {
            kind: "revoked",
            message:
              "Linear is no longer accepting this key — it was working before, so it has probably been revoked. Create a new personal API key in Linear and save it in the Linear API key field.",
          }
        : {
            kind: "invalid-key",
            message:
              "Linear rejected this key. Check it was copied whole, and that it is a personal API key rather than an OAuth client secret.",
          };

    case "forbidden":
      return {
        kind: "error",
        message:
          "Linear accepted the key but refused the request. If the key is restricted to particular teams, that is expected — everything outside those teams stays invisible to it.",
      };

    case "rate_limited":
    case "budget":
      return {
        kind: "rate-limited",
        message: "Linear's request budget is used up for now.",
        resetAt: error.resetAt,
      };

    case "network":
    case "timeout":
      return {
        kind: "unreachable",
        message: `Couldn't reach Linear. ${error.message}`,
      };

    default:
      return { kind: "error", message: error.message };
  }
}

/**
 * A one-line summary for `bb linear status` and for the plugin's status
 * detail — the same facts as the section above, in the register of a terminal.
 */
export function describeConnection(state: ConnectionState): string {
  switch (state.kind) {
    case "no-credential":
      return "not connected — no API key";
    case "connected":
      return `connected as ${state.viewer.displayName} in ${state.workspace.name}`;
    case "invalid-key":
      return "not connected — Linear rejected the key";
    case "revoked":
      return "not connected — the key appears to have been revoked";
    case "unreachable":
      return "unreachable — Linear did not answer";
    case "rate-limited":
      return "throttled — Linear's request budget is used up";
    case "error":
      return `error — ${state.message}`;
  }
}
