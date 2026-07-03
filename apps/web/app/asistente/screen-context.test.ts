import { describe, expect, it } from "vitest";

import { deriveScreenContext } from "./screen-context";

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
