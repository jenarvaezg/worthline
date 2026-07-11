import { describe, expect, test } from "vitest";

import { buildLoginRedirectUrl, DEFAULT_APP_PATH, parseReturnTo } from "./return-to";

describe("parseReturnTo", () => {
  test("accepts internal paths", () => {
    expect(parseReturnTo("/app")).toBe("/app");
    expect(parseReturnTo("/patrimonio?scope=household")).toBe(
      "/patrimonio?scope=household",
    );
  });

  test("rejects absolute and protocol-relative URLs", () => {
    expect(parseReturnTo("https://evil.example.com/")).toBe(DEFAULT_APP_PATH);
    expect(parseReturnTo("//evil.example.com/")).toBe(DEFAULT_APP_PATH);
  });

  test("falls back when empty or whitespace", () => {
    expect(parseReturnTo("")).toBe(DEFAULT_APP_PATH);
    expect(parseReturnTo("   ")).toBe(DEFAULT_APP_PATH);
    expect(parseReturnTo(undefined)).toBe(DEFAULT_APP_PATH);
  });

  test("honours a custom fallback", () => {
    expect(parseReturnTo("https://evil.example.com/", "/ajustes")).toBe("/ajustes");
  });
});

describe("buildLoginRedirectUrl", () => {
  test("encodes the attempted path as returnTo", () => {
    const url = buildLoginRedirectUrl(
      "http://localhost:3000",
      "/patrimonio",
      "?scope=ana",
    );
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("returnTo")).toBe("/patrimonio?scope=ana");
  });

  test("sanitises hostile return paths", () => {
    const url = buildLoginRedirectUrl("http://localhost:3000", "//evil.com", "");
    expect(url.searchParams.get("returnTo")).toBe(DEFAULT_APP_PATH);
  });
});
