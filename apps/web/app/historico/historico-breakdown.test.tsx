/**
 * /historico "Origen del cambio" wiring (#660): seeded snapshots + payouts
 * produce three bands where payouts exist and two elsewhere.
 */

import type { SnapshotHoldingRecord } from "@worthline/db";
import type {
  ManualAsset,
  NetWorthSnapshot,
  Payout,
  PayoutSchedule,
} from "@worthline/domain";
import { createManualAsset, createWorkspace } from "@worthline/domain";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { buildHistoricoBreakdownView } from "./build-historico-breakdown";
import HistoricoBreakdown from "./historico-breakdown";

function snapshot(dateKey: string, totalMinor: number): NetWorthSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" as const });
  return {
    capturedAt: `${dateKey}T10:00:00.000Z`,
    dateKey,
    debts: money(0),
    grossAssets: money(totalMinor),
    housingEquity: money(0),
    id: `snap_${dateKey}`,
    isMonthlyClose: false,
    liquidNetWorth: money(totalMinor),
    monthKey: dateKey.slice(0, 7),
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: money(totalMinor),
    warnings: [],
  };
}

function holdingRow(
  snapshotId: string,
  dateKey: string,
  holdingId: string,
  valueMinor: number,
): SnapshotHoldingRecord {
  return {
    capturedAt: `${dateKey}T10:00:00.000Z`,
    countsAsHousing: false,
    dateKey,
    holdingId,
    kind: "asset",
    label: holdingId,
    liquidityTier: "cash",
    scopeId: "household",
    securesHousing: false,
    snapshotId,
    valueMinor,
  };
}

function cashAsset(
  workspace: ReturnType<typeof createWorkspace>,
  id: string,
): ManualAsset {
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 0,
    id,
    liquidityTier: "cash",
    name: id,
    ownership: [{ memberId: "member_a", shareBps: 10_000 }],
    type: "cash",
    instrument: "current_account",
  });
}

function rentAsset(
  workspace: ReturnType<typeof createWorkspace>,
  id: string,
): ManualAsset {
  return createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 200_000_00,
    id,
    instrument: "property",
    liquidityTier: "housing",
    name: id,
    ownership: [{ memberId: "member_a", shareBps: 10_000 }],
    type: "real_estate",
  });
}

describe("buildHistoricoBreakdownView", () => {
  const workspace = createWorkspace({
    baseCurrency: "EUR",
    members: [{ id: "member_a", name: "Ana" }],
    mode: "individual",
  });

  test("three bands when payouts exist in a month, two when they do not", () => {
    const jan = snapshot("2026-01-31", 100_000_00);
    const feb = snapshot("2026-02-28", 101_000_00);
    const mar = snapshot("2026-03-31", 100_500_00);

    const payoutRecords: Payout[] = [
      {
        amountMinor: 1_000_00,
        dateISO: "2026-02-15",
        holdingId: "asset_rent",
        id: "payout_feb",
      },
    ];

    const view = buildHistoricoBreakdownView({
      assets: [cashAsset(workspace, "asset_cash"), rentAsset(workspace, "asset_rent")],
      holdingRecords: [
        holdingRow(jan.id, jan.dateKey, "asset_cash", 100_000_00),
        holdingRow(feb.id, feb.dateKey, "asset_cash", 101_000_00),
        holdingRow(mar.id, mar.dateKey, "asset_cash", 100_500_00),
      ],
      liabilities: [],
      debtModelByLiabilityId: new Map(),
      operationsByHoldingId: new Map(),
      payoutRecords,
      payoutSchedules: [] as PayoutSchedule[],
      scopeId: "household",
      snapshots: [jan, feb, mar],
      today: "2026-04-10",
      workspace,
    });

    expect(view.showsPayoutBand).toBe(true);
    expect(view.periods[0]?.bands?.payoutsMinor).toBe(1_000_00);
    expect(view.periods[1]?.bands?.payoutsMinor).toBe(0);
    expect(view.geometry?.bands.map((band) => band.band)).toEqual([
      "market",
      "payouts",
      "netSavings",
    ]);
  });

  test("two bands when no payouts exist anywhere", () => {
    const jan = snapshot("2026-01-31", 100_000_00);
    const feb = snapshot("2026-02-28", 102_000_00);
    const mar = snapshot("2026-03-31", 103_000_00);

    const view = buildHistoricoBreakdownView({
      assets: [cashAsset(workspace, "asset_cash")],
      holdingRecords: [
        holdingRow(jan.id, jan.dateKey, "asset_cash", 100_000_00),
        holdingRow(feb.id, feb.dateKey, "asset_cash", 102_000_00),
        holdingRow(mar.id, mar.dateKey, "asset_cash", 103_000_00),
      ],
      liabilities: [],
      debtModelByLiabilityId: new Map(),
      operationsByHoldingId: new Map(),
      payoutRecords: [],
      payoutSchedules: [],
      scopeId: "household",
      snapshots: [jan, feb, mar],
      today: "2026-04-10",
      workspace,
    });

    expect(view.showsPayoutBand).toBe(false);
    expect(view.geometry?.bands.map((band) => band.band)).toEqual([
      "market",
      "netSavings",
    ]);
  });

  test("chart geometry omits gap months and only plots computable closes", () => {
    const jan = snapshot("2026-01-31", 100_000_00);
    const feb = snapshot("2026-02-28", 101_000_00);
    const mar = snapshot("2026-03-31", 102_000_00);
    const apr = snapshot("2026-04-30", 103_000_00);
    const may = snapshot("2026-05-31", 104_000_00);

    const view = buildHistoricoBreakdownView({
      assets: [cashAsset(workspace, "asset_cash")],
      holdingRecords: [
        holdingRow(jan.id, jan.dateKey, "asset_cash", 100_000_00),
        // February close has no frozen rows — gaps on both windows that touch it.
        holdingRow(mar.id, mar.dateKey, "asset_cash", 102_000_00),
        holdingRow(apr.id, apr.dateKey, "asset_cash", 103_000_00),
        holdingRow(may.id, may.dateKey, "asset_cash", 104_000_00),
      ],
      liabilities: [],
      debtModelByLiabilityId: new Map(),
      operationsByHoldingId: new Map(),
      payoutRecords: [],
      payoutSchedules: [],
      scopeId: "household",
      snapshots: [jan, feb, mar, apr, may],
      today: "2026-06-10",
      workspace,
    });

    expect(view.periods.filter((period) => period.bands === null)).toHaveLength(2);
    expect(view.periods.filter((period) => period.bands !== null)).toHaveLength(2);
    // Only the two computable windows after the gap feed the stacked chart.
    expect(view.geometry?.bands[0]?.bars).toHaveLength(2);
  });
});

describe("HistoricoBreakdown render", () => {
  test("renders cobros in the legend when payouts exist", () => {
    const jan = snapshot("2026-01-31", 100_000_00);
    const feb = snapshot("2026-02-28", 101_000_00);
    const mar = snapshot("2026-03-31", 101_000_00);
    const workspace = createWorkspace({
      baseCurrency: "EUR",
      members: [{ id: "member_a", name: "Ana" }],
      mode: "individual",
    });

    const view = buildHistoricoBreakdownView({
      assets: [cashAsset(workspace, "asset_cash"), rentAsset(workspace, "asset_rent")],
      holdingRecords: [
        holdingRow(jan.id, jan.dateKey, "asset_cash", 100_000_00),
        holdingRow(feb.id, feb.dateKey, "asset_cash", 101_000_00),
        holdingRow(mar.id, mar.dateKey, "asset_cash", 101_000_00),
      ],
      liabilities: [],
      debtModelByLiabilityId: new Map(),
      operationsByHoldingId: new Map(),
      payoutRecords: [
        {
          amountMinor: 500_00,
          dateISO: "2026-02-10",
          holdingId: "asset_rent",
          id: "p1",
        },
      ],
      payoutSchedules: [],
      scopeId: "household",
      snapshots: [jan, feb, mar],
      today: "2026-04-10",
      workspace,
    });

    const html = renderToStaticMarkup(<HistoricoBreakdown breakdown={view} />);
    expect(html).toContain("Origen del cambio");
    expect(html).toContain("Cobros");
    expect(html).toContain("Mercado");
    expect(html).toContain("Ahorro neto");
    expect(html).toContain("historicoBreakdownBand--payouts");
  });

  test("omits cobros from the legend when no payouts exist", () => {
    const jan = snapshot("2026-01-31", 100_000_00);
    const feb = snapshot("2026-02-28", 101_000_00);
    const mar = snapshot("2026-03-31", 102_000_00);
    const workspace = createWorkspace({
      baseCurrency: "EUR",
      members: [{ id: "member_a", name: "Ana" }],
      mode: "individual",
    });

    const view = buildHistoricoBreakdownView({
      assets: [cashAsset(workspace, "asset_cash")],
      holdingRecords: [
        holdingRow(jan.id, jan.dateKey, "asset_cash", 100_000_00),
        holdingRow(feb.id, feb.dateKey, "asset_cash", 101_000_00),
        holdingRow(mar.id, mar.dateKey, "asset_cash", 102_000_00),
      ],
      liabilities: [],
      debtModelByLiabilityId: new Map(),
      operationsByHoldingId: new Map(),
      payoutRecords: [],
      payoutSchedules: [],
      scopeId: "household",
      snapshots: [jan, feb, mar],
      today: "2026-04-10",
      workspace,
    });

    const html = renderToStaticMarkup(<HistoricoBreakdown breakdown={view} />);
    expect(html).not.toContain("Cobros");
    expect(html).toContain("Mercado");
    expect(html).toContain("Ahorro neto");
    expect(html).toContain("historicoBreakdownLimits");
    expect(html).toContain("El ahorro neto es el residual");
  });
});
