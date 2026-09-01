import { describe, expect, test } from "vitest";

import { altaStepLabel, altaSteps } from "./alta-steps";

describe("alta steps (#1732)", () => {
  test("a single-member workspace has two stretches — there is no reparto to number", () => {
    expect(altaSteps(1).map(altaStepLabel)).toEqual([
      "Paso 1 de 2 · Elige el cajón",
      "Paso 2 de 2 · Rellena lo justo",
    ]);
  });

  test("with more than one member the reparto is the third and last", () => {
    expect(altaSteps(2).map(altaStepLabel)).toEqual([
      "Paso 1 de 3 · Elige el cajón",
      "Paso 2 de 3 · Rellena lo justo",
      "Paso 3 de 3 · Reparto",
    ]);
  });

  test("every stretch declares the same total — a step never counts a different set", () => {
    for (const memberCount of [1, 2, 5]) {
      const steps = altaSteps(memberCount);
      expect(new Set(steps.map((step) => step.total))).toEqual(new Set([steps.length]));
    }
  });
});
