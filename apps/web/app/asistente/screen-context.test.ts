import { describe, expect, it } from "vitest";

import { deriveScreenContext, isScreenContext } from "./screen-context";

describe("deriveScreenContext", () => {
  it("maps the dashboard root to resumen", () => {
    expect(deriveScreenContext("/", "")).toEqual({
      route: "/",
      section: "resumen",
      holdingId: null,
      view: {},
    });
  });

  it("extracts the holding id from a patrimonio drilldown", () => {
    const ctx = deriveScreenContext("/patrimonio/wl_hld_abc", "");
    expect(ctx.section).toBe("patrimonio");
    expect(ctx.holdingId).toBe("wl_hld_abc");
  });

  it("captures only known URL-mirrored view params", () => {
    const ctx = deriveScreenContext("/", "?view=liquid&range=3y&utm_source=x");
    expect(ctx.view).toEqual({ view: "liquid", range: "3y" });
  });

  it("classifies unknown routes as otra without a holding id", () => {
    const ctx = deriveScreenContext("/ajustes/algo", "");
    expect(ctx.section).toBe("ajustes");
    expect(ctx.holdingId).toBeNull();

    expect(deriveScreenContext("/login", "").section).toBe("otra");
  });
});

describe("isScreenContext (boundary guard)", () => {
  const valid = deriveScreenContext("/patrimonio", "?view=liquid");

  it("accepts a derived context round-tripped through JSON", () => {
    expect(isScreenContext(JSON.parse(JSON.stringify(valid)))).toBe(true);
  });

  it("rejects wrong shapes", () => {
    expect(isScreenContext(null)).toBe(false);
    expect(isScreenContext({ ...valid, section: "hacked" })).toBe(false);
    expect(isScreenContext({ ...valid, view: { a: 1 } })).toBe(false);
  });

  it("rejects oversized payloads so they cannot bloat the system prompt", () => {
    expect(isScreenContext({ ...valid, view: { view: "x".repeat(10_000) } })).toBe(false);
    const manyKeys = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(isScreenContext({ ...valid, view: manyKeys })).toBe(false);
    expect(isScreenContext({ ...valid, holdingId: "h".repeat(10_000) })).toBe(false);
  });
});
