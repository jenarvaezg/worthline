/**
 * Targeted frozen-holding reads for housing valuation actions (#207).
 *
 * The housing valuation/appreciation-rate actions find the earliest historical
 * snapshot carrying a given housing asset to pick the ripple start date. They
 * used to read EVERY frozen holding row across all scopes into memory and filter
 * by `kind === "asset" && holding_id === assetId` in JS — a full
 * `snapshot_holdings` scan that grows with the whole snapshot history regardless
 * of how few rows belong to the asset.
 *
 * This test pins the FIX at two levels:
 *   1. READ SHAPE — the store exposes a targeted read keyed by holding id / kind,
 *      backed by an index, so `EXPLAIN QUERY PLAN` resolves it through that index
 *      instead of a bare full scan of `snapshot_holdings`.
 *   2. BEHAVIOR — with MANY unrelated frozen holding rows seeded (other housing
 *      assets, investments), the targeted read returns ONLY the rows of the asked
 *      asset, so the earliest relevant date the actions select is identical to
 *      filtering the full set in memory.
 *
 * The product figures the actions compute are unchanged — only HOW the earliest
 * date is read changes (the action-seam suites cover the figures end to end).
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createInMemoryStore, createStoreFromSqlite } from "../src/index";
import type { WorthlineStore } from "../src/index";
import { migrate } from "../src/migrate";

const TODAY = "2026-06-12";

/** A YYYY-MM-DD `count` days after `from`. */
function addDays(from: string, count: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

/**
 * Seed a workspace with TWO housing assets and a priced investment, then declare
 * backdated market appraisals so each housing asset and the investment generate a
 * long band of frozen holding rows across many snapshots. The target housing
 * asset (`pisoA`) gets its earliest snapshot at `EARLIEST_A`; every OTHER frozen
 * row (`pisoB`, the investment) is UNRELATED and must not be selected.
 */
const EARLIEST_A = "2024-01-01";
const EARLIEST_B = "2023-06-01";
const BAND = 30;

function seedManyUnrelatedRows(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });

  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 130_000_00,
    id: "pisoA",
    liquidityTier: "illiquid",
    name: "Piso A",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 200_000_00,
    id: "pisoB",
    liquidityTier: "illiquid",
    name: "Piso B",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });

  // pisoB's earliest snapshot is BEFORE pisoA's, so if the read leaked pisoB rows
  // the earliest date would be wrong (EARLIEST_B, not EARLIEST_A).
  store.addValuationAnchorAndRipple(
    {
      adjustsPriorCurve: true,
      assetId: "pisoB",
      id: "bAnchor",
      valuationDate: EARLIEST_B,
      valueMinor: 200_000_00,
    },
    { today: TODAY },
  );

  // A daily band of investment-backed snapshots gives MANY frozen rows whose
  // earliest is also before pisoA — more unrelated noise the read must ignore.
  for (let i = 0; i < BAND; i += 1) {
    const dateKey = addDays(EARLIEST_B, i);
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: dateKey,
        id: `op_${dateKey}`,
        kind: "buy",
        pricePerUnit: "100",
        units: "1",
      },
      { today: TODAY },
    );
  }

  // The TARGET asset's earliest appraisal — later than all the noise above.
  store.addValuationAnchorAndRipple(
    {
      adjustsPriorCurve: true,
      assetId: "pisoA",
      id: "aAnchor",
      valuationDate: EARLIEST_A,
      valueMinor: 130_000_00,
    },
    { today: TODAY },
  );
}

/** The single-line query-plan text for a statement, joined for easy matching. */
function queryPlan(sqlite: Database.Database, sql: string, ...params: unknown[]): string {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join("\n");
}

function indexNames(sqlite: Database.Database, table: string): string[] {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all(table)
    .map((row) => (row as { name: string }).name);
}

describe("targeted housing snapshot reads (#207)", () => {
  test("a fresh database declares the holding/kind index on snapshot_holdings", () => {
    const sqlite = new Database(":memory:");
    try {
      migrate(sqlite);
      expect(indexNames(sqlite, "snapshot_holdings")).toContain(
        "snapshot_holdings_holding_kind_idx",
      );
    } finally {
      sqlite.close();
    }
  });

  test("reads frozen rows by holding id / kind through an index, not a full scan", () => {
    const sqlite = new Database(":memory:");
    try {
      migrate(sqlite);
      const plan = queryPlan(
        sqlite,
        // Matches the targeted read the store runs: join the owning snapshot for
        // its date/scope, filter by the frozen holding's id + kind.
        "SELECT s.date_key FROM snapshot_holdings h " +
          "INNER JOIN snapshots s ON s.id = h.snapshot_id " +
          "WHERE h.holding_id = ? AND h.kind = ?",
        "pisoA",
        "asset",
      );
      expect(plan).toContain("USING INDEX snapshot_holdings_holding_kind_idx");
      // A bare full-table scan would read "SCAN snapshot_holdings" with no index.
      expect(plan).not.toMatch(/SCAN snapshot_holdings(?! USING INDEX)/);
    } finally {
      sqlite.close();
    }
  });

  test("the targeted store read returns only the asked asset's rows amid many unrelated ones", () => {
    const store = createInMemoryStore();
    seedManyUnrelatedRows(store);

    // Sanity: the full set is large and full of unrelated rows — otherwise the
    // targeting assertion would be vacuous.
    const all = store.snapshots.readSnapshotHoldings();
    expect(all.length).toBeGreaterThan(BAND);
    expect(all.some((r) => r.holdingId === "pisoB")).toBe(true);
    expect(all.some((r) => r.holdingId === "fund")).toBe(true);

    const targeted = store.snapshots.readSnapshotHoldings({
      holdingId: "pisoA",
      kind: "asset",
    });
    expect(targeted.length).toBeGreaterThan(0);
    // ONLY the asked asset's rows come back — never pisoB or the investment, even
    // though pisoB's earliest frozen row predates pisoA's anchor.
    expect(targeted.every((r) => r.holdingId === "pisoA" && r.kind === "asset")).toBe(
      true,
    );
    expect(targeted.some((r) => r.holdingId === "pisoB")).toBe(false);
    expect(targeted.some((r) => r.holdingId === "fund")).toBe(false);

    // The earliest date the actions select must be IDENTICAL to filtering the full
    // set in memory by (kind asset, this holding) — the OLD shape. This is the
    // ripple start date the housing actions key off, so it must not move.
    const earliestTargeted = targeted.map((r) => r.dateKey).sort()[0];
    const earliestInMemory = all
      .filter((r) => r.kind === "asset" && r.holdingId === "pisoA")
      .map((r) => r.dateKey)
      .sort()[0];
    expect(earliestTargeted).toBe(earliestInMemory);

    store.close();
  });

  test("the targeted read avoids loading the whole frozen-holding set into memory", () => {
    let scanned = 0;
    const sqlite = new Database(":memory:", {
      verbose: (message?: unknown) => {
        if (
          typeof message === "string" &&
          /^\s*select/i.test(message) &&
          /\bsnapshot_holdings\b/i.test(message)
        ) {
          scanned += 1;
        }
      },
    });
    const store = createStoreFromSqlite(sqlite);
    seedManyUnrelatedRows(store);

    // After seeding, a single targeted read must be ONE SELECT against
    // snapshot_holdings (filtered), not a full unfiltered scan of the table.
    const before = scanned;
    const targeted = store.snapshots.readSnapshotHoldings({
      holdingId: "pisoA",
      kind: "asset",
    });
    const reads = scanned - before;

    expect(targeted.every((r) => r.holdingId === "pisoA" && r.kind === "asset")).toBe(
      true,
    );
    expect(reads).toBe(1);

    store.close();
  });
});
