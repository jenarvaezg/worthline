import { describe, expect, test } from "vitest";

import { holdingTrashImpact } from "./holding-trash-impact";
import type { PositionSummary } from "./investment-types";

function position(overrides: Partial<PositionSummary> = {}): PositionSummary {
  return {
    assetId: "asset_fondo",
    averageUnitCost: "10",
    costBasis: { amountMinor: 1_000_00, currency: "EUR" },
    currency: "EUR",
    currentUnits: "100",
    realizedPnl: { amountMinor: 0, currency: "EUR" },
    warnings: [],
    ...overrides,
  };
}

describe("holdingTrashImpact — friction only where there is money inside (#1365)", () => {
  test("a position with live units reports the value the trash would withdraw", () => {
    const impact = holdingTrashImpact(
      position({
        currentUnits: "120.5",
        marketValue: { amountMinor: 4_320_15, currency: "EUR" },
      }),
    );

    expect(impact).toEqual({
      basis: "market",
      netUnits: "120.5",
      value: { amountMinor: 4_320_15, currency: "EUR" },
    });
  });

  test("a fully-sold position moves nothing, so there is no impact to name", () => {
    expect(
      holdingTrashImpact(
        position({
          currentUnits: "0",
          marketValue: { amountMinor: 0, currency: "EUR" },
        }),
      ),
    ).toBeNull();
  });

  test("sub-unit dust from an imported closing sell still reads as closed", () => {
    // The same threshold as the closed-position filter (#1348): a statement whose
    // closing sell is rounded to fewer decimals than the buys it closes leaves
    // dust that is a closed position in every sense the user cares about.
    expect(holdingTrashImpact(position({ currentUnits: "0.00001" }))).toBeNull();
    expect(holdingTrashImpact(position({ currentUnits: "0.001" }))).not.toBeNull();
  });

  test("a holding with no position at all keeps the reassuring copy", () => {
    expect(holdingTrashImpact(null)).toBeNull();
    expect(holdingTrashImpact(undefined)).toBeNull();
  });

  test("an unpriced position falls back to its cost basis and says so", () => {
    // A zero here would tell the user the trash costs nothing exactly when the
    // app cannot price what it is about to drop (#1314).
    const impact = holdingTrashImpact(
      position({ costBasis: { amountMinor: 7_500_00, currency: "EUR" } }),
    );

    expect(impact).toEqual({
      basis: "cost",
      netUnits: "100",
      value: { amountMinor: 7_500_00, currency: "EUR" },
    });
  });
});
