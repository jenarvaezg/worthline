/**
 * The pure half of «Poner al día» (#1884): the stored read refreshed with the window
 * just read, the batch that applies what is new to the linked holdings — from the
 * SAME fold the first start includes with (#1438) — and the units check of P8,
 * which only ever reports: it never plans an adjustment (PRD #1876, invariant 6).
 */
import type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
} from "@worthline/domain";
import { auditTransferPairs, createInvestmentOperation } from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { describe, expect, test } from "vitest";

import type {
  MyInvestorDiscoveredProduct,
  MyInvestorDiscovery,
  MyInvestorDiscoveryReads,
} from "./myinvestor-discovery";
import { myInvestorOperationId } from "./myinvestor-first-start";
import {
  carryTransferCostsFromBook,
  checkMyInvestorUnits,
  planMyInvestorSync,
  refreshMyInvestorDiscovery,
} from "./myinvestor-sync-plan";

const SOURCE = "src";
const ACCOUNT = "securities:1";
const A = "ES0000000001";
const B = "ES0000000002";

function keyOf(isin: string): string {
  return `${ACCOUNT}|isin:${isin}`;
}

function op(
  reference: string,
  isin: string,
  overrides: Partial<MyInvestorOperationFact> = {},
): { key: string; dateKey: string; payload: MyInvestorOperationFact } {
  const payload: MyInvestorOperationFact = {
    accountId: ACCOUNT,
    amount: "13.37",
    currency: "EUR",
    executedAt: "2026-01-01",
    fees: "0",
    instrument: { code: isin, scheme: "isin" },
    instrumentName: `Fondo ${isin.slice(-1)}`,
    kind: "operation",
    operation: "buy",
    pricePerUnit: "13.37",
    product: "fund",
    reference,
    sourceType: "INVESTMENT_FUNDS_SUBSCRIPTION",
    transfer: null,
    units: "1",
    ...overrides,
  };
  return { dateKey: payload.executedAt, key: reference, payload };
}

function fund(isin: string, units: string): MyInvestorDiscoveredProduct {
  return {
    accountKey: ACCOUNT,
    cash: null,
    identifier: isin,
    instrument: { code: isin, scheme: "isin" },
    key: keyOf(isin),
    kind: "fund",
    members: [],
    name: `Fondo ${isin.slice(-1)}`,
    otherHolder: false,
    units,
  };
}

const CASH: MyInvestorDiscoveredProduct = {
  accountKey: "cash:9",
  cash: { balance: "1234.57", currency: "EUR", withheld: "0" },
  identifier: "ES·· 0009",
  instrument: null,
  key: "cash:9",
  kind: "cash",
  members: [],
  name: "Cuenta",
  otherHolder: false,
  units: null,
};

function discovery(
  operations: ReturnType<typeof op>[],
  products: MyInvestorDiscoveredProduct[],
  readOn = "2026-10-01",
): MyInvestorDiscovery {
  return { accounts: [], operations, products, readOn, version: 1 };
}

describe("refreshing the stored read with the window just read", () => {
  test("the history before the window stays, the window replaces what it covers", () => {
    const previous = discovery(
      [
        op("old", A, { executedAt: "2025-03-03" }),
        op("again", A, { executedAt: "2026-09-20", units: "1" }),
      ],
      [fund(A, "2")],
    );
    const reads: MyInvestorDiscoveryReads = {
      cashAccounts: [],
      contributions: [],
      operations: [
        op("again", A, { executedAt: "2026-09-20", units: "1" }),
        op("new", A, { executedAt: "2026-10-20", units: "2" }),
      ],
      pensions: [],
      readOn: "2026-11-04",
      securities: [],
    };

    const refreshed = refreshMyInvestorDiscovery(previous, reads);

    expect(refreshed.readOn).toBe("2026-11-04");
    expect(refreshed.operations.map((fact) => fact.key)).toEqual(["old", "again", "new"]);
    expect(refreshed.contributions).toEqual([]);
  });

  test("with no stored read, the window is the history", () => {
    const reads: MyInvestorDiscoveryReads = {
      cashAccounts: [],
      operations: [op("only", A)],
      pensions: [],
      readOn: "2026-11-04",
      securities: [],
    };
    expect(
      refreshMyInvestorDiscovery(null, reads).operations.map((fact) => fact.key),
    ).toEqual(["only"]);
  });
});

describe("the batch of a periodic sync", () => {
  const read = discovery(
    [
      op("a1", A, { executedAt: "2025-01-10" }),
      op("a2", A, { executedAt: "2026-10-20", units: "2" }),
      op("b1", B, { executedAt: "2026-10-21" }),
    ],
    [fund(A, "3"), fund(B, "1"), CASH],
    "2026-11-04",
  );
  const links = [
    { assetId: "asset-a", productKey: keyOf(A) },
    { assetId: "asset-cash", productKey: "cash:9" },
  ];

  test("only the window's operations of the LINKED holdings, into their holding", () => {
    const plan = planMyInvestorSync(read, {
      cursor: "2026-11-04",
      links,
      sourceId: SOURCE,
      windowKeys: new Set(["a2", "b1"]),
    });

    expect(plan.facts.cursor).toBe("2026-11-04");
    expect(plan.facts.facts).toEqual([
      expect.objectContaining({
        dateKey: "2026-10-20",
        key: "a2",
        payload: expect.objectContaining({
          assetId: "asset-a",
          id: myInvestorOperationId(SOURCE, "a2"),
          kind: "buy",
          source: "connected",
          units: "2",
        }),
      }),
    ]);
    expect(plan.cashBalances).toEqual([{ assetId: "asset-cash", valueMinor: 123_457 }]);
    expect(plan.witnesses).toEqual([
      { assetId: "asset-a", productKey: keyOf(A), units: "3" },
    ]);
  });

  test("a traspaso in the window carries the cost of its origin's WHOLE ledger", () => {
    // 10 for 103,70 € and 10 for 201,10 € before the window: 15,24 € on average.
    // The 5 that leave inside the window take 76,20 €, not what 30 days would say.
    const transfer = discovery(
      [
        op("a-buy-1", A, { amount: "103.7", executedAt: "2025-01-10", units: "10" }),
        op("a-buy-2", A, { amount: "201.1", executedAt: "2025-06-10", units: "10" }),
        op("out", A, {
          amount: "76.21",
          executedAt: "2026-10-20",
          operation: "transfer_out",
          transfer: { counterpartKey: "in", pairing: "paired", transferId: "t1" },
          units: "5",
        }),
        op("in", B, {
          amount: "76.21",
          executedAt: "2026-10-20",
          operation: "transfer_in",
          transfer: { counterpartKey: "out", pairing: "paired", transferId: "t1" },
          units: "4",
        }),
      ],
      [fund(A, "15"), fund(B, "4")],
      "2026-11-04",
    );

    const plan = planMyInvestorSync(transfer, {
      cursor: "2026-11-04",
      links: [
        { assetId: "asset-a", productKey: keyOf(A) },
        { assetId: "asset-b", productKey: keyOf(B) },
      ],
      sourceId: SOURCE,
      windowKeys: new Set(["out", "in"]),
    });

    const entry = plan.facts.facts.find((fact) => fact.key === "in")!;
    expect(entry.payload).toMatchObject({
      assetId: "asset-b",
      transferCostMinor: 7_620,
      transferId: "t1",
    });
    expect(plan.facts.facts.map((fact) => fact.key).sort()).toEqual(["in", "out"]);
  });

  test("«Resincronizar todo» plans the whole history of the linked holdings", () => {
    const plan = planMyInvestorSync(read, {
      cursor: "2026-11-04",
      links,
      sourceId: SOURCE,
      windowKeys: null,
    });
    expect(plan.facts.facts.map((fact) => fact.key)).toEqual(["a1", "a2"]);
  });

  test("a linked product MyInvestor no longer lists is witnessed at zero units", () => {
    const plan = planMyInvestorSync(discovery([], [], "2026-11-04"), {
      cursor: "2026-11-04",
      links: [{ assetId: "asset-gone", productKey: keyOf(B) }],
      sourceId: SOURCE,
      windowKeys: new Set(),
    });
    expect(plan.witnesses).toEqual([
      { assetId: "asset-gone", productKey: keyOf(B), units: "0" },
    ]);
  });
});

describe("the cost a new traspaso inherits travels from the origin's BOOK", () => {
  function row(
    overrides: Partial<CreateInvestmentOperationInput>,
  ): CreateInvestmentOperationInput {
    return {
      assetId: "asset-a",
      currency: "EUR",
      executedAt: "2026-01-01",
      feesMinor: 0,
      id: "x",
      kind: "buy",
      pricePerUnit: "98.37",
      source: "connected",
      units: "103.11",
      ...overrides,
    };
  }

  test("a cost the user answered on the origin is the one that travels", () => {
    // The origin entered from another institution with 9.871,43 € that arrived; the
    // user typed its real cost, 6.137,21 € (#1882). The fold of the stored read only
    // knows the arrival; the book knows the answer.
    const book = new Map([
      [
        "asset-a",
        [
          createInvestmentOperation(
            row({
              id: "entry",
              kind: "transfer_in",
              transferCostMinor: 613_721,
              transferId: "myinvestor-external:e1",
            }),
          ),
        ],
      ],
      ["asset-b", []],
    ]);
    const facts = [
      {
        dateKey: "2026-10-20",
        key: "out",
        payload: row({
          executedAt: "2026-10-20",
          id: "mi-out",
          kind: "transfer_out",
          transferId: "t1",
        }),
      },
      {
        dateKey: "2026-10-20",
        key: "in",
        payload: row({
          assetId: "asset-b",
          executedAt: "2026-10-20",
          id: "mi-in",
          kind: "transfer_in",
          transferCostMinor: 987_143,
          transferId: "t1",
        }),
      },
    ];

    const carried = carryTransferCostsFromBook(facts, book);

    expect(carried.find((fact) => fact.key === "in")!.payload.transferCostMinor).toBe(
      613_721,
    );
    expect(carried.find((fact) => fact.key === "out")).toEqual(facts[0]);
  });

  test("a chain in one batch (A→B, then B→C) carries the answered cost to the end", () => {
    const answered = createInvestmentOperation(
      row({
        id: "entry",
        kind: "transfer_in",
        transferCostMinor: 613_721,
        transferId: "myinvestor-external:e1",
      }),
    );
    const book = new Map<string, InvestmentOperation[]>([
      ["asset-a", [answered]],
      ["asset-b", []],
      ["asset-c", []],
    ]);
    const leg = (
      key: string,
      assetId: string,
      kind: "transfer_out" | "transfer_in",
      transferId: string,
      executedAt: string,
    ) => ({
      dateKey: executedAt,
      key,
      payload: row({
        assetId,
        executedAt,
        id: `mi-${key}`,
        kind,
        // The fold of the stored read only knows what arrived at A.
        ...(kind === "transfer_in" ? { transferCostMinor: 987_143 } : {}),
        transferId,
      }),
    });
    const facts = [
      leg("out1", "asset-a", "transfer_out", "t1", "2026-10-20"),
      leg("in1", "asset-b", "transfer_in", "t1", "2026-10-20"),
      leg("out2", "asset-b", "transfer_out", "t2", "2026-10-27"),
      leg("in2", "asset-c", "transfer_in", "t2", "2026-10-27"),
    ];

    const carried = carryTransferCostsFromBook(facts, book);

    const costOf = (key: string) =>
      carried.find((fact) => fact.key === key)!.payload.transferCostMinor;
    expect(costOf("in1")).toBe(613_721);
    expect(costOf("in2")).toBe(613_721);
    // The book these rows make squares with the audit's own fold: no pair drifts.
    const after = new Map(
      [...book].map(([assetId, rows]) => [
        assetId,
        [
          ...rows,
          ...carried
            .filter((fact) => fact.payload.assetId === assetId)
            .map((fact) => createInvestmentOperation(fact.payload)),
        ],
      ]),
    );
    expect(auditTransferPairs({ operationsByAssetId: after })).toEqual([]);
  });

  test("an entry still pending, or whose origin is not in the book, keeps its own", () => {
    const pending = {
      dateKey: "2026-10-20",
      key: "in",
      payload: row({
        assetId: "asset-b",
        kind: "transfer_in",
        transferCostMinor: 987_143,
        transferId: "myinvestor-external:e2",
        transferLegState: "cost_pending",
      }),
    };
    expect(carryTransferCostsFromBook([pending], new Map())).toEqual([pending]);
  });
});

describe("the units check (P8)", () => {
  test("a difference is reported with both figures and its sign; a match is not", () => {
    const mismatches = checkMyInvestorUnits(
      [
        { assetId: "asset-a", productKey: keyOf(A), units: "402.10" },
        { assetId: "asset-b", productKey: keyOf(B), units: "7.5" },
      ],
      new Map([
        ["asset-a", "401.77"],
        ["asset-b", "7.50"],
      ]),
    );

    expect(mismatches).toEqual([
      {
        assetId: "asset-a",
        bookUnits: "401.77",
        difference: "0.33",
        productKey: keyOf(A),
        sourceUnits: "402.10",
      },
    ]);
  });

  test("a holding with no book units counts as zero", () => {
    expect(
      checkMyInvestorUnits(
        [{ assetId: "asset-a", productKey: keyOf(A), units: "1.25" }],
        new Map(),
      ),
    ).toEqual([
      expect.objectContaining({
        bookUnits: "0",
        difference: "1.25",
        sourceUnits: "1.25",
      }),
    ]);
  });
});
