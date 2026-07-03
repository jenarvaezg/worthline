import type { AssetPrice, NetWorthSnapshot } from "@worthline/domain";
import { EXPORT_VERSION } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

/**
 * Seed a workspace that touches every export section through the public store
 * API: members (incl. one disabled), a group, hand-valued assets, an
 * investment with metadata + operations, a liability tied to an asset, a
 * warning override, FIRE config, a snapshot with holdings, trashed holdings
 * (incl. a trashed investment), and price-cache entries.
 */
async function seedFullWorkspace(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    groups: [{ id: "g1", memberIds: ["m1", "m2"], name: "Familia" }],
    members: [
      { id: "m1", name: "Alice" },
      { id: "m2", name: "Bob" },
    ],
    mode: "household",
  });
  await store.workspace.createMember({ id: "m3", name: "Carol" });
  await store.workspace.disableMember("m3", "2026-01-15T00:00:00.000Z");

  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 500000,
    id: "a_cash",
    liquidityTier: "cash",
    name: "Cuenta ING",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
    type: "cash",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 30000000,
    id: "a_home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Piso Madrid",
    ownership: [
      { memberId: "m1", shareBps: 5000 },
      { memberId: "m2", shareBps: 5000 },
    ],
    type: "real_estate",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "a_inv",
    isin: "IE00BK5BQT80",
    manualPricePerUnit: "105.5",
    name: "Fondo Indexado",
    ownership: [
      { memberId: "m1", shareBps: 5000 },
      { memberId: "m2", shareBps: 5000 },
    ],
    priceProvider: "stooq",
    providerSymbol: "VWCE.DE",
    unitSymbol: "VWCE",
  });
  await store.operations.recordOperation({
    assetId: "a_inv",
    currency: "EUR",
    executedAt: "2026-01-10T00:00:00.000Z",
    feesMinor: 150,
    id: "op1",
    kind: "buy",
    pricePerUnit: "100",
    units: "10",
  });

  await store.liabilities.createLiability({
    associatedAssetId: "a_home",
    balanceMinor: 12000000,
    currency: "EUR",
    id: "l_mort",
    name: "Hipoteca",
    ownership: [
      { memberId: "m1", shareBps: 5000 },
      { memberId: "m2", shareBps: 5000 },
    ],
    type: "mortgage",
  });

  await store.acknowledgeWarning("primary_residence_owned", "a_home");
  await store.saveFireConfig("m1", {
    expectedRealReturn: 0.07,
    monthlySpendingMinor: 200000,
    safeWithdrawalRate: 0.04,
  });

  // Five self-consistent figures under the #181 row-derivation rules: the
  // mortgage row is frozen securesHousing → it is a HOUSING debt, so it nets
  // against housing equity (0 housing assets − 120000 = −120000) and never
  // against liquid (liquid = cash 500000 + market 105500 = 605500). The earlier
  // fixture subtracted the mortgage from liquid while also marking it
  // securesHousing, which the saveSnapshot reconcile backstop (#185) correctly
  // rejects; total/gross/debts are unchanged.
  const snapshot: NetWorthSnapshot = {
    capturedAt: "2026-02-01T10:00:00.000Z",
    dateKey: "2026-02-01",
    debts: { amountMinor: 120000, currency: "EUR" },
    grossAssets: { amountMinor: 605500, currency: "EUR" },
    housingEquity: { amountMinor: -120000, currency: "EUR" },
    id: "snap1",
    isMonthlyClose: true,
    liquidNetWorth: { amountMinor: 605500, currency: "EUR" },
    monthKey: "2026-02",
    scopeId: "m1",
    scopeLabel: "Alice",
    totalNetWorth: { amountMinor: 485500, currency: "EUR" },
    warnings: [],
  };
  await store.snapshots.saveSnapshot({
    holdings: [
      {
        countsAsHousing: false,
        holdingId: "a_cash",
        kind: "asset",
        label: "Cuenta ING",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 500000,
      },
      {
        countsAsHousing: false,
        holdingId: "a_inv",
        kind: "asset",
        label: "Fondo Indexado",
        liquidityTier: "market",
        securesHousing: false,
        unitPrice: "105.5",
        units: "10",
        valueMinor: 105500,
      },
      {
        countsAsHousing: false,
        holdingId: "l_mort",
        kind: "liability",
        label: "Hipoteca",
        liquidityTier: null,
        // The frozen housing-securing signal round-trips through export/import (#180).
        securesHousing: true,
        valueMinor: 120000,
      },
    ],
    snapshot,
  });

  // A trashed hand-valued asset, a trashed investment (metadata + operations
  // must survive in the export), and a trashed liability.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 75000,
    id: "a_old",
    liquidityTier: "illiquid",
    name: "Coche viejo",
    ownership: [{ memberId: "m2", shareBps: 10000 }],
    type: "manual",
  });
  await store.assets.softDeleteAsset("a_old", "2026-03-01T00:00:00.000Z");

  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "a_inv2",
    name: "Cripto vieja",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
    unitSymbol: "BTC",
  });
  await store.operations.recordOperation({
    assetId: "a_inv2",
    currency: "EUR",
    executedAt: "2026-02-20T00:00:00.000Z",
    id: "op2",
    kind: "buy",
    pricePerUnit: "50000",
    units: "0.1",
  });
  await store.assets.softDeleteAsset("a_inv2", "2026-04-01T00:00:00.000Z");

  await store.liabilities.createLiability({
    balanceMinor: 30000,
    currency: "EUR",
    id: "l_old",
    name: "Préstamo viejo",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
    type: "debt",
  });
  await store.liabilities.softDeleteLiability("l_old", "2026-04-02T00:00:00.000Z");

  await store.operations.upsertPrice({
    assetId: "a_inv",
    currency: "EUR",
    fetchedAt: "2026-06-10T18:00:00.000Z",
    freshnessState: "fresh",
    price: "106.20",
    priceDate: "2026-06-10",
    source: "stooq",
  });
  await store.operations.upsertPrice({
    assetId: "a_inv2",
    currency: "EUR",
    fetchedAt: "2026-05-01T00:00:00.000Z",
    freshnessState: "stale",
    price: "48000",
    source: "manual",
    staleReason: "price older than its source TTL",
  });
}

describe("exportWorkspace", () => {
  test("captures every section of the workspace", async () => {
    const store = await createInMemoryStore();
    await seedFullWorkspace(store);

    const doc = await store.workspace.exportWorkspace();

    expect(doc.version).toBe(EXPORT_VERSION);
    expect(doc.workspace).toEqual({ baseCurrency: "EUR", mode: "household" });

    // Members: all three, the disabled one carrying disabledAt.
    expect(doc.members.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(doc.members[2]).toEqual({
      disabledAt: "2026-01-15T00:00:00.000Z",
      id: "m3",
      name: "Carol",
    });
    expect("disabledAt" in doc.members[0]!).toBe(false);

    expect(doc.groups).toEqual([{ id: "g1", memberIds: ["m1", "m2"], name: "Familia" }]);

    // Live assets only — trashed ones must not appear here.
    expect(doc.assets.map((a) => a.id)).toEqual(["a_cash", "a_home", "a_inv"]);

    const cash = doc.assets.find((a) => a.id === "a_cash")!;
    expect(cash).toStrictEqual({
      currency: "EUR",
      currentValue: { amountMinor: 500000, currency: "EUR" },
      id: "a_cash",
      instrument: "current_account",
      isPrimaryResidence: false,
      liquidityTier: "cash",
      name: "Cuenta ING",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      type: "cash",
      valuationMethod: "stored",
    });

    const home = doc.assets.find((a) => a.id === "a_home")!;
    expect(home.isPrimaryResidence).toBe(true);
    expect(home.currentValue).toEqual({ amountMinor: 30000000, currency: "EUR" });

    // Investments: no currentValue (derived, ADR 0006), metadata nested.
    const inv = doc.assets.find((a) => a.id === "a_inv")!;
    expect("currentValue" in inv).toBe(false);
    expect(inv.investment).toBeDefined();
    expect(inv.investment!.unitSymbol).toBe("VWCE");
    expect(inv.investment!.isin).toBe("IE00BK5BQT80");
    expect(inv.investment!.priceProvider).toBe("stooq");
    expect(inv.investment!.providerSymbol).toBe("VWCE.DE");
    expect(inv.investment!.manualPricePerUnit).toBe("105.5");
    expect(typeof inv.investment!.manualPricedAt).toBe("string");

    // Liabilities: live only, associatedAssetId carried when set.
    expect(doc.liabilities.map((l) => l.id)).toEqual(["l_mort"]);
    expect(doc.liabilities[0]).toStrictEqual({
      associatedAssetId: "a_home",
      currency: "EUR",
      currentBalance: { amountMinor: 12000000, currency: "EUR" },
      id: "l_mort",
      instrument: "mortgage",
      name: "Hipoteca",
      ownership: [
        { memberId: "m1", shareBps: 5000 },
        { memberId: "m2", shareBps: 5000 },
      ],
      type: "mortgage",
      // No debt model declared in the seed, so the method defaults to stored.
      valuationMethod: "stored",
    });

    // Operations for ALL investments — including the trashed one.
    expect(doc.operations.map((op) => op.id).sort()).toEqual(["op1", "op2"]);
    expect(doc.operations.find((op) => op.id === "op1")).toEqual({
      assetId: "a_inv",
      currency: "EUR",
      executedAt: "2026-01-10T00:00:00.000Z",
      feesMinor: 150,
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    expect(doc.warningOverrides).toEqual([
      { code: "primary_residence_owned", entityId: "a_home" },
    ]);
    expect(doc.fireConfig).toEqual({
      m1: {
        expectedRealReturn: 0.07,
        monthlySpendingMinor: 200000,
        safeWithdrawalRate: 0.04,
      },
    });

    // Snapshots: full NetWorthSnapshot shape plus holdings in insertion order.
    expect(doc.snapshots).toHaveLength(1);
    const snap = doc.snapshots[0]!;
    expect(snap.id).toBe("snap1");
    expect(snap.scopeId).toBe("m1");
    expect(snap.scopeLabel).toBe("Alice");
    expect(snap.capturedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(snap.dateKey).toBe("2026-02-01");
    expect(snap.monthKey).toBe("2026-02");
    // The declared isMonthlyClose flag is retired (ADR 0005): saveSnapshot no
    // longer carries it (the store writes a constant 0; the monthly close is
    // DERIVED as the last snapshot of the month), so a captured snapshot reads
    // back false regardless of what the caller declared (#185).
    expect(snap.isMonthlyClose).toBe(false);
    expect(snap.totalNetWorth).toEqual({ amountMinor: 485500, currency: "EUR" });
    expect(snap.grossAssets).toEqual({ amountMinor: 605500, currency: "EUR" });
    expect(snap.debts).toEqual({ amountMinor: 120000, currency: "EUR" });
    expect(snap.warnings).toEqual([]);
    expect(snap.holdings).toStrictEqual([
      {
        countsAsHousing: false,
        holdingId: "a_cash",
        kind: "asset",
        label: "Cuenta ING",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: 500000,
      },
      {
        countsAsHousing: false,
        holdingId: "a_inv",
        kind: "asset",
        label: "Fondo Indexado",
        liquidityTier: "market",
        securesHousing: false,
        unitPrice: "105.5",
        units: "10",
        valueMinor: 105500,
      },
      {
        countsAsHousing: false,
        holdingId: "l_mort",
        kind: "liability",
        label: "Hipoteca",
        liquidityTier: null,
        securesHousing: true,
        valueMinor: 120000,
      },
    ]);

    // Trash: soft-deleted holdings in full shape with deletedAt.
    expect(doc.trash.assets.map((a) => a.id).sort()).toEqual(["a_inv2", "a_old"]);
    const trashedManual = doc.trash.assets.find((a) => a.id === "a_old")!;
    expect(trashedManual.deletedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(trashedManual.currentValue).toEqual({ amountMinor: 75000, currency: "EUR" });

    const trashedInvestment = doc.trash.assets.find((a) => a.id === "a_inv2")!;
    expect(trashedInvestment.deletedAt).toBe("2026-04-01T00:00:00.000Z");
    expect("currentValue" in trashedInvestment).toBe(false);
    expect(trashedInvestment.investment).toEqual({ unitSymbol: "BTC" });

    expect(doc.trash.liabilities).toHaveLength(1);
    expect(doc.trash.liabilities[0]!.id).toBe("l_old");
    expect(doc.trash.liabilities[0]!.deletedAt).toBe("2026-04-02T00:00:00.000Z");

    // Price cache rows verbatim, freshness fields preserved, optionals omitted.
    expect(doc.priceCache).toHaveLength(2);
    const freshPrice = doc.priceCache.find((p) => p.assetId === "a_inv")!;
    expect(freshPrice).toStrictEqual({
      assetId: "a_inv",
      currency: "EUR",
      fetchedAt: "2026-06-10T18:00:00.000Z",
      freshnessState: "fresh",
      price: "106.20",
      priceDate: "2026-06-10",
      source: "stooq",
    } satisfies AssetPrice);
    const stalePrice = doc.priceCache.find((p) => p.assetId === "a_inv2")!;
    expect(stalePrice.staleReason).toBe("price older than its source TTL");
    expect("priceDate" in stalePrice).toBe(false);

    // The audit log is deliberately NOT a section.
    expect(Object.keys(doc)).not.toContain("audit");
    expect(Object.keys(doc)).not.toContain("auditLog");

    store.close();
  });

  test("is read-only: no writes, stable across repeated exports", async () => {
    const store = await createInMemoryStore();
    await seedFullWorkspace(store);

    const auditBefore = await store.readAuditLog();
    const assetsBefore = await store.assets.readAssets();
    const liabilitiesBefore = await store.liabilities.readLiabilities();
    const snapshotsBefore = await store.snapshots.readSnapshots();
    const pricesBefore = await store.operations.readAllPriceCacheEntries();

    const first = await store.workspace.exportWorkspace();
    const second = await store.workspace.exportWorkspace();

    expect(second).toEqual(first);
    expect(await store.readAuditLog()).toEqual(auditBefore);
    expect(await store.assets.readAssets()).toEqual(assetsBefore);
    expect(await store.liabilities.readLiabilities()).toEqual(liabilitiesBefore);
    expect(await store.snapshots.readSnapshots()).toEqual(snapshotsBefore);
    expect(await store.operations.readAllPriceCacheEntries()).toEqual(pricesBefore);

    store.close();
  });
});

/**
 * Seed a workspace whose holdings carry full structure (#155): an appreciating
 * property (appreciation rate + market-appraisal & improvement anchors) and an
 * amortized mortgage (amortization plan + an interest-rate revision + an early
 * repayment). This is the exact shape that the lossy v1 format silently flattened.
 */
async function seedStructuredWorkspace(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Alice" }],
    mode: "individual",
  });
  const own = [{ memberId: "m1", shareBps: 10000 }];

  // Appreciating property.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 30000000,
    id: "a_home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Piso Madrid",
    ownership: own,
    type: "real_estate",
  });
  await store.assets.setAnnualAppreciationRate("a_home", "0.03");
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId: "a_home",
    id: "anchor1",
    valuationDate: "2024-01-01",
    valueMinor: 28000000,
  });
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: false,
    assetId: "a_home",
    id: "anchor2",
    valuationDate: "2025-06-01",
    valueMinor: 1500000,
  });

  // Amortized mortgage with a rate revision and an early repayment.
  await store.liabilities.createLiability({
    associatedAssetId: "a_home",
    balanceMinor: 12000000,
    currency: "EUR",
    id: "l_mort",
    name: "Hipoteca",
    ownership: own,
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("l_mort", "amortizable");
  await store.liabilities.createAmortizationPlan({
    annualInterestRate: "0.025",
    id: "plan1",
    initialCapitalMinor: 15000000,
    liabilityId: "l_mort",
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
    originalSigningDate: "2004-03-01",
    termMonths: 360,
  });
  await store.liabilities.addInterestRateRevision({
    id: "rev1",
    newAnnualInterestRate: "0.031",
    planId: "plan1",
    revisionDate: "2023-01-01",
  });
  await store.liabilities.addEarlyRepayment({
    amountMinor: 2000000,
    id: "rep1",
    mode: "reduce-term",
    planId: "plan1",
    repaymentDate: "2024-07-01",
  });
  await store.liabilities.addBalanceRebaseline({
    annualInterestRate: "0.02",
    baselineDate: "2025-01-01",
    endDate: "2030-01-01",
    id: "reb1",
    liabilityId: "l_mort",
    nextPaymentDate: "2025-02-01",
    outstandingBalanceMinor: 11000000,
  });

  // Revolving line of credit with two balance anchors on distinct dates.
  // This is the AC#1 element that was previously un-exercised in the round-trip.
  await store.liabilities.createLiability({
    balanceMinor: 500000,
    currency: "EUR",
    id: "l_revol",
    name: "Línea de crédito",
    ownership: own,
    type: "debt",
  });
  await store.liabilities.setDebtModel("l_revol", "revolving");
  await store.liabilities.addBalanceAnchor({
    anchorDate: "2023-06-01",
    balanceMinor: 800000,
    id: "banc1",
    liabilityId: "l_revol",
  });
  await store.liabilities.addBalanceAnchor({
    anchorDate: "2024-06-01",
    balanceMinor: 600000,
    id: "banc2",
    liabilityId: "l_revol",
  });
}

describe("full holding model round-trips through export/import (#155)", () => {
  test("an appreciating property and an amortized debt survive export→import with curve and schedule intact (NOT flattened)", async () => {
    const source = await createInMemoryStore();
    await seedStructuredWorkspace(source);

    // Pre-export structure and derived history (the curve/schedule).
    const homeRateBefore = await source.assets.readAnnualAppreciationRate("a_home");
    const anchorsBefore = await source.assets.readValuationAnchors("a_home");
    const debtModelBefore = await source.liabilities.readDebtModel("l_mort");
    const planBefore = await source.liabilities.readAmortizationPlan("l_mort");
    // The optional original-signing-date metadata (ADR 0056, #677 review M2)
    // must survive the round-trip too — not silently dropped by export/import.
    expect(planBefore?.originalSigningDate).toBe("2004-03-01");
    const rebaselinesBefore = await source.liabilities.readBalanceRebaselines("l_mort");
    const revisionsBefore = await source.liabilities.readInterestRateRevisions("plan1");
    const repaymentsBefore = await source.liabilities.readEarlyRepayments("plan1");

    // Two sampling dates exercise both the housing curve and the loan schedule.
    const homeValueBefore = await source.assets.valueHousingAtDate(
      "a_home",
      "2025-01-01",
      "2026-06-14",
    );
    const debtBalanceBefore = await source.liabilities.debtBalanceAtDate(
      "l_mort",
      "2025-01-01",
    );
    // Gap 4 fix: sample just BEFORE and just AFTER the 2024-07-01 early repayment.
    // The repayment reduces principal by ~2 000 000 — a dropped repayment would
    // make both samples equal (no step), so asserting the drop proves survival.
    const debtJustBeforeRepayment = await source.liabilities.debtBalanceAtDate(
      "l_mort",
      "2024-06-30",
    );
    const debtJustAfterRepayment = await source.liabilities.debtBalanceAtDate(
      "l_mort",
      "2024-07-02",
    );
    // Sanity: the repayment must produce a visible drop before we rely on it.
    expect(debtJustBeforeRepayment).toBeGreaterThan(debtJustAfterRepayment);

    const doc = await source.workspace.exportWorkspace();

    // Import into a fresh store — the real full-replace path.
    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);

    // Structure restored faithfully.
    expect(await restored.assets.readAnnualAppreciationRate("a_home")).toEqual(
      homeRateBefore,
    );
    expect(await restored.assets.readValuationAnchors("a_home")).toEqual(anchorsBefore);
    expect(await restored.liabilities.readDebtModel("l_mort")).toEqual(debtModelBefore);
    expect(await restored.liabilities.readAmortizationPlan("l_mort")).toEqual(planBefore);
    expect(await restored.liabilities.readBalanceRebaselines("l_mort")).toEqual(
      rebaselinesBefore,
    );
    expect(await restored.liabilities.readInterestRateRevisions("plan1")).toEqual(
      revisionsBefore,
    );
    expect(await restored.liabilities.readEarlyRepayments("plan1")).toEqual(
      repaymentsBefore,
    );

    // History matches pre-export — the curve/schedule is intact, NOT flattened.
    expect(
      await restored.assets.valueHousingAtDate("a_home", "2025-01-01", "2026-06-14"),
    ).toBe(homeValueBefore);
    expect(await restored.liabilities.debtBalanceAtDate("l_mort", "2025-01-01")).toBe(
      debtBalanceBefore,
    );
    // The repayment step is preserved: the before/after drop must match source.
    // A dropped early repayment would collapse this to zero difference.
    expect(await restored.liabilities.debtBalanceAtDate("l_mort", "2024-06-30")).toBe(
      debtJustBeforeRepayment,
    );
    expect(await restored.liabilities.debtBalanceAtDate("l_mort", "2024-07-02")).toBe(
      debtJustAfterRepayment,
    );

    // The flat-line regression guard: a structured debt's balance on a past date
    // must NOT equal its stored current balance (that is exactly the v1 bug).
    expect(await restored.liabilities.debtBalanceAtDate("l_mort", "2025-01-01")).not.toBe(
      12000000,
    );

    source.close();
    restored.close();
  });

  test("a revolving debt with balance anchors survives export→import with anchored curve intact (AC#1 balance-anchor round-trip)", async () => {
    const source = await createInMemoryStore();
    await seedStructuredWorkspace(source);

    // Pre-export balance anchors and derived curve.
    const anchorsBefore = await source.liabilities.readBalanceAnchors("l_revol");
    const debtModelBefore = await source.liabilities.readDebtModel("l_revol");

    // Sample a date between the two anchors — the interpolated/stepped value
    // must survive round-trip. Using the anchor store means a dropped insert
    // causes the balance to fall back to the stored currentBalance (500000).
    const balanceBetweenAnchorsBefore = await source.liabilities.debtBalanceAtDate(
      "l_revol",
      "2024-01-01",
    );
    // Must differ from stored currentBalance to prove the anchor curve is live.
    expect(balanceBetweenAnchorsBefore).not.toBe(500000);

    const doc = await source.workspace.exportWorkspace();

    // Import into a fresh store.
    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);

    // Anchors restored faithfully (rows identical, incl. ids).
    expect(await restored.liabilities.readBalanceAnchors("l_revol")).toEqual(
      anchorsBefore,
    );
    expect(await restored.liabilities.readDebtModel("l_revol")).toEqual(debtModelBefore);

    // The interpolated curve matches pre-export — not flattened to currentBalance.
    expect(await restored.liabilities.debtBalanceAtDate("l_revol", "2024-01-01")).toBe(
      balanceBetweenAnchorsBefore,
    );

    source.close();
    restored.close();
  });

  test("re-exporting after import reproduces the same structured document (idempotent)", async () => {
    const source = await createInMemoryStore();
    await seedStructuredWorkspace(source);

    const doc = await source.workspace.exportWorkspace();
    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);

    expect(await restored.workspace.exportWorkspace()).toEqual(doc);

    source.close();
    restored.close();
  });
});

describe("valuation cadence round-trips through export/import (#395, ADR 0031)", () => {
  test("export carries an interpolated cadence and import restores it; the step default round-trips omitted", async () => {
    const source = await createInMemoryStore();
    await seedStructuredWorkspace(source);

    // Opt two holdings out to interpolated; leave the revolving line at the step default.
    await source.assets.setValuationCadence("a_home", "interpolated");
    await source.liabilities.setValuationCadence("l_mort", "interpolated");
    // l_revol stays at the default (null = step).

    const doc = await source.workspace.exportWorkspace();
    const home = doc.assets.find((a) => a.id === "a_home")!;
    const mort = doc.liabilities.find((l) => l.id === "l_mort")!;
    const revol = doc.liabilities.find((l) => l.id === "l_revol")!;
    // Interpolated holdings carry the field as part of their model; the step
    // default is omitted (it round-trips as step without being written).
    expect(home.valuationCadence).toBe("interpolated");
    expect(mort.valuationCadence).toBe("interpolated");
    expect(revol.valuationCadence).toBeUndefined();

    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);
    expect(await restored.assets.readValuationCadence("a_home")).toBe("interpolated");
    expect(await restored.liabilities.readValuationCadence("l_mort")).toBe(
      "interpolated",
    );
    // The omitted cadence imports as the step default (null).
    expect(await restored.liabilities.readValuationCadence("l_revol")).toBeNull();

    source.close();
    restored.close();
  });

  test("an older export without the field imports as step (backward compatible)", async () => {
    const source = await createInMemoryStore();
    await seedStructuredWorkspace(source);
    await source.assets.setValuationCadence("a_home", "interpolated");

    // Simulate a pre-#395 file: a deep clone with the cadence field stripped from
    // every holding, mirroring a document exported before the field existed.
    const doc = await source.workspace.exportWorkspace();
    const legacy = JSON.parse(JSON.stringify(doc)) as typeof doc;
    for (const a of legacy.assets)
      delete (a as { valuationCadence?: unknown }).valuationCadence;
    for (const l of legacy.liabilities)
      delete (l as { valuationCadence?: unknown }).valuationCadence;

    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(legacy);
    // Every holding reads back as step (null), with no error.
    expect(await restored.assets.readValuationCadence("a_home")).toBeNull();
    expect(await restored.liabilities.readValuationCadence("l_mort")).toBeNull();

    source.close();
    restored.close();
  });

  test("an explicit step is omitted on export and round-trips as the default (canonical)", async () => {
    const source = await createInMemoryStore();
    await seedStructuredWorkspace(source);
    // A user explicitly choosing "Escalonado" stores "step" in the column; the
    // export must still omit it (only `interpolated` is the non-default worth carrying).
    await source.assets.setValuationCadence("a_home", "step");

    const doc = await source.workspace.exportWorkspace();
    const home = doc.assets.find((a) => a.id === "a_home")!;
    expect(home.valuationCadence).toBeUndefined();

    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);
    expect(await restored.assets.readValuationCadence("a_home")).toBeNull();

    source.close();
    restored.close();
  });
});

describe("instrument round-trips through export/import (#149)", () => {
  test("export carries each holding's instrument and import restores it", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Alice" }],
      mode: "individual",
    });
    const own = [{ memberId: "m1", shareBps: 10000 }];
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30000000,
      id: "a_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: own,
      type: "real_estate",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200000,
      id: "a_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: own,
      type: "cash",
    });
    await store.liabilities.createLiability({
      associatedAssetId: "a_home",
      balanceMinor: 10000000,
      currency: "EUR",
      id: "l_mort",
      name: "Hipoteca",
      ownership: own,
      type: "mortgage",
    });
    await store.liabilities.createLiability({
      balanceMinor: 5000,
      currency: "EUR",
      id: "l_card",
      name: "Tarjeta",
      ownership: own,
      type: "debt",
    });

    const doc = await store.workspace.exportWorkspace();
    const assetInstrument = (id: string) =>
      doc.assets.find((a) => a.id === id)?.instrument;
    const liabilityInstrument = (id: string) =>
      doc.liabilities.find((l) => l.id === id)?.instrument;

    expect(assetInstrument("a_home")).toBe("property");
    expect(assetInstrument("a_cash")).toBe("current_account");
    expect(liabilityInstrument("l_mort")).toBe("mortgage");
    expect(liabilityInstrument("l_card")).toBe("loan");

    // Import into a fresh store and re-export: the instruments survive intact.
    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);
    const doc2 = await restored.workspace.exportWorkspace();

    expect(doc2.assets.find((a) => a.id === "a_home")?.instrument).toBe("property");
    expect(doc2.assets.find((a) => a.id === "a_cash")?.instrument).toBe(
      "current_account",
    );
    expect(doc2.liabilities.find((l) => l.id === "l_mort")?.instrument).toBe("mortgage");

    store.close();
    restored.close();
  });
});

describe("countsAsHousing round-trips through export/import (#181)", () => {
  test("a housing asset's frozen countsAsHousing survives export→import (not reset to false)", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Alice" }],
      mode: "individual",
    });

    // A snapshot whose only holding is a housing asset frozen as countsAsHousing.
    // housingEquity equals that asset's value; liquid is zero (illiquid housing) —
    // a self-consistent five-figure snapshot under the #181 row-derivation rules.
    const snapshot: NetWorthSnapshot = {
      capturedAt: "2026-02-01T10:00:00.000Z",
      dateKey: "2026-02-01",
      debts: { amountMinor: 0, currency: "EUR" },
      grossAssets: { amountMinor: 30000000, currency: "EUR" },
      housingEquity: { amountMinor: 30000000, currency: "EUR" },
      id: "snapH",
      isMonthlyClose: true,
      liquidNetWorth: { amountMinor: 0, currency: "EUR" },
      monthKey: "2026-02",
      scopeId: "m1",
      scopeLabel: "Alice",
      totalNetWorth: { amountMinor: 30000000, currency: "EUR" },
      warnings: [],
    };
    await store.snapshots.saveSnapshot({
      holdings: [
        {
          countsAsHousing: true,
          holdingId: "a_home",
          kind: "asset",
          label: "Piso Madrid",
          liquidityTier: "illiquid",
          securesHousing: false,
          valueMinor: 30000000,
        },
      ],
      snapshot,
    });

    // Export must carry the frozen flag (it was dropped before the export-read fix).
    const doc = await store.workspace.exportWorkspace();
    expect(doc.snapshots[0]!.holdings[0]!.countsAsHousing).toBe(true);

    // A fresh import must persist it (it was reset to the column default before the
    // import-insert fix), so a re-export of the restored store still shows it true.
    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);
    const reDoc = await restored.workspace.exportWorkspace();
    expect(reDoc.snapshots[0]!.holdings[0]!.countsAsHousing).toBe(true);

    store.close();
    restored.close();
  });
});
