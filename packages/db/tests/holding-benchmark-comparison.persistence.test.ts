import { createInMemoryControlPlaneStore, createInMemoryStore } from "@db/index";
import { holdingBenchmarkComparison, type InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function op(
  kind: "buy" | "sell",
  units: string,
  pricePerUnit: string,
  executedAt: string,
): InvestmentOperation {
  return {
    assetId: "asset_msci",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${kind}_${executedAt}`,
    kind,
    pricePerUnit,
    units,
  };
}

describe("holding benchmark comparison persistence", () => {
  test("compares a holding TWR against a catalog series from the control plane", async () => {
    const controlPlane = await createInMemoryControlPlaneStore();
    try {
      await controlPlane.upsertBenchmarkPrices("msci-world-tr", [
        { dateKey: "2024-01-01", value: "100" },
        { dateKey: "2024-03-01", value: "110" },
      ]);

      const benchmarkPrices = await controlPlane.readBenchmarkPrices("msci-world-tr");
      const result = holdingBenchmarkComparison({
        benchmarkPrices,
        distributing: false,
        monthlyCloses: [
          { date: "2024-01-31", valueMinor: 100_000_00 },
          { date: "2024-03-31", valueMinor: 130_000_00 },
        ],
        operations: [op("buy", "1000", "100", "2024-01-15")],
        trackedIndex: "MSCI World",
      });

      expect(result.comparison?.seriesId).toBe("msci-world-tr");
      expect(result.comparison?.trackedIndex).toBe("MSCI World");
      expect(result.comparison?.variant).toBe("total_return");
      expect(result.comparison?.benchmarkGrowth).toBeCloseTo(0.1);
      expect(result.comparison?.coverageNote).toContain("EUNL");
    } finally {
      controlPlane.close();
    }
  });

  test("persists the distributing flag on the investment asset", async () => {
    const store = await createInMemoryStore();
    try {
      await store.workspace.initializeWorkspace({
        members: [{ id: "member_1", name: "Ana" }],
        mode: "individual",
      });
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "asset_dist",
        instrument: "fund",
        name: "Distributing fund",
        ownership: [{ memberId: "member_1", shareBps: 10_000 }],
      });
      await store.assets.updateInvestmentAsset({
        benchmarkDistributing: true,
        id: "asset_dist",
        name: "Distributing fund",
      });

      const meta = await store.assets.readInvestmentAssetsWithMeta();
      expect(meta.find((asset) => asset.id === "asset_dist")?.benchmarkDistributing).toBe(
        true,
      );
    } finally {
      store.close();
    }
  });
});
