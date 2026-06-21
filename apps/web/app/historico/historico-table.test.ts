/**
 * Histórico drill rows (#270, ADR 0035). `buildHistoricoRows` assembles the
 * newest-first rows: each day's aggregate Δ and its per-holding movers. For a
 * connected-source holding that froze a per-position breakdown, a mover also
 * carries its per-coin movers — the second drilldown level — derived from the two
 * days' frozen position rows.
 */
import type { NetWorthSnapshot, SnapshotPositionRow } from "@worthline/domain";
import type { SnapshotHoldingRecord } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { buildHistoricoRows, HistoricoTable } from "./historico-table";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

function snapshot(dateKey: string, totalMinor: number): NetWorthSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" });
  return {
    capturedAt: `${dateKey}T10:00:00.000Z`,
    dateKey,
    debts: money(0),
    grossAssets: money(totalMinor),
    housingEquity: money(0),
    id: `snap_${dateKey}`,
    isMonthlyClose: false,
    liquidNetWorth: money(0),
    monthKey: dateKey.slice(0, 7),
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: money(totalMinor),
    warnings: [],
  };
}

function coinHolding(
  dateKey: string,
  valueMinor: number,
  positions: SnapshotPositionRow[],
): SnapshotHoldingRecord {
  return {
    capturedAt: `${dateKey}T10:00:00.000Z`,
    countsAsHousing: false,
    dateKey,
    holdingId: "asset_coins",
    kind: "asset",
    label: "Colección Numista",
    liquidityTier: "illiquid",
    positions,
    scopeId: "household",
    securesHousing: false,
    snapshotId: `snap_${dateKey}`,
    valueMinor,
  };
}

describe("buildHistoricoRows — per-coin second drilldown level (ADR 0035)", () => {
  test("a connected holding's mover carries its per-coin movers, signed and sorted", () => {
    const day1 = coinHolding("2026-06-10", 4_000_00, [
      {
        positionKey: "sovereign",
        label: "Sovereign",
        valueMinor: 3_000_00,
        metal: "gold",
        imageUrl: "https://numista.test/s.jpg",
      },
      {
        positionKey: "maple",
        label: "Maple",
        valueMinor: 1_000_00,
        metal: "silver",
        imageUrl: null,
      },
    ]);
    const day2 = coinHolding("2026-06-11", 4_191_00, [
      {
        positionKey: "sovereign",
        label: "Sovereign",
        valueMinor: 3_141_00,
        metal: "gold",
        imageUrl: "https://numista.test/s.jpg",
      },
      {
        positionKey: "maple",
        label: "Maple",
        valueMinor: 1_000_00,
        metal: "silver",
        imageUrl: null,
      },
      {
        positionKey: "krug",
        label: "Krugerrand",
        valueMinor: 50_00,
        metal: "gold",
        imageUrl: null,
      },
    ]);

    const rows = buildHistoricoRows(
      [snapshot("2026-06-10", 4_000_00), snapshot("2026-06-11", 4_191_00)],
      [day1, day2],
      "2026-06-11",
    );

    // Newest first: 2026-06-11 with the coin holding's +191,00 € move.
    const latest = rows[0]!;
    const coinMover = latest.movers.find((m) => m.holdingId === "asset_coins");
    expect(coinMover?.contributionMinor).toBe(191_00);
    // Its second level attributes the change: Sovereign +141, Krugerrand +50 (new),
    // Maple omitted (unchanged), sorted by magnitude.
    expect(coinMover?.positions).toEqual([
      {
        positionKey: "sovereign",
        label: "Sovereign",
        metal: "gold",
        imageUrl: "https://numista.test/s.jpg",
        contributionMinor: 141_00,
        status: "changed",
      },
      {
        positionKey: "krug",
        label: "Krugerrand",
        metal: "gold",
        imageUrl: null,
        contributionMinor: 50_00,
        status: "new",
      },
    ]);
  });

  test("omits a per-position mover whose contribution rounds to 0 € (#477)", () => {
    // Sovereign creeps +0,30 € (30 minor → displays as "0 €"); Maple really moves
    // +100 €. The histórico shows whole euros, so a sub-€ slice is noise and must
    // not clutter the breakdown — a position that "did not change" should not show.
    const day1 = coinHolding("2026-06-10", 4_000_00, [
      {
        positionKey: "sovereign",
        label: "Sovereign",
        valueMinor: 3_000_00,
        metal: "gold",
        imageUrl: null,
      },
      {
        positionKey: "maple",
        label: "Maple",
        valueMinor: 1_000_00,
        metal: "silver",
        imageUrl: null,
      },
    ]);
    const day2 = coinHolding("2026-06-11", 4_100_30, [
      {
        positionKey: "sovereign",
        label: "Sovereign",
        valueMinor: 3_000_30,
        metal: "gold",
        imageUrl: null,
      },
      {
        positionKey: "maple",
        label: "Maple",
        valueMinor: 1_100_00,
        metal: "silver",
        imageUrl: null,
      },
    ]);

    const rows = buildHistoricoRows(
      [snapshot("2026-06-10", 4_000_00), snapshot("2026-06-11", 4_100_30)],
      [day1, day2],
      "2026-06-11",
    );

    const coinMover = rows[0]!.movers.find((m) => m.holdingId === "asset_coins");
    // Only Maple survives; Sovereign's +0,30 € rounds to "0 €" and is hidden.
    expect(coinMover?.positions?.map((p) => p.positionKey)).toEqual(["maple"]);
  });

  test("masks money values when privacy mode is on", () => {
    const plain = (dateKey: string, valueMinor: number): SnapshotHoldingRecord => ({
      capturedAt: `${dateKey}T10:00:00.000Z`,
      countsAsHousing: false,
      dateKey,
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      scopeId: "household",
      securesHousing: false,
      snapshotId: `snap_${dateKey}`,
      valueMinor,
    });

    const rows = buildHistoricoRows(
      [snapshot("2026-06-10", 1_000_00), snapshot("2026-06-11", 1_500_00)],
      [plain("2026-06-10", 1_000_00), plain("2026-06-11", 1_500_00)],
      "2026-06-11",
    );

    const markup = renderToStaticMarkup(
      React.createElement(HistoricoTable, { rows, privacyMode: true }),
    );
    expect(markup).toMatch(/\*{4}\s?€/);
    expect(markup).toMatch(/\+\*{3}\s?€/);
    expect(markup).not.toContain("1.500");
    expect(markup).not.toContain("500");
  });

  test("a holding with no frozen positions carries no second level", () => {
    const plain = (dateKey: string, valueMinor: number): SnapshotHoldingRecord => ({
      capturedAt: `${dateKey}T10:00:00.000Z`,
      countsAsHousing: false,
      dateKey,
      holdingId: "asset_cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      scopeId: "household",
      securesHousing: false,
      snapshotId: `snap_${dateKey}`,
      valueMinor,
    });

    const rows = buildHistoricoRows(
      [snapshot("2026-06-10", 1_000_00), snapshot("2026-06-11", 1_500_00)],
      [plain("2026-06-10", 1_000_00), plain("2026-06-11", 1_500_00)],
      "2026-06-11",
    );

    const mover = rows[0]!.movers.find((m) => m.holdingId === "asset_cash");
    expect(mover?.contributionMinor).toBe(500_00);
    expect(mover?.positions).toBeUndefined();
  });
});
