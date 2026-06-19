import { describe, expect, it } from "vitest";

import { DEMO_PERSONA_COOKIE_NAME, resolveDemoContext } from "@web/demo/demo-context";

describe("resolveDemoContext", () => {
  it("reports disabled when the DEMO flag is unset", () => {
    const ctx = resolveDemoContext({ demoNow: "2026-06-19T00:00:00.000Z" });
    expect(ctx.enabled).toBe(false);
  });

  it("reports disabled for falsey DEMO flag values", () => {
    for (const flag of ["", "0", "false", "off"]) {
      expect(resolveDemoContext({ demoFlag: flag }).enabled).toBe(false);
    }
  });

  it("is enabled when DEMO=1 and pins now to WORTHLINE_DEMO_NOW", () => {
    const ctx = resolveDemoContext({
      demoFlag: "1",
      demoNow: "2026-06-19T00:00:00.000Z",
      personaCookie: "inversor",
    });
    expect(ctx.enabled).toBe(true);
    expect(ctx.now).toBe("2026-06-19T00:00:00.000Z");
    expect(ctx.persona).toBe("inversor");
  });

  it("falls back to the familia persona when the cookie is absent or unknown", () => {
    expect(resolveDemoContext({ demoFlag: "1", demoNow: "2026-06-19" }).persona).toBe(
      "familia",
    );
    expect(
      resolveDemoContext({ demoFlag: "1", demoNow: "2026-06-19", personaCookie: "ghost" })
        .persona,
    ).toBe("familia");
  });

  it("exposes the persona cookie name (mirrors wl_scope)", () => {
    expect(DEMO_PERSONA_COOKIE_NAME).toBe("wl_demo_persona");
  });
});
