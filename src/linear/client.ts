/**
 * Helpers above the transport, below the product.
 *
 * Grows as milestones land; nothing here may know about bb, settings, or any
 * particular surface. (The predecessor's client module also carried paging
 * and mirror-absorption helpers — those arrive with the mirror in M2.)
 */

import { mutationFailed } from "./errors.js";

/**
 * A mutation that returned a payload rather than an error, but whose payload
 * says it did not happen.
 *
 * `success: false` **with no `errors` array** is a real Linear response and
 * the classic silent failure: HTTP 200, no GraphQL errors, nothing written. A
 * client that only inspects `body.errors` reports success and the issue never
 * moves. The second case — `success: true` with a null entity — is rarer and
 * worse, because it looks like a parse bug instead of a refusal.
 */
export function unwrapMutation<T>(
  payload: { success?: boolean } & Record<string, unknown>,
  entityKey: string,
  what: string,
): T {
  if (payload.success === false) {
    throw mutationFailed(`Linear didn't ${what}.`);
  }
  const entity = payload[entityKey];
  if (entity === null || entity === undefined) {
    throw mutationFailed(`Linear said it would ${what} but returned nothing.`);
  }
  return entity as T;
}
