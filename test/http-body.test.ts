import { describe, expect, it } from "vitest";
import { readLimitedBody } from "../src/http-body.js";

function streamedRequest(chunks: readonly Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("https://plugin.invalid/webhook", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
}

describe("readLimitedBody", () => {
  it("counts streamed bytes before joining chunks", async () => {
    const request = streamedRequest([
      new Uint8Array([0x61, 0x62]),
      new Uint8Array([0x63, 0x64]),
    ]);
    await expect(readLimitedBody(request, 3)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("accepts a body exactly at the byte limit", async () => {
    await expect(
      readLimitedBody(streamedRequest([new TextEncoder().encode("é")]), 2),
    ).resolves.toEqual({ ok: true, text: "é" });
  });

  it("rejects invalid UTF-8 instead of replacement-decoding signed bytes", async () => {
    await expect(readLimitedBody(streamedRequest([new Uint8Array([0xff])]), 1)).resolves.toEqual({
      ok: false,
      reason: "invalid-encoding",
    });
  });

  it("refuses an oversized declared length without reading the stream", async () => {
    const request = new Request("https://plugin.invalid/webhook", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "x",
    });
    await expect(readLimitedBody(request, 10)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});
