import { describe, expect, it } from "vitest";
import { safeHref } from "../app/href.js";

describe("safeHref", () => {
  it("passes http and https through", () => {
    expect(safeHref("https://linear.app/acme/issue/ENG-1")).toBe("https://linear.app/acme/issue/ENG-1");
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });

  it("drops a javascript: URL to no link at all", () => {
    // React does not sanitize href; a hostile mirror row could otherwise plant
    // script that runs on click.
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeHref("  javascript:alert(1)")).toBeUndefined();
  });

  it("treats null and undefined as no link", () => {
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });
});
