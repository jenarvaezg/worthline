import type { AgentViewReadStore } from "@worthline/db";
import type { AssetClassResolution, InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { buildPortfolioReturns } from "./returns";

/**
 * Regression test for the per-asset-class block on the agent-view path (#552):
 * for a CO-OWNED market holding, the class-level simple gain / IRR must be on the
 * SAME ownership-scoped basis as the portfolio block — i.e. the operation
 * cashflows are scaled by `totalShareBps` before the class weight, so they pair
 * with the scoped `currentValueMinor` (ownedMinor). Without the scaling the class
 * combined gross cost with a scoped value and fabricated a large loss.
 */

function buy(
  assetId: string,
  units: string,
  price: string,
  at: string,
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt: at,
    feesMinor: 0,
    id: `op_${assetId}_${at}`,
    kind: "buy",
    pricePerUnit: price,
    units,
  };
}

const equityClass: AssetClassResolution = {
  breakdown: { equity: "1" },
  kind: "classified",
};

function fakeStore(
  operationsById: Record<string, InvestmentOperation[]>,
): AgentViewReadStore {
  return {
    readOperations: async (assetId: string) => operationsById[assetId] ?? [],
    readSnapshotHoldings: async () => [],
  } as unknown as AgentViewReadStore;
}

describe("buildPortfolioReturns byAssetClass", () => {
  test("scales a co-owned holding's operations to its share, matching the scoped value", async () => {
    // Gross: bought 10 units @100 = 100_000 invested; now worth 100_000 gross.
    // 50% owned → scoped value 50_000. The equity class must read break-even, not
    // 100_000 invested against 50_000 value.
    const returns = await buildPortfolioReturns({
      currency: "EUR",
      holdings: [
        {
          assetClass: equityClass,
          currentValueMinor: 50_000, // scoped ownedMinor
          id: "h1",
          instrument: "fund",
          totalShareBps: 5_000,
        },
      ],
      scopeId: "household",
      store: fakeStore({ h1: [buy("h1", "10", "100", "2024-01-01")] }),
      valuationDate: "2024-06-01",
    });

    expect(returns).not.toBeNull();
    const equity = returns!.byAssetClass?.classes.find((c) => c.key === "equity");
    expect(equity).toBeDefined();
    expect(equity!.simple.totalInvested).toEqual({
      amountMinor: 50_000,
      currency: "EUR",
    });
    expect(equity!.simple.totalGain).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(equity!.simple.totalReturnRatio).toBe("0");
    // byAssetClass value reconciles with the scoped portfolio value.
    expect(equity!.value).toEqual({ amountMinor: 50_000, currency: "EUR" });
    expect(returns!.byAssetClass?.coverage.classified.amountMinor).toBe(50_000);
  });

  test("omits byAssetClass when no holding carries a resolved class", async () => {
    const returns = await buildPortfolioReturns({
      currency: "EUR",
      holdings: [
        {
          currentValueMinor: 50_000,
          id: "h1",
          instrument: "fund",
          totalShareBps: 10_000,
        },
      ],
      scopeId: "household",
      store: fakeStore({ h1: [buy("h1", "10", "100", "2024-01-01")] }),
      valuationDate: "2024-06-01",
    });

    expect(returns).not.toBeNull();
    expect(returns!.byAssetClass).toBeUndefined();
  });
});
