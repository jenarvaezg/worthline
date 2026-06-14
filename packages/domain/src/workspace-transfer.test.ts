import { describe, expect, test } from "vitest";

import {
  EXPORT_VERSION,
  serializeWorkspaceExport,
  summarizeWorkspaceExport,
  type WorkspaceExportData,
} from "./workspace-transfer";

function makeExportData(): WorkspaceExportData {
  return {
    workspace: { mode: "household", baseCurrency: "EUR" },
    members: [
      { id: "m1", name: "Alice" },
      { id: "m2", name: "Bob", disabledAt: "2026-05-01T10:00:00.000Z" },
    ],
    groups: [{ id: "g1", name: "Pareja", memberIds: ["m1", "m2"] }],
    assets: [
      {
        id: "a1",
        name: "Cuenta corriente",
        type: "cash",
        currency: "EUR",
        currentValue: { amountMinor: 150000, currency: "EUR" },
        liquidityTier: "cash",
        isPrimaryResidence: false,
        valuationMethod: "stored",
        ownership: [
          { memberId: "m1", shareBps: 5000 },
          { memberId: "m2", shareBps: 5000 },
        ],
      },
      {
        id: "a2",
        name: "Fondo indexado",
        type: "investment",
        currency: "EUR",
        liquidityTier: "market",
        valuationMethod: "derived",
        ownership: [{ memberId: "m1", shareBps: 10000 }],
        investment: {
          unitSymbol: "VWCE",
          isin: "IE00BK5BQT80",
          providerSymbol: "VWCE.DE",
          manualPricePerUnit: "111.42",
          manualPricedAt: "2026-06-01T08:00:00.000Z",
        },
      },
      {
        id: "a3",
        name: "Piso Madrid",
        type: "real_estate",
        currency: "EUR",
        currentValue: { amountMinor: 30000000, currency: "EUR" },
        liquidityTier: "illiquid",
        isPrimaryResidence: true,
        valuationMethod: "appreciating",
        annualAppreciationRate: "0.03",
        valuationAnchors: [
          {
            id: "anchor1",
            valueMinor: 28000000,
            valuationDate: "2024-01-01",
            adjustsPriorCurve: true,
          },
          {
            id: "anchor2",
            valueMinor: 1500000,
            valuationDate: "2025-06-01",
            adjustsPriorCurve: false,
          },
        ],
        ownership: [
          { memberId: "m1", shareBps: 5000 },
          { memberId: "m2", shareBps: 5000 },
        ],
      },
    ],
    liabilities: [
      {
        id: "l1",
        name: "Hipoteca",
        type: "mortgage",
        currency: "EUR",
        currentBalance: { amountMinor: 12000000, currency: "EUR" },
        valuationMethod: "amortized",
        debtModel: "amortizable",
        amortizationPlan: {
          id: "plan1",
          initialCapitalMinor: 15000000,
          annualInterestRate: "0.025",
          termMonths: 360,
          disbursementDate: "2020-01-01",
          firstPaymentDate: "2020-02-01",
          interestRateRevisions: [
            {
              id: "rev1",
              revisionDate: "2023-01-01",
              newAnnualInterestRate: "0.031",
            },
          ],
          earlyRepayments: [
            {
              id: "rep1",
              repaymentDate: "2024-07-01",
              amountMinor: 2000000,
              mode: "reduce-term",
            },
          ],
        },
        ownership: [
          { memberId: "m1", shareBps: 5000 },
          { memberId: "m2", shareBps: 5000 },
        ],
        associatedAssetId: "a3",
      },
      {
        id: "l2",
        name: "Tarjeta revolving",
        type: "debt",
        currency: "EUR",
        currentBalance: { amountMinor: 80000, currency: "EUR" },
        valuationMethod: "anchored",
        debtModel: "revolving",
        balanceAnchors: [
          { id: "banchor1", balanceMinor: 100000, anchorDate: "2025-01-01" },
          { id: "banchor2", balanceMinor: 80000, anchorDate: "2025-06-01" },
        ],
        ownership: [{ memberId: "m1", shareBps: 10000 }],
      },
    ],
    operations: [
      {
        id: "op1",
        assetId: "a2",
        kind: "buy",
        executedAt: "2026-05-15T09:30:00.000Z",
        units: "10.5",
        pricePerUnit: "100.25",
        currency: "EUR",
        feesMinor: 150,
      },
    ],
    warningOverrides: [{ code: "ZERO_VALUE_ASSET", entityId: "a1" }],
    fireConfig: {
      household: {
        monthlySpendingMinor: 250000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.05,
      },
    },
    snapshots: [
      {
        id: "s1",
        scopeId: "household",
        scopeLabel: "Hogar",
        capturedAt: "2026-06-01T20:00:00.000Z",
        dateKey: "2026-06-01",
        monthKey: "2026-06",
        isMonthlyClose: false,
        totalNetWorth: { amountMinor: 130000, currency: "EUR" },
        liquidNetWorth: { amountMinor: 130000, currency: "EUR" },
        housingEquity: { amountMinor: 0, currency: "EUR" },
        grossAssets: { amountMinor: 150000, currency: "EUR" },
        debts: { amountMinor: 20000, currency: "EUR" },
        warnings: [
          {
            code: "ZERO_VALUE_ASSET",
            severity: "overrideable",
            entityType: "asset",
            entityId: "a1",
            message: '"Cuenta corriente" tiene valor 0.',
          },
        ],
        holdings: [
          {
            countsAsHousing: false,
            holdingId: "a1",
            kind: "asset",
            label: "Cuenta corriente",
            liquidityTier: "cash",
            securesHousing: false,
            valueMinor: 150000,
          },
          {
            countsAsHousing: false,
            holdingId: "l1",
            kind: "liability",
            label: "Hipoteca",
            liquidityTier: "cash",
            securesHousing: true,
            valueMinor: 20000,
          },
        ],
      },
    ],
    trash: {
      assets: [
        {
          id: "a9",
          name: "Coche viejo",
          type: "manual",
          currency: "EUR",
          currentValue: { amountMinor: 300000, currency: "EUR" },
          liquidityTier: "illiquid",
          ownership: [{ memberId: "m1", shareBps: 10000 }],
          deletedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
      liabilities: [],
    },
    priceCache: [
      {
        assetId: "a2",
        currency: "EUR",
        price: "111.42",
        source: "stooq",
        priceDate: "2026-06-10",
        fetchedAt: "2026-06-10T18:00:00.000Z",
        freshnessState: "fresh",
      },
    ],
  };
}

describe("serializeWorkspaceExport", () => {
  test("stamps the document with the current export version", () => {
    const doc = serializeWorkspaceExport(makeExportData());

    expect(EXPORT_VERSION).toBe(2);
    expect(doc.version).toBe(EXPORT_VERSION);
  });

  test("carries the full holding model for structured holdings (#155)", () => {
    const data = makeExportData();
    const doc = serializeWorkspaceExport(data);

    // Appreciating property: method + rate + valuation anchors verbatim.
    const home = doc.assets.find((a) => a.id === "a3")!;
    expect(home.valuationMethod).toBe("appreciating");
    expect(home.annualAppreciationRate).toBe("0.03");
    expect(home.valuationAnchors).toEqual([
      {
        id: "anchor1",
        valueMinor: 28000000,
        valuationDate: "2024-01-01",
        adjustsPriorCurve: true,
      },
      {
        id: "anchor2",
        valueMinor: 1500000,
        valuationDate: "2025-06-01",
        adjustsPriorCurve: false,
      },
    ]);

    // Amortized debt: method + model + plan with its revisions and repayments.
    const mortgage = doc.liabilities.find((l) => l.id === "l1")!;
    expect(mortgage.valuationMethod).toBe("amortized");
    expect(mortgage.debtModel).toBe("amortizable");
    expect(mortgage.amortizationPlan).toEqual({
      id: "plan1",
      initialCapitalMinor: 15000000,
      annualInterestRate: "0.025",
      termMonths: 360,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      interestRateRevisions: [
        { id: "rev1", revisionDate: "2023-01-01", newAnnualInterestRate: "0.031" },
      ],
      earlyRepayments: [
        {
          id: "rep1",
          repaymentDate: "2024-07-01",
          amountMinor: 2000000,
          mode: "reduce-term",
        },
      ],
    });

    // Anchored revolving debt: method + model + balance anchors verbatim.
    const card = doc.liabilities.find((l) => l.id === "l2")!;
    expect(card.valuationMethod).toBe("anchored");
    expect(card.debtModel).toBe("revolving");
    expect(card.balanceAnchors).toEqual([
      { id: "banchor1", balanceMinor: 100000, anchorDate: "2025-01-01" },
      { id: "banchor2", balanceMinor: 80000, anchorDate: "2025-06-01" },
    ]);
  });

  test("carries every section of the workspace verbatim", () => {
    const data = makeExportData();
    const doc = serializeWorkspaceExport(data);

    expect(doc.workspace).toEqual(data.workspace);
    expect(doc.members).toEqual(data.members);
    expect(doc.groups).toEqual(data.groups);
    expect(doc.assets).toEqual(data.assets);
    expect(doc.liabilities).toEqual(data.liabilities);
    expect(doc.operations).toEqual(data.operations);
    expect(doc.warningOverrides).toEqual(data.warningOverrides);
    expect(doc.fireConfig).toEqual(data.fireConfig);
    expect(doc.snapshots).toEqual(data.snapshots);
    expect(doc.trash).toEqual(data.trash);
    expect(doc.priceCache).toEqual(data.priceCache);
  });

  test("does not mutate its input and returns a fresh document", () => {
    const data = makeExportData();
    const before = JSON.parse(JSON.stringify(data));

    const doc = serializeWorkspaceExport(data);

    expect(data).toEqual(before);
    expect(doc).not.toBe(data);
  });

  test("preserves price-cache freshness fields verbatim, including failure detail", () => {
    const data = makeExportData();
    data.priceCache = [
      {
        assetId: "a2",
        currency: "EUR",
        price: "98.10",
        source: "coingecko",
        fetchedAt: "2026-06-09T18:00:00.000Z",
        freshnessState: "failed",
        staleReason: "provider_unreachable",
      },
    ];

    const doc = serializeWorkspaceExport(data);

    expect(doc.priceCache).toEqual([
      {
        assetId: "a2",
        currency: "EUR",
        price: "98.10",
        source: "coingecko",
        fetchedAt: "2026-06-09T18:00:00.000Z",
        freshnessState: "failed",
        staleReason: "provider_unreachable",
      },
    ]);
  });

  test("the document round-trips through JSON unchanged (human-readable text contract)", () => {
    const doc = serializeWorkspaceExport(makeExportData());

    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  test("an export document has no audit-log section", () => {
    const doc = serializeWorkspaceExport(makeExportData());

    expect("auditLog" in doc).toBe(false);
    expect("audit_log" in doc).toBe(false);
  });
});

describe("summarizeWorkspaceExport", () => {
  test("counts every section of a rich document exactly", () => {
    const doc = serializeWorkspaceExport(makeExportData());

    expect(summarizeWorkspaceExport(doc)).toEqual({
      members: 2,
      groups: 1,
      assets: 3,
      liabilities: 2,
      operations: 1,
      snapshots: 1,
      trashedAssets: 1,
      trashedLiabilities: 0,
      warningOverrides: 1,
      priceCacheEntries: 1,
      fireConfigScopes: 1,
    });
  });

  test("a minimal live-state-only document yields zeros for absent sections", () => {
    const doc = serializeWorkspaceExport({
      workspace: { mode: "individual", baseCurrency: "EUR" },
      members: [{ id: "m1", name: "Solo" }],
      groups: [],
      assets: [],
      liabilities: [],
      operations: [],
      warningOverrides: [],
      fireConfig: {},
      snapshots: [],
      trash: { assets: [], liabilities: [] },
      priceCache: [],
    });

    expect(summarizeWorkspaceExport(doc)).toEqual({
      members: 1,
      groups: 0,
      assets: 0,
      liabilities: 0,
      operations: 0,
      snapshots: 0,
      trashedAssets: 0,
      trashedLiabilities: 0,
      warningOverrides: 0,
      priceCacheEntries: 0,
      fireConfigScopes: 0,
    });
  });
});
