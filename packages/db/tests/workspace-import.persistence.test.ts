import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import type { MoneyMinor, NetWorthSnapshot, WorkspaceExport } from "@worthline/domain";
import { serializeWorkspaceExport } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const eur = (amountMinor: number): MoneyMinor => ({ amountMinor, currency: "EUR" });

/** Seed workspace A through the public store API (member mA, asset, liability, snapshot, fire, override, trash). */
async function seedWorkspaceA(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mA", name: "Alice A" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100000,
    id: "a-A1",
    liquidityTier: "cash",
    name: "Cuenta A",
    ownership: [{ memberId: "mA", shareBps: 10000 }],
    type: "cash",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 5000,
    id: "a-A2",
    liquidityTier: "illiquid",
    name: "Trasto A",
    ownership: [{ memberId: "mA", shareBps: 10000 }],
    type: "manual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 30000,
    currency: "EUR",
    id: "l-A1",
    name: "Deuda A",
    ownership: [{ memberId: "mA", shareBps: 10000 }],
    type: "debt",
  });
  await store.saveFireConfig("mA", {
    expectedRealReturn: 0.07,
    monthlySpendingMinor: 100000,
    safeWithdrawalRate: 0.04,
  });
  await store.acknowledgeWarning("ZERO_VALUE_ASSET", "a-A1");
  await store.assets.softDeleteAsset("a-A2", "2026-06-01T10:00:00.000Z");

  const snapshot: NetWorthSnapshot = {
    capturedAt: "2026-06-01T20:00:00.000Z",
    dateKey: "2026-06-01",
    debts: eur(30000),
    grossAssets: eur(100000),
    housingEquity: eur(0),
    id: "snap-A",
    isMonthlyClose: false,
    liquidNetWorth: eur(70000),
    monthKey: "2026-06",
    scopeId: "mA",
    scopeLabel: "Alice A",
    totalNetWorth: eur(70000),
    warnings: [],
  };

  await store.snapshots.saveSnapshot({
    holdings: [
      {
        countsAsHousing: false,
        holdingId: "a-A1",
        kind: "asset",
        label: "Cuenta A",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 100000,
      },
      {
        countsAsHousing: false,
        holdingId: "l-A1",
        kind: "liability",
        label: "Deuda A",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 30000,
      },
    ],
    snapshot,
  });
}

/** A rich, already-validated document B touching every section. */
function makeDocumentB(): WorkspaceExport {
  return serializeWorkspaceExport({
    workspace: { mode: "household", baseCurrency: "EUR" },
    members: [
      { id: "b-m1", name: "Berta" },
      { id: "b-m2", name: "Carlos" },
    ],
    groups: [{ id: "b-g1", name: "Pareja", memberIds: ["b-m1", "b-m2"] }],
    assets: [
      {
        id: "b-a1",
        name: "Cuenta B",
        type: "cash",
        currency: "EUR",
        currentValue: eur(200000),
        liquidityTier: "cash",
        isPrimaryResidence: false,
        ownership: [{ memberId: "b-m1", shareBps: 10000 }],
      },
      {
        id: "b-a2",
        name: "Fondo B",
        type: "investment",
        currency: "EUR",
        liquidityTier: "market",
        ownership: [
          { memberId: "b-m1", shareBps: 5000 },
          { memberId: "b-m2", shareBps: 5000 },
        ],
        investment: {
          unitSymbol: "VWCE",
          isin: "IE00BK5BQT80",
          priceProvider: "stooq",
          providerSymbol: "VWCE.DE",
          manualPricePerUnit: "100",
          manualPricedAt: "2026-06-01T08:00:00.000Z",
        },
      },
    ],
    liabilities: [
      {
        id: "b-l1",
        name: "Hipoteca B",
        type: "mortgage",
        currency: "EUR",
        currentBalance: eur(50000),
        ownership: [{ memberId: "b-m1", shareBps: 10000 }],
        associatedAssetId: "b-a1",
      },
    ],
    operations: [
      {
        id: "b-op1",
        assetId: "b-a2",
        kind: "buy",
        executedAt: "2026-05-15T09:30:00.000Z",
        units: "2",
        pricePerUnit: "100",
        currency: "EUR",
        feesMinor: 150,
      },
    ],
    warningOverrides: [{ code: "ZERO_VALUE_ASSET", entityId: "b-a1" }],
    fireConfig: {
      household: {
        monthlySpendingMinor: 200000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.05,
      },
    },
    snapshots: [
      {
        id: "b-s1",
        scopeId: "household",
        scopeLabel: "Hogar",
        capturedAt: "2026-05-01T20:00:00.000Z",
        dateKey: "2026-05-01",
        monthKey: "2026-05",
        isMonthlyClose: true,
        totalNetWorth: eur(150000),
        liquidNetWorth: eur(150000),
        housingEquity: eur(0),
        grossAssets: eur(200000),
        debts: eur(50000),
        warnings: [],
        holdings: [
          {
            countsAsHousing: false,
            holdingId: "b-a1",
            kind: "asset",
            label: "Cuenta B",
            liquidityTier: "cash",
            securesHousing: false,
            valueMinor: 200000,
          },
          {
            countsAsHousing: false,
            holdingId: "b-l1",
            kind: "liability",
            label: "Hipoteca B",
            liquidityTier: "cash",
            securesHousing: false,
            valueMinor: 50000,
          },
        ],
      },
    ],
    trash: {
      assets: [
        {
          id: "b-a9",
          name: "Viejo B",
          type: "manual",
          currency: "EUR",
          currentValue: eur(1000),
          liquidityTier: "illiquid",
          ownership: [{ memberId: "b-m1", shareBps: 10000 }],
          deletedAt: "2026-04-01T12:00:00.000Z",
        },
      ],
      liabilities: [
        {
          id: "b-l9",
          name: "Deuda vieja B",
          type: "debt",
          currency: "EUR",
          currentBalance: eur(500),
          ownership: [{ memberId: "b-m1", shareBps: 10000 }],
          deletedAt: "2026-04-02T12:00:00.000Z",
        },
      ],
    },
    priceCache: [
      {
        assetId: "b-a2",
        currency: "EUR",
        price: "110",
        source: "stooq",
        priceDate: "2026-06-10",
        fetchedAt: "2026-06-10T18:00:00.000Z",
        freshnessState: "fresh",
      },
    ],
    connectedSources: [],
  });
}

/** A minimal live-state-only document (empty snapshots/trash/priceCache). */
function makeLiveOnlyDocument(): WorkspaceExport {
  return serializeWorkspaceExport({
    workspace: { mode: "individual", baseCurrency: "EUR" },
    members: [{ id: "c-m1", name: "Carmen" }],
    groups: [],
    assets: [
      {
        id: "c-a1",
        name: "Cuenta C",
        type: "cash",
        currency: "EUR",
        currentValue: eur(7500),
        liquidityTier: "cash",
        isPrimaryResidence: false,
        ownership: [{ memberId: "c-m1", shareBps: 10000 }],
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
}

describe("importWorkspace", () => {
  test("full replace: importing B over a seeded A leaves only B everywhere", async () => {
    const store = await createInMemoryStore();
    await seedWorkspaceA(store);

    const docB = makeDocumentB();
    await store.workspace.importWorkspace(docB);

    const workspace = await store.workspace.readWorkspace();
    expect(workspace).not.toBeNull();
    expect(workspace!.mode).toBe("household");
    expect(workspace!.members.map((m) => ({ id: m.id, name: m.name }))).toEqual([
      { id: "b-m1", name: "Berta" },
      { id: "b-m2", name: "Carlos" },
    ]);
    expect(workspace!.groups).toEqual([
      { id: "b-g1", memberIds: ["b-m1", "b-m2"], name: "Pareja" },
    ]);

    const assets = await store.assets.readAssets();
    expect(assets.map((a) => a.id)).toEqual(["b-a1", "b-a2"]);
    expect(assets[0]!.name).toBe("Cuenta B");
    expect(assets[0]!.currentValue).toEqual(eur(200000));
    // Investment value is derived from its operations and cached price
    // (2 units × 110 = 220.00 €), never stored (ADR 0006).
    expect(assets[1]!.currentValue).toEqual(eur(22000));

    const liabilities = await store.liabilities.readLiabilities();
    expect(liabilities.map((l) => l.id)).toEqual(["b-l1"]);
    expect(liabilities[0]!.currentBalance).toEqual(eur(50000));
    expect(liabilities[0]!.associatedAssetId).toBe("b-a1");

    const snapshots = await store.snapshots.readSnapshots();
    // b-s1 is restored intact; import also gap-fills the operation date (ADR
    // 0012, #112), so extra B-scoped snapshots may appear. No A snapshot leaks.
    expect(snapshots.some((s) => s.id === "snap-A")).toBe(false);
    const bS1 = snapshots.find((s) => s.id === "b-s1")!;
    expect(bS1).toBeTruthy();
    expect(bS1.isMonthlyClose).toBe(true);
    expect(bS1.totalNetWorth).toEqual(eur(150000));
    expect(bS1.scopeLabel).toBe("Hogar");

    // b-s1's own frozen holdings are untouched by gap-fill.
    const b1Holdings = (await store.snapshots.readSnapshotHoldings()).filter(
      (h) => h.snapshotId === "b-s1",
    );
    expect(b1Holdings.map((h) => h.holdingId).sort()).toEqual(["b-a1", "b-l1"]);

    const operations = await store.operations.readOperations("b-a2");
    expect(operations).toEqual([
      {
        assetId: "b-a2",
        currency: "EUR",
        executedAt: "2026-05-15",
        feesMinor: 150,
        id: "b-op1",
        kind: "buy",
        pricePerUnit: "100",
        source: "manual",
        units: "2",
      },
    ]);

    const price = await store.operations.readPriceCache("b-a2");
    expect(price).not.toBeNull();
    expect(price!.price).toBe("110");
    expect(price!.source).toBe("stooq");
    expect(await store.operations.readPriceCache("a-A1")).toBeNull();

    expect(await store.readFireConfig()).toEqual(docB.fireConfig);
    expect(await store.readWarningOverrides()).toEqual([
      { code: "ZERO_VALUE_ASSET", entityId: "b-a1" },
    ]);

    expect(await store.readTrash()).toEqual({
      assets: [{ id: "b-a9", name: "Viejo B" }],
      liabilities: [{ id: "b-l9", name: "Deuda vieja B" }],
    });

    // Investment metadata round-trips for edit pages.
    const investment = await store.assets.readInvestmentAssetById("b-a2");
    expect(investment).not.toBeNull();
    expect(investment!.unitSymbol).toBe("VWCE");
    expect(investment!.isin).toBe("IE00BK5BQT80");
    expect(investment!.priceProvider).toBe("stooq");
    expect(investment!.providerSymbol).toBe("VWCE.DE");
    expect(investment!.manualPricePerUnit).toBe("100");

    // Nothing of A remains anywhere.
    expect(assets.some((a) => a.id.startsWith("a-A"))).toBe(false);
    expect(snapshots.some((s) => s.id === "snap-A")).toBe(false);
    expect(
      (await store.snapshots.readSnapshotHoldings()).some((h) =>
        h.holdingId.startsWith("a-A"),
      ),
    ).toBe(false);
    expect(workspace!.members.some((m) => m.id === "mA")).toBe(false);

    store.close();
  });

  test("ids are preserved: a snapshot holding's holdingId still matches the imported asset id", async () => {
    const store = await createInMemoryStore();
    await store.workspace.importWorkspace(makeDocumentB());

    const assetIds = new Set((await store.assets.readAssets()).map((a) => a.id));
    const assetHolding = (await store.snapshots.readSnapshotHoldings()).find(
      (row) => row.kind === "asset",
    );

    expect(assetHolding).toBeDefined();
    expect(assetHolding!.holdingId).toBe("b-a1");
    expect(assetIds.has(assetHolding!.holdingId)).toBe(true);

    store.close();
  });

  test("atomic rollback: a mid-import constraint violation leaves the prior workspace fully intact", async () => {
    const store = await createInMemoryStore();
    await seedWorkspaceA(store);

    const auditBefore = await store.readAuditLog();
    expect(auditBefore.length).toBeGreaterThan(0);

    // Two snapshots sharing scope_id + date_key violate the snapshots unique
    // index mid-transaction. importWorkspace is called directly — this document
    // would never pass parseWorkspaceExport, which is exactly the point.
    const doc = makeDocumentB();
    const clash = { ...doc.snapshots[0]!, holdings: [], id: "b-s2" };
    const broken: WorkspaceExport = {
      ...doc,
      snapshots: [{ ...doc.snapshots[0]!, holdings: [] }, clash],
    };

    await expect(store.workspace.importWorkspace(broken)).rejects.toThrow();

    const workspace = await store.workspace.readWorkspace();
    expect(workspace!.members.map((m) => m.id)).toEqual(["mA"]);
    expect((await store.assets.readAssets()).map((a) => a.id)).toEqual(["a-A1"]);
    expect((await store.liabilities.readLiabilities()).map((l) => l.id)).toEqual([
      "l-A1",
    ]);
    expect((await store.snapshots.readSnapshots()).map((s) => s.id)).toEqual(["snap-A"]);
    expect((await store.readTrash()).assets).toEqual([{ id: "a-A2", name: "Trasto A" }]);
    expect(await store.readWarningOverrides()).toEqual([
      { code: "ZERO_VALUE_ASSET", entityId: "a-A1" },
    ]);
    expect(await store.readFireConfig()).toHaveProperty("mA");

    // The audit log survived the rollback too — including no import entry.
    const auditAfter = await store.readAuditLog();
    expect(auditAfter).toEqual(auditBefore);
    expect(auditAfter.some((e) => e.action === "import_workspace")).toBe(false);

    store.close();
  });

  test("after a successful import the audit log holds exactly one import_workspace entry", async () => {
    const store = await createInMemoryStore();
    await seedWorkspaceA(store);
    expect((await store.readAuditLog()).length).toBeGreaterThan(0);

    await store.workspace.importWorkspace(makeDocumentB());

    const audit = await store.readAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("import_workspace");
    expect(audit[0]!.entityType).toBe("workspace");
    expect(audit[0]!.entityId).toBe("default");
    expect(audit[0]!.details).toMatchObject({
      assets: 2,
      liabilities: 1,
      members: 2,
      operations: 1,
      snapshots: 1,
      trashAssets: 1,
      trashLiabilities: 1,
    });

    store.close();
  });

  test("importing into a brand-new empty store works", async () => {
    const store = await createInMemoryStore();

    await store.workspace.importWorkspace(makeDocumentB());

    expect(await store.workspace.readWorkspace()).not.toBeNull();
    expect((await store.assets.readAssets()).map((a) => a.id)).toEqual(["b-a1", "b-a2"]);
    expect((await store.readAuditLog()).map((e) => e.action)).toEqual([
      "import_workspace",
    ]);

    store.close();
  });

  test("a live-state-only document imports with snapshots/trash/price cache empty", async () => {
    const store = await createInMemoryStore();
    await seedWorkspaceA(store);

    await store.workspace.importWorkspace(makeLiveOnlyDocument());

    expect((await store.workspace.readWorkspace())!.members.map((m) => m.id)).toEqual([
      "c-m1",
    ]);
    expect((await store.assets.readAssets()).map((a) => a.id)).toEqual(["c-a1"]);
    expect(await store.snapshots.readSnapshots()).toEqual([]);
    expect(await store.snapshots.readSnapshotHoldings()).toEqual([]);
    expect(await store.readTrash()).toEqual({ assets: [], liabilities: [] });
    expect(await store.operations.readAllPriceCacheEntries()).toEqual([]);
    expect(await store.readFireConfig()).toEqual({});
    expect(await store.readWarningOverrides()).toEqual([]);

    store.close();
  });
});
