/**
 * Snapshot persistence hardening (#185).
 *
 * Three structural guarantees at the store's single most-used write seam:
 *  1. saveSnapshot backstops the ADR-0008 reconciliation invariant inside its
 *     own transaction — a non-reconciling holdings set throws and persists
 *     nothing, so the invariant no longer depends on every one of ~9 callers.
 *  2. The derived monthly close (ADR 0005, last snapshot of the month) is
 *     unchanged after the dead `isMonthlyClose` clearing branch is removed.
 *  3. The standalone backfill is atomic (rollback-on-throw) and the post-import
 *     gap-fill surfaces failure to the caller instead of only console.error.
 */
import type {
  NetWorthSnapshot,
  SnapshotHoldingRow,
  WorkspaceExport,
} from "@worthline/domain";
import { deriveMonthlyCloses, serializeWorkspaceExport } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { WorthlineStore } from "../src/index";

const eur = (amountMinor: number): NetWorthSnapshot["debts"] => ({
  amountMinor,
  currency: "EUR",
});

/** A snapshot whose five headline figures the caller controls, for direct saveSnapshot tests. */
function makeSnapshot(
  overrides: Partial<NetWorthSnapshot> & { dateKey: string },
): NetWorthSnapshot {
  const dateKey = overrides.dateKey;
  return {
    capturedAt: `${dateKey}T20:00:00.000Z`,
    debts: eur(0),
    grossAssets: eur(0),
    housingEquity: eur(0),
    id: `snap_${dateKey}`,
    isMonthlyClose: false,
    liquidNetWorth: eur(0),
    monthKey: dateKey.slice(0, 7),
    scopeId: "mJ",
    scopeLabel: "Jose",
    totalNetWorth: eur(0),
    warnings: [],
    ...overrides,
  };
}

function seed(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
}

describe("saveSnapshot reconciliation backstop (#185)", () => {
  test("rejects a holdings set whose asset rows do not sum to gross assets, persisting nothing", () => {
    const store = createInMemoryStore();
    seed(store);

    // Asset row sums to 100000 but the headline gross assets claims 999999.
    const holdings: SnapshotHoldingRow[] = [
      {
        countsAsHousing: false,
        holdingId: "a_cash",
        kind: "asset",
        label: "Cuenta",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 100000,
      },
    ];

    expect(() =>
      store.snapshots.saveSnapshot({
        holdings,
        snapshot: makeSnapshot({
          dateKey: "2024-01-10",
          grossAssets: eur(999999),
          liquidNetWorth: eur(999999),
          totalNetWorth: eur(999999),
        }),
      }),
    ).toThrow(/reconcil/i);

    // Nothing persisted — neither the snapshot row nor its holdings.
    expect(store.snapshots.readSnapshots()).toHaveLength(0);
    expect(store.snapshots.readSnapshotHoldings()).toHaveLength(0);
    store.close();
  });

  test("rejects a holdings set whose derived liquid axis contradicts the headline, persisting nothing", () => {
    const store = createInMemoryStore();
    seed(store);

    // Asset/liability sums reconcile, but liquidNetWorth is wrong: a single
    // liquid cash asset of 100000 with no debts derives liquid = 100000, yet
    // the headline claims 50000.
    const holdings: SnapshotHoldingRow[] = [
      {
        countsAsHousing: false,
        holdingId: "a_cash",
        kind: "asset",
        label: "Cuenta",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 100000,
      },
    ];

    expect(() =>
      store.snapshots.saveSnapshot({
        holdings,
        snapshot: makeSnapshot({
          dateKey: "2024-02-10",
          grossAssets: eur(100000),
          liquidNetWorth: eur(50000),
          totalNetWorth: eur(100000),
        }),
      }),
    ).toThrow(/reconcil/i);

    expect(store.snapshots.readSnapshots()).toHaveLength(0);
    expect(store.snapshots.readSnapshotHoldings()).toHaveLength(0);
    store.close();
  });

  test("persists a fully reconciling holdings set across all five figures", () => {
    const store = createInMemoryStore();
    seed(store);

    const holdings: SnapshotHoldingRow[] = [
      {
        countsAsHousing: false,
        holdingId: "a_cash",
        kind: "asset",
        label: "Cuenta",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 100000,
      },
      {
        countsAsHousing: false,
        holdingId: "l_card",
        kind: "liability",
        label: "Tarjeta",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 30000,
      },
    ];

    store.snapshots.saveSnapshot({
      holdings,
      snapshot: makeSnapshot({
        dateKey: "2024-03-10",
        debts: eur(30000),
        grossAssets: eur(100000),
        housingEquity: eur(0),
        liquidNetWorth: eur(70000),
        totalNetWorth: eur(70000),
      }),
    });

    expect(store.snapshots.readSnapshots()).toHaveLength(1);
    expect(store.snapshots.readSnapshotHoldings()).toHaveLength(2);
    store.close();
  });
});

describe("derived monthly close survives the dead-branch removal (#185, ADR 0005)", () => {
  test("the last snapshot of a calendar month is the derived close, regardless of the stored flag", () => {
    const store = createInMemoryStore();
    seed(store);

    // Three reconciling snapshots in the same month; none declares isMonthlyClose.
    for (const dateKey of ["2024-04-05", "2024-04-15", "2024-04-28"]) {
      store.snapshots.saveSnapshot({
        holdings: [
          {
            countsAsHousing: false,
            holdingId: "a_cash",
            kind: "asset",
            label: "Cuenta",
            liquidityTier: "cash",
            securesHousing: false,
            valueMinor: 100000,
          },
        ],
        snapshot: makeSnapshot({
          dateKey,
          grossAssets: eur(100000),
          liquidNetWorth: eur(100000),
          totalNetWorth: eur(100000),
        }),
      });
    }

    const snapshots = store.snapshots.readSnapshots();
    const closes = deriveMonthlyCloses(snapshots);
    // The derived close is the last snapshot of the month, not a stored flag.
    expect(closes.get("2024-04")).toBe("snap_2024-04-28");
    store.close();
  });
});

describe("standalone backfill is atomic (#185)", () => {
  test("a mid-run failure rolls the whole backfill back, leaving no partial history", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    // Two backdated buys recorded WITHOUT rippling — two date-gaps the backfill
    // will fill (one snapshot per scope per date). The scopes of an individual
    // workspace are [household, mJ], processed in order, dates ascending.
    for (const executedAt of ["2024-01-10", "2024-02-10"]) {
      store.operations.recordOperation({
        assetId: "fund",
        currency: "EUR",
        executedAt,
        feesMinor: 0,
        id: `op_${executedAt}`,
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      });
    }

    // Pre-seed a snapshot whose PRIMARY KEY id collides with the id the backfill
    // will mint for (household, 2024-02-10) — but at a different (scope, date),
    // so the backfill's upsert (which targets scope_id+date_key) does NOT resolve
    // it and instead hits the id PK conflict mid-loop, after the earlier date has
    // already been inserted in the same transaction. An atomic backfill rolls the
    // whole thing back; a non-atomic one leaves the 2024-01-10 rows orphaned.
    store.snapshots.saveSnapshot({
      snapshot: {
        capturedAt: "2099-01-01T20:00:00.000Z",
        dateKey: "2099-01-01",
        debts: eur(0),
        grossAssets: eur(0),
        housingEquity: eur(0),
        id: "histsnap_household_2024-02-10",
        isMonthlyClose: false,
        liquidNetWorth: eur(0),
        monthKey: "2099-01",
        scopeId: "household",
        scopeLabel: "Hogar",
        totalNetWorth: eur(0),
        warnings: [],
      },
    });

    const before = store.snapshots.readSnapshots().map((s) => s.id);
    expect(before).toEqual(["histsnap_household_2024-02-10"]);

    expect(() => store.backfillHistoricalSnapshots("2026-06-12")).toThrow();

    // Rollback: only the pre-seeded sentinel survives; no histsnap rows for
    // 2024-01-10 were left behind by the failed run.
    const after = store.snapshots.readSnapshots().map((s) => s.id);
    expect(after).toEqual(["histsnap_household_2024-02-10"]);
    expect(
      store.snapshots.readSnapshotHoldings().some((h) => h.dateKey === "2024-01-10"),
    ).toBe(false);
    store.close();
  });
});

describe("post-import gap-fill surfaces its failure to the caller (#185)", () => {
  test("a failing gap-fill returns gapFillError instead of swallowing it, import stays committed", () => {
    const store = createInMemoryStore();

    // A document with a backdated operation at 2026-05-15 (a gap-fill target) and
    // a snapshot whose id collides with the id the gap-fill will mint for
    // (household, 2026-05-15) — but at a different dateKey, so the gap-fill insert
    // hits the snapshots PK and throws. Built directly (it would never pass
    // parseWorkspaceExport, which is exactly the point — the test forces the
    // post-import gap-fill to fail).
    const doc: WorkspaceExport = serializeWorkspaceExport({
      workspace: { mode: "household", baseCurrency: "EUR" },
      members: [{ id: "m1", name: "Alice" }],
      groups: [],
      assets: [
        {
          id: "inv",
          name: "Fondo",
          type: "investment",
          currency: "EUR",
          liquidityTier: "market",
          ownership: [{ memberId: "m1", shareBps: 10000 }],
          investment: { manualPricePerUnit: "100" },
        },
      ],
      liabilities: [],
      operations: [
        {
          id: "op1",
          assetId: "inv",
          kind: "buy",
          executedAt: "2026-05-15T09:30:00.000Z",
          units: "10",
          pricePerUnit: "100",
          currency: "EUR",
          feesMinor: 0,
        },
      ],
      warningOverrides: [],
      fireConfig: {},
      snapshots: [
        {
          id: "histsnap_household_2026-05-15",
          scopeId: "household",
          scopeLabel: "Hogar",
          capturedAt: "2030-01-01T20:00:00.000Z",
          dateKey: "2030-01-01",
          monthKey: "2030-01",
          isMonthlyClose: false,
          totalNetWorth: { amountMinor: 0, currency: "EUR" },
          liquidNetWorth: { amountMinor: 0, currency: "EUR" },
          housingEquity: { amountMinor: 0, currency: "EUR" },
          grossAssets: { amountMinor: 0, currency: "EUR" },
          debts: { amountMinor: 0, currency: "EUR" },
          warnings: [],
          holdings: [],
        },
      ],
      trash: { assets: [], liabilities: [] },
      priceCache: [],
      connectedSources: [],
    });

    const result = store.workspace.importWorkspace(doc);

    // The failure is surfaced, not swallowed.
    expect(result.gapFillError).toBeInstanceOf(Error);

    // The import itself committed (ADR 0010): the live state and the file's own
    // snapshot are present despite the gap-fill failure.
    expect(store.workspace.readWorkspace()!.members.map((m) => m.id)).toEqual(["m1"]);
    expect(store.assets.readAssets().map((a) => a.id)).toEqual(["inv"]);
    expect(
      store.snapshots
        .readSnapshots()
        .some((s) => s.id === "histsnap_household_2026-05-15"),
    ).toBe(true);
    store.close();
  });

  test("a clean import returns no gapFillError", () => {
    const store = createInMemoryStore();
    const doc: WorkspaceExport = serializeWorkspaceExport({
      workspace: { mode: "individual", baseCurrency: "EUR" },
      members: [{ id: "m1", name: "Alice" }],
      groups: [],
      assets: [
        {
          id: "cash",
          name: "Cuenta",
          type: "cash",
          currency: "EUR",
          currentValue: { amountMinor: 100000, currency: "EUR" },
          liquidityTier: "cash",
          isPrimaryResidence: false,
          ownership: [{ memberId: "m1", shareBps: 10000 }],
        },
      ],
      liabilities: [],
      operations: [],
      warningOverrides: [],
      fireConfig: {},
      snapshots: [],
      trash: { assets: [], liabilities: [] },
      priceCache: [],
      connectedSources: [],
    });

    const result = store.workspace.importWorkspace(doc);
    expect(result.gapFillError).toBeUndefined();
    store.close();
  });
});
