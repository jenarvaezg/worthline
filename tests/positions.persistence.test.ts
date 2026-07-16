import type { WorthlineStore } from "@worthline/db";
import { createWorthlineStoreUnsafe, openLibsqlClient } from "@worthline/db";
import { calculateNetWorth } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, createFileBackedStore, tempDatabasePath } from "./helpers";

afterEach(cleanupTempDirs);

async function seedWorkspace(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
}

describe("investment position persistence", () => {
  test("derives units, average cost, market value and P/L from recorded operations", async () => {
    const store = await createFileBackedStore("worthline-positions-");
    await seedWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_acme",
      manualPricePerUnit: "130",
      name: "ACME",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      unitSymbol: "ACME",
    });
    await store.operations.recordOperation({
      assetId: "asset_acme",
      currency: "EUR",
      executedAt: "2026-01-01",
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });
    await store.operations.recordOperation({
      assetId: "asset_acme",
      currency: "EUR",
      executedAt: "2026-02-01",
      id: "op2",
      kind: "sell",
      pricePerUnit: "120",
      units: "4",
    });

    const positions = await store.snapshots.readPositions("member_jose");
    expect(positions).toHaveLength(1);

    const position = positions[0]!;
    expect(position.name).toBe("ACME");
    expect(position.currentUnits).toBe("6");
    expect(position.costBasis).toEqual({ amountMinor: 60_000, currency: "EUR" });
    expect(position.averageUnitCost).toBe("100");
    expect(position.marketValue).toEqual({ amountMinor: 78_000, currency: "EUR" }); // 6 × 130
    expect(position.unrealizedPnl).toEqual({ amountMinor: 18_000, currency: "EUR" }); // 780 − 600

    expect(await store.operations.readOperations("asset_acme")).toHaveLength(2);
  });

  test("soft-deleted investment assets are excluded from live positions and return after restore", async () => {
    const store = await createFileBackedStore("worthline-positions-");
    await seedWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_acme",
      manualPricePerUnit: "130",
      name: "ACME",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
      assetId: "asset_acme",
      currency: "EUR",
      executedAt: "2026-01-01",
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    expect(
      (await store.snapshots.readPositions("member_jose")).map(
        (position) => position.assetId,
      ),
    ).toEqual(["asset_acme"]);

    await store.assets.softDeleteAsset("asset_acme", "2026-06-11T10:00:00.000Z");

    expect(await store.snapshots.readPositions("member_jose")).toEqual([]);

    await store.assets.restoreAsset("asset_acme");

    expect(
      (await store.snapshots.readPositions("member_jose")).map(
        (position) => position.assetId,
      ),
    ).toEqual(["asset_acme"]);
  });

  test("an investment asset contributes its derived market value to net worth, not the stored stale value", async () => {
    const databasePath = tempDatabasePath("worthline-positions-");
    const store = await createWorthlineStoreUnsafe({ databasePath });
    await seedWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_acme",
      manualPricePerUnit: "130",
      name: "ACME",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
      assetId: "asset_acme",
      currency: "EUR",
      executedAt: "2026-01-01",
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    const sqlite = openLibsqlClient(databasePath);
    await sqlite.execute({
      sql: "UPDATE assets SET current_value_minor = ? WHERE id = ?",
      args: [42_00, "asset_acme"],
    });
    sqlite.close();

    const summary = calculateNetWorth({
      assets: await store.assets.readAssets(),
      scopeId: "member_jose",
      workspace: (await store.workspace.readWorkspace())!,
    });

    // Investment assets default to the "market" tier (liquid); value = 10 × 130.
    // If readAssets used the stale stored row value, this would be 42 EUR.
    expect(summary.liquidNetWorth.amountMinor).toBe(130_000);
  });

  test("rejects an operation with non-positive units", async () => {
    const store = await createFileBackedStore("worthline-positions-");
    await seedWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_acme",
      name: "ACME",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });

    await expect(
      store.operations.recordOperation({
        assetId: "asset_acme",
        currency: "EUR",
        executedAt: "2026-01-01",
        id: "bad",
        kind: "buy",
        pricePerUnit: "100",
        units: "0",
      }),
    ).rejects.toThrow("units");
  });

  test("fetched price takes priority over manual price in net worth", async () => {
    const store = await createFileBackedStore("worthline-positions-");
    await seedWorkspace(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_acme",
      manualPricePerUnit: "130",
      name: "ACME",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
      assetId: "asset_acme",
      currency: "EUR",
      executedAt: "2026-01-01",
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    await store.operations.upsertPrice({
      assetId: "asset_acme",
      currency: "EUR",
      fetchedAt: "2026-06-01T12:00:00.000Z",
      freshnessState: "fresh",
      price: "150",
      source: "stooq",
    });

    const summary = calculateNetWorth({
      assets: await store.assets.readAssets(),
      scopeId: "member_jose",
      workspace: (await store.workspace.readWorkspace())!,
    });

    expect(summary.liquidNetWorth.amountMinor).toBe(150_000);

    const positions = await store.snapshots.readPositions("member_jose");
    expect(positions[0]!.marketValue?.amountMinor).toBe(150_000);
  });
});
