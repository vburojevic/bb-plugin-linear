import { describe, expect, it } from "vitest";
import {
  describeError,
  forgetSecrets,
  mutationFailed,
  queryFailed,
  redact,
  rememberSecret,
} from "../src/linear/errors.js";
import { unwrapMutation } from "../src/linear/client.js";

describe("redact", () => {
  it("removes a registered key wherever it appears", () => {
    rememberSecret("lin_api_thisIsTheLiveKey00");
    expect(redact("Authorization failed for lin_api_thisIsTheLiveKey00 at 10:02")).not.toContain(
      "thisIsTheLiveKey",
    );
  });

  it("removes a key it has never been told about, by shape", () => {
    // Somebody else's key, pasted into a query variable, in a log line nobody
    // expected to carry one.
    const message = "variables: { token: \"lin_api_AbCd1234_someone-elses\" }";
    expect(redact(message)).toContain("lin_[redacted]");
    expect(redact(message)).not.toContain("AbCd1234");
  });

  it("removes a key hiding inside a serialised request dump", () => {
    const dump = "POST /graphql\nauthorization: lin_api_xyzzy\ncontent-type: application/json";
    expect(redact(dump)).toContain("authorization: [redacted]");
    expect(redact(dump)).not.toContain("xyzzy");
  });

  it("removes a bearer token", () => {
    expect(redact("Authorization: Bearer eyJhbGciOi.J9.abcdefgh")).not.toContain("eyJhbGciOi");
  });

  it("survives a URL and a stack trace", () => {
    rememberSecret("lin_api_stackKey0123456");
    const stack = [
      "LinearError: request failed",
      "    at fetch (https://api.linear.app/graphql?key=lin_api_stackKey0123456:1:1)",
      "    at execute (/app/src/linear/transport.ts:210:5)",
    ].join("\n");
    const output = redact(stack);
    expect(output).not.toContain("stackKey");
    expect(output).toContain("transport.ts:210:5");
  });

  it("refuses to remember something too short to be a key", () => {
    // A short secret would match everywhere and turn every log line into
    // [redacted], destroying the diagnostics the log exists for.
    rememberSecret("abc");
    expect(redact("abc def")).toBe("abc def");
  });

  it("redacts the longest match first", () => {
    rememberSecret("lin_api_prefixLONGERKEY");
    rememberSecret("lin_api_prefix00000000");
    const output = redact("key=lin_api_prefixLONGERKEY end");
    expect(output).toBe("key=[redacted] end");
  });

  it("forgets on dispose", () => {
    rememberSecret("lin_api_forgettable123");
    forgetSecrets();
    // The shape rule still applies — that one is not a registration.
    expect(redact("plain forgettable123 text")).toBe("plain forgettable123 text");
  });
});

describe("error messages are redacted at construction", () => {
  it("because an error object travels further than the log call", () => {
    rememberSecret("lin_api_travellingKey01");
    const error = queryFailed([{ message: "bad key lin_api_travellingKey01" }], 200);
    expect(error.message).not.toContain("travellingKey");
  });
});

describe("describeError", () => {
  it("handles anything a catch can receive", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("thrown string")).toBe("thrown string");
    expect(describeError(undefined)).toBe("Something went wrong.");
    expect(describeError({ weird: true })).toBe("Something went wrong.");
  });
});

describe("unwrapMutation", () => {
  it("treats success: false with no errors as a failure", () => {
    // HTTP 200, no GraphQL errors, nothing written — the classic silent
    // failure, and the one users report as "sometimes it just doesn't work".
    expect(() => unwrapMutation({ success: false }, "issue", "move that issue")).toThrow(
      /didn't move that issue/,
    );
  });

  it("treats a null entity as a failure too", () => {
    expect(() =>
      unwrapMutation({ success: true, issue: null }, "issue", "move that issue"),
    ).toThrow(/returned nothing/);
  });

  it("returns the entity when the payload means it", () => {
    expect(unwrapMutation({ success: true, issue: { id: "1" } }, "issue", "x")).toEqual({
      id: "1",
    });
  });
});

describe("mutationFailed", () => {
  it("is never retryable", () => {
    expect(mutationFailed("nope").retryable).toBe(false);
  });
});

describe("the retained GraphQL error array", () => {
  it("is redacted at construction, like the summary", () => {
    // A GraphQL validation error can echo the variables it rejected —
    // including a webhook signing secret sent as one — and `errors` is an
    // enumerable property a host could serialize into an rpc envelope.
    rememberSecret("lin_api_thisIsTheLiveKey00");
    const error = queryFailed(
      [
        {
          message: 'Variable "$input" got invalid value { secret: "lin_api_thisIsTheLiveKey00" }',
          extensions: { code: "BAD_USER_INPUT" },
        },
        { message: "authorization: lin_api_thisIsTheLiveKey00" },
      ],
      200,
    );
    for (const entry of error.errors) {
      expect(entry.message).not.toContain("thisIsTheLiveKey00");
      expect(entry.message).toContain("[redacted]");
    }
    // The extensions object is preserved for the code switch that reads it.
    expect(error.errors[0]!.extensions?.["code"]).toBe("BAD_USER_INPUT");
  });
});
