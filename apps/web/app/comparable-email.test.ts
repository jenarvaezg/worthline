import { describe, expect, test } from "vitest";

import { comparableEmail } from "./comparable-email";

describe("comparableEmail — the one comparable form of an address", () => {
  test("trims and lower-cases", () => {
    expect(comparableEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });

  test("a missing address is the empty string, which matches no real one", () => {
    expect(comparableEmail(null)).toBe("");
    expect(comparableEmail(undefined)).toBe("");
  });
});
