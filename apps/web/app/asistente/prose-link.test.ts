import { describe, expect, test } from "vitest";

import { internalProseLinkHref } from "./prose-link";

/**
 * #1289: the prose may link to worthline and to nowhere else.
 */
describe("internal links in the assistant's prose (#1289)", () => {
  test.each([
    "/patrimonio",
    "/patrimonio/debt_x/editar",
    "/historico?scope=hogar",
    "/objetivos#fire",
    "/",
  ])("keeps an internal route clickable: %s", (href) => {
    expect(internalProseLinkHref(href)).toBe(href);
  });

  test.each([
    { label: "protocol-relative", href: "//evil.tld/x" },
    { label: "backslash authority", href: "/\\evil.tld" },
    { label: "absolute http", href: "http://evil.tld" },
    {
      label: "absolute https, even our own host",
      href: "https://worthline.app/patrimonio",
    },
    { label: "javascript", href: "javascript:alert(1)" },
    { label: "data", href: "data:text/html,<script>alert(1)</script>" },
    { label: "mailto", href: "mailto:jose@example.com" },
    { label: "tel", href: "tel:+34600000000" },
    { label: "bare relative", href: "patrimonio" },
    { label: "empty", href: "" },
  ])("refuses to link $label", ({ href }) => {
    expect(internalProseLinkHref(href)).toBeNull();
  });

  test("refuses a missing href", () => {
    expect(internalProseLinkHref(undefined)).toBeNull();
  });

  /**
   * The URL parser deletes tabs and newlines before resolving, so a raw-string check
   * would read `/<tab>/evil.tld` as an internal path and hand the browser
   * `//evil.tld` — the exact bypass this cleaning exists for.
   */
  test.each([
    "/\t/evil.tld",
    "/\n/evil.tld",
    "/\r/evil.tld",
  ])("cleans what the URL parser would clean before deciding: %j", (href) => {
    expect(internalProseLinkHref(href)).toBeNull();
  });

  test("trims surrounding whitespace before deciding", () => {
    expect(internalProseLinkHref("  //evil.tld  ")).toBeNull();
    expect(internalProseLinkHref("  /patrimonio  ")).toBe("/patrimonio");
  });

  test("navigates to the cleaned path, never the raw string", () => {
    expect(internalProseLinkHref("/patri\tmonio")).toBe("/patrimonio");
  });
});
