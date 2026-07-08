import type { NetWorthSnapshot } from "@worthline/domain";
import { compareGrowthToBenchmark } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryControlPlaneStore, createInMemoryStore } from "@db/index";

const eur = (amountMinor: number): NetWorthSnapshot["totalNetWorth"] => ({
  amountMinor,
  currency: "EUR",
});

function snapshot(dateKey: string, amountMinor: number): NetWorthSnapshot {
  return {
    capturedAt: `${dateKey}T20:00:00.000Z`,
    dateKey,
    debts: eur(0),
    grossAssets: eur(amountMinor),
    housingEquity: eur(0),
    id: `snap_${dateKey}`,
    isMonthlyClose: false,
    liquidNetWorth: eur(amountMinor),
    monthKey: dateKey.slice(0, 7),
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: eur(amountMinor),
    warnings: [],
  };
}

describe("benchmark comparison persistence", () => {
  test("compares workspace snapshots with CPI read from the control plane", async () => {
    const store = await createInMemoryStore();
    const controlPlane = await createInMemoryControlPlaneStore();
    try {
      await store.snapshots.saveSnapshot({
        snapshot: snapshot("2024-01-31", 100_000_00),
      });
      await store.snapshots.saveSnapshot({
        snapshot: snapshot("2024-03-31", 130_000_00),
      });
      await controlPlane.upsertBenchmarkPrices("ipc-es", [
        { dateKey: "2024-01-01", value: "100" },
        { dateKey: "2024-03-01", value: "110" },
      ]);

      const snapshots = await store.snapshots.readSnapshots("household");
      const cpi = await controlPlane.readBenchmarkPrices("ipc-es");
      const result = compareGrowthToBenchmark({
        benchmark: cpi.map((point) => ({
          dateKey: point.dateKey,
          value: Number(point.value),
        })),
        subject: snapshots.map((point) => ({
          dateKey: point.dateKey,
          value: point.totalNetWorth.amountMinor,
        })),
      });

      expect(result.comparison?.subjectGrowth).toBeCloseTo(0.3);
      expect(result.comparison?.benchmarkGrowth).toBeCloseTo(0.1);
      expect(result.comparison?.realGrowth).toBeCloseTo(0.18181818181818182);
    } finally {
      store.close();
      controlPlane.close();
    }
  });
});
