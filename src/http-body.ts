export const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;

export type LimitedBody =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too-large" | "invalid-encoding" };

/** Read a request body with a byte limit enforced while the stream is read.
 * `Content-Length` is only an early refusal; chunked requests and dishonest
 * headers still pass through the counted stream. */
export async function readLimitedBody(
  request: Request,
  maxBytes = WEBHOOK_BODY_LIMIT_BYTES,
): Promise<LimitedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) {
      return { ok: false, reason: "too-large" };
    }
  }

  if (request.body === null) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body exceeds limit").catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "invalid-encoding" };
  }
}
