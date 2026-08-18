import { describe, expect, it } from "vitest";

import { fireAchievement } from "./fire-achievement";
import type { SavingsCoherence } from "./savings-coherence";

function coherence(overrides: Partial<SavingsCoherence> = {}): SavingsCoherence {
  return {
    declaredMinor: 100_000,
    gapMinor: 0,
    measured: {
      amountMinor: 100_000,
      basis: "operations",
      monthsCovered: 12,
      netMinor: 1_200_000,
      operationsCount: 12,
      skippedForeignCount: 0,
      windowEndMonthKey: "2026-08",
      windowStartMonthKey: "2025-09",
    },
    measuredMinor: 100_000,
    state: "aligned",
    vetoesAchievement: false,
    ...overrides,
  };
}

describe("fireAchievement (#1449)", () => {
  it("shows no badge below Coast FIRE", () => {
    expect(fireAchievement({ percentFunded: 42 })).toEqual({
      level: null,
      measuredMonthlySavingsMinor: null,
      measuredMonths: null,
      vetoed: false,
    });
  });

  it("prefers the FIRE badge over Coast when both hold", () => {
    expect(
      fireAchievement({ percentFunded: 100, isAlreadyAtCoastFire: true }),
    ).toMatchObject({ level: "fire", vetoed: false });
  });

  it("shows Coast FIRE when funded falls short", () => {
    expect(
      fireAchievement({ percentFunded: 60, isAlreadyAtCoastFire: true }),
    ).toMatchObject({ level: "coast", vetoed: false });
  });

  it("keeps the badge when the measured savings hold up", () => {
    expect(
      fireAchievement({
        coherence: coherence(),
        isAlreadyAtCoastFire: true,
        percentFunded: 60,
      }),
    ).toMatchObject({ level: "coast", vetoed: false });
  });

  it("vetoes the badge when the measured trajectory goes down", () => {
    const veto = coherence({
      measured: { ...coherence().measured, amountMinor: -10_000 },
      measuredMinor: -10_000,
      state: "diverged",
      vetoesAchievement: true,
    });

    expect(
      fireAchievement({
        coherence: veto,
        isAlreadyAtCoastFire: true,
        percentFunded: 104,
      }),
    ).toEqual({
      level: "fire",
      measuredMonthlySavingsMinor: -10_000,
      measuredMonths: 12,
      vetoed: true,
    });
  });

  it("has nothing to veto when there is no badge", () => {
    const veto = coherence({ measuredMinor: -10_000, vetoesAchievement: true });

    expect(fireAchievement({ coherence: veto, percentFunded: 20 })).toMatchObject({
      level: null,
      vetoed: false,
    });
  });
});
