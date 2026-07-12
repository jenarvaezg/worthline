import type { WorthlineStore } from "@db/index";

import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-12";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "matched_fund",
    isin: "ES00WL000001",
    liquidityTier: "market",
    name: "Fondo existente",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  await store.recordOperationAndRipple(
    {
      assetId: "matched_fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      feesMinor: 0,
      id: "op_existing",
      kind: "buy",
      pricePerUnit: "100",
      units: "1",
    },
    { today: TODAY },
  );
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("applyStatementImportAndRipple (ADR 0055)", () => {
  test("creates new funds, merges matched funds, and ripples from the earliest selected operation", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.applyStatementImportAndRipple({
      funds: [
        {
          asset: {
            currency: "EUR",
            id: "new_fund",
            isin: "LU00WL000002",
            liquidityTier: "market",
            name: "Fondo nuevo",
            ownership: [{ memberId: "mJ", shareBps: 10_000 }],
            providerSymbol: "NUEVO.FAKE",
          },
          creates: [
            {
              assetId: "new_fund",
              currency: "EUR",
              executedAt: "2024-01-10",
              feesMinor: 0,
              id: "op_new_jan",
              kind: "buy",
              pricePerUnit: "50",
              units: "12",
            },
          ],
          kind: "new",
        },
        {
          assetId: "matched_fund",
          creates: [],
          kind: "matched",
          overwrites: [
            {
              currency: "EUR",
              feesMinor: 0,
              id: "op_existing",
              kind: "buy",
              pricePerUnit: "100",
              units: "5",
            },
          ],
        },
      ],
      today: TODAY,
    });

    expect(await store.assets.readInvestmentAssetById("new_fund")).toMatchObject({
      isin: "LU00WL000002",
      providerSymbol: "NUEVO.FAKE",
    });
    expect(await store.operations.readOperations("matched_fund")).toMatchObject([
      { id: "op_existing", units: "5" },
    ]);
    expect(await grossAt(store, "2024-01-10")).toBe(12 * 50_00);
    expect(await grossAt(store, "2024-03-01")).toBe(12 * 50_00 + 5 * 100_00);
    store.close();
  });

  test("folds every fund of the import into each snapshot in one pass (shared dates chain)", async () => {
    // The ripple runs ONCE for the whole import (not once per fund): every
    // affected asset chains through each snapshot in memory and persists once.
    // A date shared by two funds is the regression trap — both rows must land
    // on the same snapshot.
    const store = await createInMemoryStore();
    await seed(store);

    await store.applyStatementImportAndRipple({
      funds: [
        {
          asset: {
            currency: "EUR",
            id: "fund_a",
            isin: "LU00WL000003",
            liquidityTier: "market",
            name: "Fondo A",
            ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          },
          creates: [
            {
              assetId: "fund_a",
              currency: "EUR",
              executedAt: "2024-01-10",
              feesMinor: 0,
              id: "op_a_jan",
              kind: "buy",
              pricePerUnit: "50",
              units: "12",
            },
            {
              assetId: "fund_a",
              currency: "EUR",
              executedAt: "2024-02-20",
              feesMinor: 0,
              id: "op_a_feb",
              kind: "buy",
              pricePerUnit: "50",
              units: "2",
            },
          ],
          kind: "new",
        },
        {
          asset: {
            currency: "EUR",
            id: "fund_b",
            isin: "LU00WL000004",
            liquidityTier: "market",
            name: "Fondo B",
            ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          },
          creates: [
            {
              assetId: "fund_b",
              currency: "EUR",
              executedAt: "2024-02-20",
              feesMinor: 0,
              id: "op_b_feb",
              kind: "buy",
              pricePerUnit: "10",
              units: "10",
            },
          ],
          kind: "new",
        },
      ],
      today: TODAY,
    });

    // 2024-01-10: only A's first buy (the matched fund's op is later).
    expect(await grossAt(store, "2024-01-10")).toBe(12 * 50_00);
    // 2024-02-20: A folded to 14 units AND B's buy on the SAME snapshot.
    expect(await grossAt(store, "2024-02-20")).toBe(14 * 50_00 + 10 * 10_00);
    // 2024-03-01 (pre-existing snapshot): both new funds folded in plus the
    // matched fund's own 1×100.
    expect(await grossAt(store, "2024-03-01")).toBe(14 * 50_00 + 10 * 10_00 + 100_00);
    store.close();
  });

  test("rolls back creations and merges when any operation in the confirmed selection fails", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await expect(
      store.applyStatementImportAndRipple({
        funds: [
          {
            assetId: "matched_fund",
            creates: [],
            kind: "matched",
            overwrites: [
              {
                currency: "EUR",
                feesMinor: 0,
                id: "op_existing",
                kind: "buy",
                pricePerUnit: "100",
                units: "5",
              },
            ],
          },
          {
            asset: {
              currency: "EUR",
              id: "new_fund",
              isin: "LU00WL000002",
              liquidityTier: "market",
              name: "Fondo nuevo",
              ownership: [{ memberId: "mJ", shareBps: 10_000 }],
            },
            creates: [
              {
                assetId: "new_fund",
                currency: "EUR",
                executedAt: "2024-01-10",
                feesMinor: 0,
                id: "op_existing",
                kind: "buy",
                pricePerUnit: "50",
                units: "12",
              },
            ],
            kind: "new",
          },
        ],
        today: TODAY,
      }),
    ).rejects.toThrow();

    expect(await store.assets.readInvestmentAssetById("new_fund")).toBeNull();
    expect(await store.operations.readOperations("matched_fund")).toMatchObject([
      { id: "op_existing", units: "1" },
    ]);
    expect(await grossAt(store, "2024-01-10")).toBeUndefined();
    expect(await grossAt(store, "2024-03-01")).toBe(1 * 100_00);
    store.close();
  });

  test("applies investment, debt, and housing facts atomically through one mixed ripple", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.createHousingHoldingAndRipple(
      {
        acquisitionAnchor: {
          adjustsPriorCurve: true,
          assetId: "home",
          id: "home_acquisition",
          valuationDate: "2024-01-01",
          valueMinor: 200_000_00,
        },
        annualAppreciationRate: null,
        asset: {
          currency: "EUR",
          currentValueMinor: 200_000_00,
          id: "home",
          liquidityTier: "illiquid",
          name: "Vivienda",
          ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          type: "real_estate",
        },
      },
      { today: TODAY },
    );
    await store.liabilities.createLiability({
      balanceMinor: 150_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");

    await store.applyStatementImportAndRipple({
      balanceHistories: [
        {
          liabilityId: "mortgage",
          rebaselines: [
            {
              annualInterestRate: "0.03",
              baselineDate: "2024-02-01",
              endDate: "2044-01-01",
              id: "mortgage_rebaseline",
              liabilityId: "mortgage",
              nextPaymentDate: "2024-03-01",
              outstandingBalanceMinor: 150_000_00,
              source: "agent",
              startsAtBaseline: true,
            },
          ],
        },
      ],
      funds: [
        {
          assetId: "matched_fund",
          creates: [
            {
              assetId: "matched_fund",
              currency: "EUR",
              executedAt: "2024-02-01",
              feesMinor: 0,
              id: "op_mixed",
              kind: "buy",
              pricePerUnit: "100",
              units: "2",
            },
          ],
          kind: "matched",
          overwrites: [],
        },
      ],
      propertyValuations: [
        {
          adjustsPriorCurve: true,
          assetId: "home",
          id: "home_appraisal",
          source: "agent",
          valuationDate: "2024-02-01",
          valueMinor: 240_000_00,
        },
      ],
      today: TODAY,
    });

    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(1);
    expect(await store.assets.readValuationAnchors("home")).toHaveLength(2);
    expect(await store.operations.readOperations("matched_fund")).toHaveLength(2);
    const mixed = (await store.snapshots.readSnapshots()).find(
      ({ dateKey }) => dateKey === "2024-02-01",
    );
    expect(mixed).toMatchObject({
      debts: { amountMinor: 150_000_00 },
      grossAssets: { amountMinor: 240_000_00 + 2 * 100_00 },
    });
    store.close();
  });

  test("rolls back facts from every domain when a mixed confirm fails", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "home",
      liquidityTier: "illiquid",
      name: "Vivienda",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.liabilities.createLiability({
      balanceMinor: 150_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");
    const snapshotsBefore = await store.snapshots.readSnapshots();
    const operationsBefore = await store.operations.readOperations("matched_fund");

    await expect(
      store.applyStatementImportAndRipple({
        balanceHistories: [
          {
            liabilityId: "mortgage",
            rebaselines: [
              {
                annualInterestRate: "0.03",
                baselineDate: "2024-02-01",
                endDate: "2044-01-01",
                id: "mixed_rebaseline",
                liabilityId: "mortgage",
                nextPaymentDate: "2024-03-01",
                outstandingBalanceMinor: 150_000_00,
              },
            ],
          },
        ],
        funds: [
          {
            assetId: "matched_fund",
            creates: [
              {
                assetId: "matched_fund",
                currency: "EUR",
                executedAt: "2024-02-01",
                feesMinor: 0,
                id: "mixed_rolled_back_operation",
                kind: "buy",
                pricePerUnit: "100",
                units: "2",
              },
            ],
            kind: "matched",
            overwrites: [],
          },
        ],
        propertyValuations: [
          {
            adjustsPriorCurve: true,
            assetId: "home",
            id: "duplicate_anchor",
            valuationDate: "2024-02-01",
            valueMinor: 220_000_00,
          },
          {
            adjustsPriorCurve: true,
            assetId: "home",
            id: "duplicate_anchor",
            valuationDate: "2024-03-01",
            valueMinor: 230_000_00,
          },
        ],
        today: TODAY,
      }),
    ).rejects.toThrow();

    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    expect(await store.assets.readValuationAnchors("home")).toHaveLength(0);
    expect(await store.operations.readOperations("matched_fund")).toEqual(
      operationsBefore,
    );
    expect(await store.snapshots.readSnapshots()).toEqual(snapshotsBefore);
    store.close();
  });
});
