/**
 * Dashboard position-projection reuse — integration test (issue #208).
 *
 * The dashboard load path (apps/web/app/load-dashboard.ts) needs two things off
 * the investment positions on every request:
 *   1. the per-investment capture details (units + unit price) used to freeze
 *      each scope's snapshot holding rows (units/unitPrice), derived from the
 *      UNSCOPED positions, and
 *   2. the SELECTED scope's positions for the dashboard state.
 *
 * Both are derived from the same raw investment operations and the same
 * price-selection rule (ADR 0006). The per-asset position math (units, cost,
 * price, market value, PnL) is identical regardless of scope — the scope only
 * FILTERS which positions appear (an asset the scope holds no share of is
 * dropped), it never changes a kept position's figures.
 *
 * This suite pins that reuse: a single store seam builds the projection context
 * ONCE and serves both the unscoped capture details and the scoped positions,
 * so a dashboard load no longer reads every operation row twice. It asserts:
 *   - BEHAVIOR: the reused details + scoped positions are byte-identical to the
 *     two separate readPositions() calls they replace, AND
 *   - READ SHAPE: a full dashboard-style load reads the operations table once,
 *     not once per readPositions() call.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import Database from "better-sqlite3";
import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import type { InvestmentCaptureDetail } from "@worthline/domain";
import { captureSnapshotForScope, listScopeOptions } from "@worthline/domain";

import { cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

/**
 * A household with two members holding two investments with different owners,
 * so the scope filter actually drops a position in a member scope (proving the
 * reused details still cover EVERY asset while the scoped positions narrow).
 */
function seedHousehold(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
    mode: "household",
  });

  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund_ana",
    name: "Fondo de Ana",
    ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
  });
  store.operations.recordOperation({
    assetId: "asset_fund_ana",
    currency: "EUR",
    executedAt: "2026-01-01",
    id: "op_ana_1",
    kind: "buy",
    pricePerUnit: "100",
    units: "12.5",
  });
  store.operations.upsertPrice({
    assetId: "asset_fund_ana",
    currency: "EUR",
    fetchedAt: "2026-06-10T09:00:00.000Z",
    freshnessState: "fresh",
    price: "110.40",
    source: "stooq",
  });

  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund_jose",
    name: "Fondo de Jose",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  });
  store.operations.recordOperation({
    assetId: "asset_fund_jose",
    currency: "EUR",
    executedAt: "2026-02-01",
    id: "op_jose_1",
    kind: "buy",
    pricePerUnit: "50",
    units: "8",
  });
}

describe("dashboard position-projection reuse (integration, #208)", () => {
  test("a single seam serves byte-identical capture details and scoped positions", () => {
    const store = createInMemoryStore();
    seedHousehold(store);

    // What loadDashboard does today: derive the unscoped capture details from
    // readPositions() and read the selected scope's positions separately.
    const expectedDetails = new Map<string, InvestmentCaptureDetail>(
      store.snapshots.readPositions().map((position) => [
        position.assetId,
        {
          units: position.currentUnits,
          ...(position.currentPricePerUnit
            ? { unitPrice: position.currentPricePerUnit }
            : {}),
        },
      ]),
    );
    const expectedScoped = store.snapshots.readPositions("member_ana");

    // The reuse seam: build the projection context once, return both.
    const reused = store.snapshots.readScopedPositionsWithDetails("member_ana");

    // Capture details cover EVERY investment (unscoped) and are byte-identical.
    expect(reused.details).toEqual(expectedDetails);
    expect([...reused.details.keys()].sort()).toEqual([
      "asset_fund_ana",
      "asset_fund_jose",
    ]);

    // The scoped positions are byte-identical to the separate scoped read — the
    // scope filter drops Jose's fund from Ana's scope, keeps Ana's untouched.
    expect(reused.positions).toEqual(expectedScoped);
    expect(reused.positions.map((p) => p.assetId)).toEqual(["asset_fund_ana"]);

    store.close();
  });

  test("the undefined scope reuse matches the unscoped readPositions()", () => {
    const store = createInMemoryStore();
    seedHousehold(store);

    const reused = store.snapshots.readScopedPositionsWithDetails();
    expect(reused.positions).toEqual(store.snapshots.readPositions());

    store.close();
  });
});

/**
 * Read-shape guard: instrument better-sqlite3 to count full scans of the
 * asset_operations table (the heavy read the projection context builds). Drizzle
 * emits `select ... from "asset_operations" order by ...` with no WHERE for the
 * full operation read; the targeted single-asset reads carry a `where`.
 */
describe("dashboard position-projection reuse — read shape (#208)", () => {
  const originalPrepare = Database.prototype.prepare;
  let fullOperationScans = 0;

  beforeEach(() => {
    fullOperationScans = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Database.prototype.prepare = function (this: any, sql: string, ...rest: any[]) {
      const normalized = sql.toLowerCase();
      if (
        normalized.includes('from "asset_operations"') &&
        !normalized.includes("where")
      ) {
        fullOperationScans += 1;
      }
      return originalPrepare.call(this, sql, ...rest);
    } as typeof Database.prototype.prepare;
  });

  afterEach(() => {
    Database.prototype.prepare = originalPrepare;
  });

  test("a dashboard-style load reads the operations table once, not per scope read", () => {
    const store = createInMemoryStore();
    seedHousehold(store);

    const workspace = store.workspace.readWorkspace()!;
    const assets = store.assets.readAssets();
    const liabilities = store.liabilities.readLiabilities();
    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes[0]!;

    // Reset the counter so only the position-projection reads below are measured
    // (seeding and the readAssets above also touch the table).
    fullOperationScans = 0;

    // The reuse seam: one context build serves the capture details (unscoped)
    // and the selected scope's positions.
    const { details, positions } = store.snapshots.readScopedPositionsWithDetails(
      selectedScope.id,
    );

    const investmentDetails = details;
    for (const scope of scopes) {
      const capture = captureSnapshotForScope({
        assets,
        capturedAt: "2026-06-10T10:00:00.000Z",
        existingSnapshots: store.snapshots.readSnapshots(scope.id),
        investmentDetails,
        liabilities,
        scope,
        workspace,
      });
      if (capture) {
        store.snapshots.saveSnapshot({
          holdings: capture.holdings,
          replace: capture.replace,
          snapshot: capture.snapshot,
        });
      }
    }

    expect(positions.length).toBeGreaterThan(0);

    // The two readPositions() calls the old path used each fully scanned the
    // operations table; the reuse seam scans it exactly once.
    expect(fullOperationScans).toBe(1);

    store.close();
  });
});
