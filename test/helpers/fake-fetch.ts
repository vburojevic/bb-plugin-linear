import type { FetchLike } from "../../src/linear/transport.js";

export interface FakeResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** Raw text, for the "Linear returned HTML" cases where `body` cannot express
   *  what came back. */
  readonly text?: string;
  /** Throw instead of answering, for the transport-level failure cases. */
  readonly throws?: Error;
}

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: { query: string; variables: unknown; operationName: string };
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
}

/**
 * A queue of canned responses, so a test can describe a *sequence* — which is
 * what most of the interesting transport behaviour is: retry, breaker,
 * probe-after-cooldown. The last response repeats once the queue empties, so a
 * test that only cares about the steady state supplies one entry.
 */
export function fakeFetch(responses: readonly FakeResponse[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as RecordedRequest["body"],
    });
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    if (response.throws) throw response.throws;

    const headers = new Map(
      Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    return {
      status: response.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () =>
        response.text ?? JSON.stringify(response.body ?? { data: { ok: true } }),
    };
  };

  return { fetch: fetchImpl, requests };
}

/** Rate-limit headers as Linear actually spells them. */
export function budgetHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "X-Complexity": "12",
    "X-RateLimit-Requests-Limit": "2500",
    "X-RateLimit-Requests-Remaining": "2381",
    "X-RateLimit-Requests-Reset": "1780000000",
    "X-RateLimit-Complexity-Limit": "3000000",
    "X-RateLimit-Complexity-Remaining": "2999000",
    "X-RateLimit-Complexity-Reset": "1780000000",
    ...overrides,
  };
}
