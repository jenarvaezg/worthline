/**
 * The pure first start of MyInvestor (#1880): the fold's rows and the batch that
 * includes them come from ONE fold of the operations, with the cost worthline's
 * moving average and a traspaso's cost travelling from its origin (ADR 0082).
 * Hand-built facts, so each case states the figures it proves.
 */
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { describe, expect, test } from "vitest";

import type {
  MyInvestorDiscoveredProduct,
  MyInvestorDiscovery,
} from "./myinvestor-discovery";
import {
  foldMyInvestorOperations,
  myInvestorFirstStartView,
  planMyInvestorInclusion,
} from "./myinvestor-first-start";
import { summarizeMyInvestorSelection } from "./myinvestor-selection";

const SOURCE = "src";
const ACCOUNT = "securities:1";
const A = "ES0000000001";
const B = "ES0000000002";
const C = "ES0000000003";

function keyOf(isin: string, account = ACCOUNT): string {
  return `${account}|isin:${isin}`;
}

function op(
  reference: string,
  isin: string,
  overrides: Partial<MyInvestorOperationFact>,
): { key: string; dateKey: string; payload: MyInvestorOperationFact } {
  const payload: MyInvestorOperationFact = {
    accountId: ACCOUNT,
    amount: null,
    currency: "EUR",
    executedAt: "2026-01-01",
    fees: "0",
    instrument: { code: isin, scheme: "isin" },
    instrumentName: `Fondo ${isin.slice(-1)}`,
    kind: "operation",
    operation: "buy",
    pricePerUnit: null,
    product: "fund",
    reference,
    sourceType: "INVESTMENT_FUNDS_SUBSCRIPTION",
    transfer: null,
    units: "1",
    ...overrides,
  };
  return { dateKey: payload.executedAt, key: reference, payload };
}

function fund(
  isin: string,
  units: string,
  extra: Partial<MyInvestorDiscoveredProduct> = {},
) {
  return {
    accountKey: ACCOUNT,
    cash: null,
    identifier: isin,
    instrument: { code: isin, scheme: "isin" as const },
    key: keyOf(isin),
    kind: "fund" as const,
    members: [],
    name: `Fondo ${isin.slice(-1)}`,
    otherHolder: false,
    units,
    ...extra,
  };
}

function discovery(
  operations: ReturnType<typeof op>[],
  products: MyInvestorDiscoveredProduct[],
): MyInvestorDiscovery {
  return {
    accounts: [
      {
        key: ACCOUNT,
        kind: "securities",
        label: "Cuenta de valores ···0001",
        otherHolder: false,
        sub: "Fondos",
      },
    ],
    operations,
    products,
    readOn: "2026-11-04",
    version: 1,
  };
}

function paired(outRef: string, inRef: string) {
  const transferId = `t:${outRef}:${inRef}`;
  return {
    in: { counterpartKey: outRef, pairing: "paired" as const, transferId },
    out: { counterpartKey: inRef, pairing: "paired" as const, transferId },
  };
}

function view(d: MyInvestorDiscovery, twins: Record<string, string> = {}) {
  return myInvestorFirstStartView(d, {
    linkedKeys: new Set(),
    manualTwins: new Map(Object.entries(twins)),
    sourceId: SOURCE,
  });
}

describe("the cost a traspaso carries", () => {
  // Two buys at different prices: 5 @ 8 € and 5 @ 12 € — the average is 10 €.
  const buys = [
    op("b1", A, { amount: "40", executedAt: "2026-01-02", units: "5" }),
    op("b2", A, { amount: "60", executedAt: "2026-02-02", units: "5" }),
  ];

  test("a partial switch takes the moving average out of the origin, never FIFO", () => {
    const pair = paired("out", "in");
    const d = discovery(
      [
        ...buys,
        op("out", A, {
          amount: "50",
          executedAt: "2026-03-02",
          operation: "transfer_out",
          transfer: pair.out,
          units: "4",
        }),
        op("in", B, {
          amount: "50",
          executedAt: "2026-03-02",
          operation: "transfer_in",
          transfer: pair.in,
          units: "2",
        }),
      ],
      [fund(A, "6"), fund(B, "2")],
    );
    const rows = foldMyInvestorOperations(d, SOURCE);
    const incoming = rows.get(keyOf(B))!.find((row) => row.kind === "transfer_in")!;

    // 4 units × 10 € average = 40 €; FIFO would say 4 × 8 € = 32 €.
    expect(incoming.transferCostMinor).toBe(4000);
    const v = view(d);
    expect(v.rows.find((row) => row.key === keyOf(A))!.valueMinor).toBe(6000);
    expect(v.rows.find((row) => row.key === keyOf(B))!.valueMinor).toBe(4000);
  });

  test("the cost travels the same when the origin is left out", () => {
    const pair = paired("out", "in");
    const d = discovery(
      [
        ...buys,
        op("out", A, {
          amount: "118",
          executedAt: "2026-03-02",
          operation: "transfer_out",
          transfer: pair.out,
          units: "10",
        }),
        op("in", B, {
          amount: "118",
          executedAt: "2026-03-02",
          operation: "transfer_in",
          transfer: pair.in,
          units: "6",
        }),
      ],
      [fund(A, "0"), fund(B, "6")],
    );
    const v = view(d);
    const plan = planMyInvestorInclusion(d, {
      assetIdFor: (key) => `asset:${key}`,
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      productKeys: [keyOf(B)],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const facts = plan.command.facts.facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toMatchObject({
      assetId: `asset:${keyOf(B)}`,
      kind: "transfer_in",
      transferCostMinor: 10000,
      transferId: "t:out:in",
    });
    // The origin, fully traspasado, holds nothing today: it arrives unticked.
    expect(v.rows.find((row) => row.key === keyOf(A))!.selectedByDefault).toBe(false);
  });

  test("a chain of traspasos carries the first origin's cost to the last", () => {
    const first = paired("o1", "i1");
    const second = paired("o2", "i2");
    const d = discovery(
      [
        ...buys,
        op("o1", A, {
          amount: "110",
          executedAt: "2026-03-02",
          operation: "transfer_out",
          transfer: first.out,
          units: "10",
        }),
        op("i1", B, {
          amount: "110",
          executedAt: "2026-03-02",
          operation: "transfer_in",
          transfer: first.in,
          units: "11",
        }),
        op("o2", B, {
          amount: "133",
          executedAt: "2026-04-02",
          operation: "transfer_out",
          transfer: second.out,
          units: "11",
        }),
        op("i2", C, {
          amount: "133",
          executedAt: "2026-04-02",
          operation: "transfer_in",
          transfer: second.in,
          units: "13",
        }),
      ],
      [fund(A, "0"), fund(B, "0"), fund(C, "13")],
    );
    const rows = foldMyInvestorOperations(d, SOURCE);
    expect(rows.get(keyOf(C))![0]!.transferCostMinor).toBe(10000);
  });

  test("a round trip carries each cost from where it leaves, without a cycle", () => {
    const there = paired("o1", "i1");
    const back = paired("o2", "i2");
    const d = discovery(
      [
        // 10 units of A for 100 €; all of them go to B; later half of B comes back.
        op("b1", A, { amount: "100", executedAt: "2025-01-02", units: "10" }),
        op("o1", A, {
          amount: "118",
          executedAt: "2025-03-02",
          operation: "transfer_out",
          transfer: there.out,
          units: "10",
        }),
        op("i1", B, {
          amount: "118",
          executedAt: "2025-03-02",
          operation: "transfer_in",
          transfer: there.in,
          units: "20",
        }),
        op("o2", B, {
          amount: "66",
          executedAt: "2025-09-02",
          operation: "transfer_out",
          transfer: back.out,
          units: "10",
        }),
        op("i2", A, {
          amount: "66",
          executedAt: "2025-09-02",
          operation: "transfer_in",
          transfer: back.in,
          units: "5",
        }),
      ],
      [fund(A, "5"), fund(B, "10")],
    );
    const rows = foldMyInvestorOperations(d, SOURCE);

    expect(
      rows.get(keyOf(B))!.find((row) => row.kind === "transfer_in")!.transferCostMinor,
    ).toBe(10000);
    // Half of B's units leave with half of its 100 € cost.
    expect(
      rows.get(keyOf(A))!.find((row) => row.kind === "transfer_in")!.transferCostMinor,
    ).toBe(5000);
  });

  test("an entry from another institution has its cost pending: the amount that arrived", () => {
    const d = discovery(
      [
        op("ext", B, {
          executedAt: "2026-01-10",
          operation: "transfer_in",
          transfer: {
            inheritedCost: "pending",
            pairing: "external_in",
            transferId: "x:ext",
          },
          units: "10",
        }),
        op("c1", B, {
          amount: "21",
          executedAt: "2026-02-10",
          pricePerUnit: "21",
          units: "1",
        }),
      ],
      [fund(B, "11")],
    );
    const rows = foldMyInvestorOperations(d, SOURCE);
    const entry = rows.get(keyOf(B))!.find((row) => row.kind === "transfer_in")!;

    // No figure of its own: valued at the nearest execution NAV of the same product.
    expect(entry.transferCostMinor).toBe(21000);
    expect(view(d).rows[0]!.inheritedCostPending).toBe(true);
  });
});

describe("what can be included in this slice", () => {
  test("a product kept by hand and the robo-advisor wait for their slices", () => {
    const d = discovery(
      [
        op("b1", A, { amount: "10", units: "1" }),
        op("b2", B, { amount: "10", units: "1" }),
      ],
      [
        fund(A, "1"),
        fund(B, "1"),
        {
          accountKey: ACCOUNT,
          cash: null,
          identifier: null,
          instrument: null,
          key: "portfolio:9",
          kind: "managed",
          members: ["Fondo de oro", "Cuenta Ahorro (efectivo)"],
          name: "Cartera",
          otherHolder: false,
          units: null,
        },
      ],
    );
    const v = view(d, { [A]: "Fondo A (a mano)" });
    const byKey = new Map(v.rows.map((row) => [row.key, row]));

    expect(byKey.get(keyOf(A))!.block).toEqual({
      holdingName: "Fondo A (a mano)",
      reason: "manual_twin",
    });
    expect(byKey.get("portfolio:9")!.block).toEqual({ reason: "managed_portfolio" });
    expect(byKey.get(keyOf(B))!.selectedByDefault).toBe(true);

    const all = new Set(v.rows.map((row) => row.key));
    const summary = summarizeMyInvestorSelection(v.rows, all);
    expect(summary.count).toBe(1);
    expect(summary.twins).toBe(1);

    const plan = planMyInvestorInclusion(d, {
      assetIdFor: (key) => key,
      ownership: [],
      productKeys: [keyOf(A)],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    });
    expect(plan.ok).toBe(false);
  });

  test("the cash account is a stored balance in Líquido, with no operation", () => {
    const d = discovery(
      [],
      [
        {
          accountKey: "cash:7",
          cash: { balance: "149.45", currency: "EUR", withheld: "149.23" },
          identifier: "ES00 ···0000",
          instrument: null,
          key: "cash:7",
          kind: "cash",
          members: [],
          name: "Cuenta",
          otherHolder: false,
          units: null,
        },
      ],
    );
    const v = view(d);
    expect(v.rows[0]).toMatchObject({
      rung: "liquid",
      valueMinor: 14945,
      withheldMinor: 14923,
    });
    const plan = planMyInvestorInclusion(d, {
      assetIdFor: () => "cash-asset",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      productKeys: ["cash:7"],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    });
    expect(plan.ok && plan.command.facts.facts).toEqual([]);
    expect(plan.ok && plan.command.holdings[0]!.holding).toMatchObject({
      asset: { currentValueMinor: 14945, instrument: "current_account", type: "cash" },
      kind: "cash",
    });
  });
});
