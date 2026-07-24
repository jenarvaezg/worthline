import { describe, expect, it } from "vitest";

import {
  deriveScreenContext,
  isAssistantSurface,
  isOnboardingSurface,
  isScreenContext,
  ONBOARDING_PATH,
  ONBOARDING_RERUN_PARAM,
  onboardingModeForContext,
} from "./screen-context";

describe("isAssistantSurface", () => {
  it("excludes the public landing", () => {
    expect(isAssistantSurface("/")).toBe(false);
  });

  it("allows workspace routes", () => {
    expect(isAssistantSurface("/app")).toBe(true);
    expect(isAssistantSurface("/patrimonio")).toBe(true);
  });

  it("allows the onboarding route — it IS the assistant in full-screen mode", () => {
    expect(isAssistantSurface(ONBOARDING_PATH)).toBe(true);
  });
});

describe("isOnboardingSurface", () => {
  it("matches only the dedicated onboarding route", () => {
    expect(isOnboardingSurface(ONBOARDING_PATH)).toBe(true);
    expect(isOnboardingSurface("/bienvenida")).toBe(true);
  });

  it("rejects every other surface", () => {
    expect(isOnboardingSurface("/")).toBe(false);
    expect(isOnboardingSurface("/app")).toBe(false);
    expect(isOnboardingSurface("/patrimonio")).toBe(false);
    expect(isOnboardingSurface("/bienvenida/extra")).toBe(false);
  });
});

describe("onboardingModeForContext (#1169/#1170)", () => {
  it("resolves first-run on the dedicated onboarding surface", () => {
    expect(onboardingModeForContext(deriveScreenContext(ONBOARDING_PATH, ""))).toBe(
      "first-run",
    );
  });

  it("resolves re-run when the repasar flag is set off the onboarding surface", () => {
    const ctx = deriveScreenContext("/patrimonio", `?${ONBOARDING_RERUN_PARAM}=1`);
    expect(onboardingModeForContext(ctx)).toBe("re-run");
  });

  it("is null on an ordinary surface without the flag", () => {
    expect(onboardingModeForContext(deriveScreenContext("/patrimonio", ""))).toBeNull();
    expect(onboardingModeForContext(deriveScreenContext("/app", ""))).toBeNull();
  });

  it("ignores a non-matching flag value", () => {
    const ctx = deriveScreenContext("/patrimonio", `?${ONBOARDING_RERUN_PARAM}=0`);
    expect(onboardingModeForContext(ctx)).toBeNull();
  });
});

describe("deriveScreenContext", () => {
  it("maps the dashboard to resumen", () => {
    expect(deriveScreenContext("/app", "")).toEqual({
      route: "/app",
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
    const ctx = deriveScreenContext("/app", "?view=liquid&range=3y&utm_source=x");
    expect(ctx.view).toEqual({ view: "liquid", range: "3y" });
  });

  it("captures the onboarding re-run flag (#1170)", () => {
    const ctx = deriveScreenContext("/patrimonio", `?${ONBOARDING_RERUN_PARAM}=1`);
    expect(ctx.view[ONBOARDING_RERUN_PARAM]).toBe("1");
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
