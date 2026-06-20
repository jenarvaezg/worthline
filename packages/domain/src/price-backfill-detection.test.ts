/**
 * Historical-price backfill candidate detection (#380, ADR 0033).
 *
 * A `derived` investment with a provider symbol AND ≥1 historical snapshot row
 * frozen at COST BASIS (units present, unit_price absent — the ADR 0006 fallback)
 * is a backfill candidate: its old snapshots are valued at cost until the first
 * real quote arrives, producing the cost→price jump the action exists to remove.
 * Pure detection — every input is passed in, nothing reads the clock or the db.
 */
import { describe, expect, it } from "vitest";

import {
  detectPriceBackfillCandidates,
  detectSingleAssetBackfillCandidate,
} from "./price-backfill-detection";
import type {
  PriceBackfillCandidateAsset,
  PriceBackfillSnapshotRow,
} from "./price-backfill-detection";
import type { InvestmentOperation } from "./investment-types";

function btc(
  overrides: {
    assetId?: string;
    priceProvider?: PriceBackfillCandidateAsset["priceProvider"];
    providerSymbol?: string | undefined;
  } = {},
): PriceBackfillCandidateAsset {
  const base: PriceBackfillCandidateAsset = {
    assetId: overrides.assetId ?? "btc",
    priceProvider: overrides.priceProvider ?? "coingecko",
    providerSymbol: overrides.providerSymbol ?? "bitcoin",
  };
  // Honor an explicit `providerSymbol: undefined` as "no provider symbol".
  if ("providerSymbol" in overrides && overrides.providerSymbol === undefined) {
    delete base.providerSymbol;
  }
  return base;
}

/** A cost-basis row: units present, unit_price absent. */
function costRow(
  holdingId: string,
  dateKey: string,
  units = "0.25",
): PriceBackfillSnapshotRow {
  return { holdingId, kind: "asset", dateKey, units };
}

/** A priced row: units AND unit_price present. */
function pricedRow(
  holdingId: string,
  dateKey: string,
  units = "0.25",
  unitPrice = "30000",
): PriceBackfillSnapshotRow {
  return { holdingId, kind: "asset", dateKey, units, unitPrice };
}

describe("detectPriceBackfillCandidates (#380)", () => {
  it("identifies a provider-symbol investment with cost-basis history", () => {
    const candidates = detectPriceBackfillCandidates({
      assets: [btc()],
      operations: [
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2021-01-01",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "30000",
          units: "0.25",
        },
      ],
      snapshotRows: [
        costRow("btc", "2021-01-01"),
        costRow("btc", "2021-02-01"),
        costRow("btc", "2021-03-01"),
      ],
    });

    expect(candidates).toEqual([
      {
        assetId: "btc",
        priceProvider: "coingecko",
        providerSymbol: "bitcoin",
        firstOperationDate: "2021-01-01",
        monthsAtCost: 3,
      },
    ]);
  });

  it("ignores an investment WITHOUT a provider symbol", () => {
    const candidates = detectPriceBackfillCandidates({
      assets: [btc({ providerSymbol: undefined })],
      operations: [
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2021-01-01",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "30000",
          units: "0.25",
        },
      ],
      snapshotRows: [costRow("btc", "2021-01-01")],
    });

    expect(candidates).toEqual([]);
  });

  it("ignores an investment with NO cost-basis rows (every row already priced)", () => {
    const candidates = detectPriceBackfillCandidates({
      assets: [btc()],
      operations: [
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2021-01-01",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "30000",
          units: "0.25",
        },
      ],
      snapshotRows: [pricedRow("btc", "2021-01-01"), pricedRow("btc", "2021-02-01")],
    });

    expect(candidates).toEqual([]);
  });

  it("ignores an investment with NO operations (cannot anchor a first date)", () => {
    const candidates = detectPriceBackfillCandidates({
      assets: [btc()],
      operations: [],
      snapshotRows: [costRow("btc", "2021-01-01")],
    });

    expect(candidates).toEqual([]);
  });

  it("counts DISTINCT cost-basis dates, not rows, across scopes", () => {
    const candidates = detectPriceBackfillCandidates({
      assets: [btc()],
      operations: [
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2021-01-01",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "30000",
          units: "0.25",
        },
      ],
      // Same two dates appear twice (two scopes) — monthsAtCost must be 2.
      snapshotRows: [
        costRow("btc", "2021-01-01"),
        costRow("btc", "2021-01-01"),
        costRow("btc", "2021-02-01"),
        costRow("btc", "2021-02-01"),
      ],
    });

    expect(candidates[0]?.monthsAtCost).toBe(2);
  });

  it("uses the EARLIEST operation date as firstOperationDate", () => {
    const candidates = detectPriceBackfillCandidates({
      assets: [btc()],
      operations: [
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2026-06-16",
          feesMinor: 0,
          id: "op2",
          kind: "buy",
          pricePerUnit: "50000",
          units: "0.01",
        },
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2021-01-01",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "30000",
          units: "0.25",
        },
      ],
      snapshotRows: [costRow("btc", "2021-02-01")],
    });

    expect(candidates[0]?.firstOperationDate).toBe("2021-01-01");
  });

  it("returns one entry per qualifying asset, leaving non-candidates out", () => {
    const candidates = detectPriceBackfillCandidates({
      assets: [
        btc(),
        btc({ assetId: "eth", providerSymbol: "ethereum" }),
        btc({ assetId: "no-sym", providerSymbol: undefined }),
      ],
      operations: [
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2021-01-01",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "30000",
          units: "0.25",
        },
        {
          assetId: "eth",
          currency: "EUR",
          executedAt: "2022-01-01",
          feesMinor: 0,
          id: "op2",
          kind: "buy",
          pricePerUnit: "2000",
          units: "1",
        },
        {
          assetId: "no-sym",
          currency: "EUR",
          executedAt: "2021-01-01",
          feesMinor: 0,
          id: "op3",
          kind: "buy",
          pricePerUnit: "10",
          units: "1",
        },
      ],
      snapshotRows: [
        costRow("btc", "2021-02-01"),
        costRow("eth", "2022-02-01"),
        costRow("no-sym", "2021-02-01"),
      ],
    });

    expect(candidates.map((c) => c.assetId)).toEqual(["btc", "eth"]);
  });
});

describe("detectSingleAssetBackfillCandidate (#380)", () => {
  const op: InvestmentOperation = {
    assetId: "btc",
    currency: "EUR",
    executedAt: "2021-01-01",
    feesMinor: 0,
    id: "op1",
    kind: "buy",
    pricePerUnit: "30000",
    units: "0.25",
  };

  it("returns the candidate for an eligible single asset", () => {
    expect(
      detectSingleAssetBackfillCandidate({
        assetId: "btc",
        operations: [op],
        priceProvider: "coingecko",
        providerSymbol: "bitcoin",
        snapshotRows: [costRow("btc", "2021-01-01"), costRow("btc", "2021-02-01")],
      }),
    ).toEqual({
      assetId: "btc",
      firstOperationDate: "2021-01-01",
      monthsAtCost: 2,
      priceProvider: "coingecko",
      providerSymbol: "bitcoin",
    });
  });

  it("returns null without a provider symbol", () => {
    expect(
      detectSingleAssetBackfillCandidate({
        assetId: "btc",
        operations: [op],
        priceProvider: "coingecko",
        snapshotRows: [costRow("btc", "2021-01-01")],
      }),
    ).toBeNull();
  });

  it("returns null with no cost-basis rows", () => {
    expect(
      detectSingleAssetBackfillCandidate({
        assetId: "btc",
        operations: [op],
        priceProvider: "coingecko",
        providerSymbol: "bitcoin",
        snapshotRows: [pricedRow("btc", "2021-01-01")],
      }),
    ).toBeNull();
  });
});
