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

import type { Client } from "@libsql/client";
import type { WorthlineStore } from "@worthline/db";
import {
  createInMemoryStore,
  createStoreFromSqlite,
  openLibsqlClient,
} from "@worthline/db";
import type { InvestmentCaptureDetail } from "@worthline/domain";
import { captureSnapshotForScope, listScopeOptions } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

/**
 * A household with two members holding two investments with different owners,
 * so the scope filter actually drops a position in a member scope (proving the
 * reused details still cover EVERY asset while the scoped positions narrow).
 */
async function seedHousehold(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
    mode: "household",
  });

  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund_ana",
    name: "Fondo de Ana",
    ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
  });
  await store.operations.recordOperation({
    assetId: "asset_fund_ana",
    currency: "EUR",
    executedAt: "2026-01-01",
    id: "op_ana_1",
    kind: "buy",
    pricePerUnit: "100",
    units: "12.5",
  });
  await store.operations.upsertPrice({
    assetId: "asset_fund_ana",
    currency: "EUR",
    fetchedAt: "2026-06-10T09:00:00.000Z",
    freshnessState: "fresh",
    price: "110.40",
    source: "stooq",
  });

  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund_jose",
    name: "Fondo de Jose",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  });
  await store.operations.recordOperation({
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
  test("a single seam serves byte-identical capture details and scoped positions", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);

    // What loadDashboard does today: derive the unscoped capture details from
    // readPositions() and read the selected scope's positions separately.
    const expectedDetails = new Map<string, InvestmentCaptureDetail>(
      (await store.snapshots.readPositions()).map((position) => [
        position.assetId,
        {
          units: position.currentUnits,
          ...(position.currentPricePerUnit
            ? { unitPrice: position.currentPricePerUnit }
            : {}),
        },
      ]),
    );
    const expectedScoped = await store.snapshots.readPositions("member_ana");

    // The reuse seam: build the projection context once, return both.
    const reused = await store.snapshots.readScopedPositionsWithDetails("member_ana");

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

  test("the undefined scope reuse matches the unscoped readPositions()", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);

    const reused = await store.snapshots.readScopedPositionsWithDetails();
    expect(reused.positions).toEqual(await store.snapshots.readPositions());

    store.close();
  });
});

/**
 * Read-shape guard: instrument the libSQL client to count full scans of the
 * asset_operations table (the heavy read the projection context builds). Drizzle
 * emits `select ... from "asset_operations" order by ...` with no WHERE for the
 * full operation read; the targeted single-asset reads carry a `where`.
 */
describe("dashboard position-projection reuse — read shape (#208)", () => {
  let fullOperationScans = 0;

  // Build a store on an instrumented in-memory client that counts every full
  // scan of `asset_operations` (a SELECT with no WHERE), so a test can assert the
  // projection context's read shape. The counter starts at 0 and the caller
  // resets it before the measured action.
  async function createCountingStore(): Promise<WorthlineStore> {
    const client = openLibsqlClient(":memory:");
    const originalExecute = client.execute.bind(client);
    // biome-ignore lint/suspicious/noExplicitAny: spy on libsql execute for scan counting
    client.execute = ((stmt: any, ...rest: any[]) => {
      const sql = typeof stmt === "string" ? stmt : stmt?.sql;
      if (typeof sql === "string") {
        const normalized = sql.toLowerCase();
        if (
          normalized.includes('from "asset_operations"') &&
          !normalized.includes("where")
        ) {
          fullOperationScans += 1;
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: forward to original execute
      return (originalExecute as any)(stmt, ...rest);
    }) as Client["execute"];
    return createStoreFromSqlite(client);
  }

  beforeEach(() => {
    fullOperationScans = 0;
  });

  test("a dashboard-style load reads the operations table once, not per scope read", async () => {
    const store = await createCountingStore();
    await seedHousehold(store);

    const workspace = (await store.workspace.readWorkspace())!;
    const assets = await store.assets.readAssets();
    const liabilities = await store.liabilities.readLiabilities();
    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes[0]!;

    // Reset the counter so only the position-projection reads below are measured
    // (seeding and the readAssets above also touch the table).
    fullOperationScans = 0;

    // The reuse seam: one context build serves the capture details (unscoped)
    // and the selected scope's positions.
    const { details, positions } = await store.snapshots.readScopedPositionsWithDetails(
      selectedScope.id,
    );

    const investmentDetails = details;
    for (const scope of scopes) {
      const capture = captureSnapshotForScope({
        assets,
        capturedAt: "2026-06-10T10:00:00.000Z",
        existingSnapshots: await store.snapshots.readSnapshots(scope.id),
        investmentDetails,
        liabilities,
        scope,
        workspace,
      });
      if (capture) {
        await store.snapshots.saveSnapshot({
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
