import { describe, expect, it } from "vitest";

import type { ScreenContext } from "./screen-context";
import { suggestedPrompts } from "./suggested-prompts";

function ctx(section: ScreenContext["section"]): ScreenContext {
  return { route: `/${section}`, section, holdingId: null, view: {} };
}

function ctxWithView(
  section: ScreenContext["section"],
  view: ScreenContext["view"],
): ScreenContext {
  return { route: `/${section}`, section, holdingId: null, view };
}

/**
 * Assert by stable prompt id, never by the user-facing string (#632): the
 * copy is free to change, the screen→prompt mapping is the contract.
 */
function ids(context: ScreenContext | null): string[] {
  return suggestedPrompts(context).map((p) => p.id);
}

describe("suggestedPrompts", () => {
  it("surfaces patrimonio prompts on patrimonio: imbalance, stale, concentration", () => {
    expect(ids(ctx("patrimonio"))).toEqual([
      "patrimonio-imbalance",
      "patrimonio-stale",
      "patrimonio-concentration",
    ]);
  });

  it("offers agent-fill first on the patrimonio exposure surface (#707)", () => {
    expect(ids(ctxWithView("patrimonio", { exp: "geography" }))).toEqual([
      "patrimonio-fill-exposure",
      "patrimonio-imbalance",
      "patrimonio-stale",
      "patrimonio-concentration",
    ]);
  });

  it("surfaces histórico prompts on historico: changes and outliers", () => {
    expect(ids(ctx("historico"))).toEqual(["historico-changes", "historico-outliers"]);
  });

  it("surfaces objetivos/FIRE lever prompts on objetivos", () => {
    expect(ids(ctx("objetivos"))).toEqual([
      "objetivos-contributions",
      "objetivos-eligible",
      "objetivos-assumptions",
    ]);
  });

  it("falls back to the default set on other sections", () => {
    for (const section of ["resumen", "ajustes", "otra"] as const) {
      expect(ids(ctx(section))).toEqual(["default-position", "default-liquidity"]);
    }
  });

  it("falls back to the default set when there is no screen context", () => {
    expect(ids(null)).toEqual(["default-position", "default-liquidity"]);
  });

  it("gives every prompt a non-empty label and prompt text", () => {
    for (const section of ["patrimonio", "historico", "objetivos", "resumen"] as const) {
      for (const p of suggestedPrompts(ctx(section))) {
        expect(p.label.trim().length).toBeGreaterThan(0);
        expect(p.prompt.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
