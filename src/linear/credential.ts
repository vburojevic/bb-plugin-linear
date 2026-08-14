/**
 * How a credential reaches Linear's `Authorization` header.
 *
 * The union exists in v1 even though only `pat` is reachable from the UI. It
 * costs one discriminant and it keeps the OAuth story honest: an organisation
 * that registers its own private Linear OAuth application can supply a client
 * id and secret in settings and the transport already knows what to do with
 * the resulting token. The alternative — hardcoding the PAT shape and adding
 * the union later — is the version that ships a plugin-wide refactor on the
 * day someone needs it.
 */
export type LinearCredential =
  | { readonly kind: "pat"; readonly token: string }
  | {
      readonly kind: "oauth";
      readonly accessToken: string;
      readonly refreshToken: string;
      /** Epoch milliseconds. */
      readonly expiresAt: number;
    };

/**
 * The single most common Linear integration mistake, isolated into one
 * function and unit-tested for both shapes: a **personal API key is sent bare**
 * and an OAuth access token is sent with a `Bearer ` prefix. Same header, same
 * endpoint, two formats. Prefixing a PAT produces a 401 that reads exactly
 * like a revoked key, which is how an afternoon disappears.
 */
export function authHeader(credential: LinearCredential): string {
  return credential.kind === "pat"
    ? credential.token
    : `Bearer ${credential.accessToken}`;
}

/**
 * `readSecret` on the host side is a raw `readFile` with no trim, so a key
 * pasted with a trailing newline persists with one and every request 401s. The
 * fix belongs at every read, not at the one that was noticed.
 *
 * Returns `null` rather than an empty-string credential so callers cannot
 * accidentally send `Authorization: ` and read the resulting 400 as a key
 * problem.
 */
export function patFromSetting(raw: string | undefined | null): LinearCredential | null {
  const token = (raw ?? "").trim();
  return token === "" ? null : { kind: "pat", token };
}

/**
 * A stable, non-reversible handle for a credential.
 *
 * Used for exactly one thing: telling "this key has never worked" apart from
 * "this key used to work and has stopped", which is the difference between
 * *invalid* and *revoked* — two of the three sentences the Connection section
 * promises. Storing the fingerprint rather than the key means the answer
 * survives a restart without a secret ever reaching kv.
 *
 * FNV-1a rather than `node:crypto`, because this module is imported by pure
 * projection code that also runs in the browser bundle, and a 64-bit hash of a
 * high-entropy API key is far more collision-resistant than the question needs
 * to be — the only cost of a collision is one misclassified sentence.
 */
export function credentialFingerprint(credential: LinearCredential): string {
  const material =
    credential.kind === "pat" ? credential.token : credential.accessToken;
  let hi = 0x811c9dc5;
  let lo = 0x01000193;
  for (let index = 0; index < material.length; index += 1) {
    const code = material.charCodeAt(index);
    hi = Math.imul(hi ^ code, 0x01000193) >>> 0;
    lo = Math.imul(lo ^ ((code << 5) | index), 0x85ebca6b) >>> 0;
  }
  return `${hi.toString(16).padStart(8, "0")}${lo.toString(16).padStart(8, "0")}`;
}
