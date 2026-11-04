/**
 * The pure first start of MyInvestor (#1880): the fold's rows and the batch that
 * includes them come from ONE fold of the operations, with the cost worthline's
 * moving average and a traspaso's cost travelling from its origin (ADR 0082).
 * Hand-built facts, so each case states the figures it proves.
 */
import { costLeavingOrigin } from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { describe, expect, test } from "vitest";

import type {
  MyInvestorDiscoveredProduct,
  MyInvestorDiscovery,
} from "./myinvestor-discovery";
import {
  findMyInvestorTwins,
  foldMyInvestorOperations,
  type MyInvestorManualHolding,
  type MyInvestorTwinLedger,
  myInvestorFirstStartView,
  planMyInvestorInclusion,
} from "./myinvestor-first-start";
import {
  defaultMyInvestorTwinChoices,
  summarizeMyInvestorSelection,
} from "./myinvestor-selection";

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
    declared: null,
    identifier: isin,
    instrument: { code: isin, scheme: "isin" as const },
    key: keyOf(isin),
    kind: "fund" as const,
    members: [],
    name: `Fondo ${isin.slice(-1)}`,
    otherHolder: false,
    portfolioKey: null,
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
    version: 2,
  };
}

function paired(outRef: string, inRef: string) {
  const transferId = `t:${outRef}:${inRef}`;
  return {
    in: { counterpartKey: outRef, pairing: "paired" as const, transferId },
    out: { counterpartKey: inRef, pairing: "paired" as const, transferId },
  };
}

function view(
  d: MyInvestorDiscovery,
  manual: MyInvestorManualHolding[] = [],
  ledgers: Map<string, MyInvestorTwinLedger> = new Map(),
) {
  const linkedKeys = new Set<string>();
  return myInvestorFirstStartView(d, {
    ledgers,
    linkedKeys,
    sourceId: SOURCE,
    today: "2026-11-04",
    twins: findMyInvestorTwins(d, { linkedKeys, manual }),
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

  test.each([
    { label: "a fraction of an odd average", units: "1.3417" },
    { label: "more units than the history holds", units: "13.0917" },
  ])("the first start and the sync carry the same cost: $label (ADR 0115)", ({
    units,
  }) => {
    const pair = paired("out", "in");
    const d = discovery(
      [
        op("b1", A, { amount: "33.07", executedAt: "2026-01-02", units: "3.0317" }),
        op("b2", A, { amount: "71.93", executedAt: "2026-02-02", units: "5.1129" }),
        op("b3", A, { amount: "19.41", executedAt: "2026-02-17", units: "1.4471" }),
        op("out", A, {
          amount: "29.83",
          executedAt: "2026-03-02",
          operation: "transfer_out",
          transfer: pair.out,
          units,
        }),
        op("in", B, {
          amount: "29.83",
          executedAt: "2026-03-02",
          operation: "transfer_in",
          transfer: pair.in,
          units: "2.0713",
        }),
      ],
      [fund(A, "0"), fund(B, "2.0713")],
    );
    const rows = foldMyInvestorOperations(d, SOURCE);
    const out = rows.get(keyOf(A))!.find((row) => row.kind === "transfer_out")!;
    const incoming = rows.get(keyOf(B))!.find((row) => row.kind === "transfer_in")!;

    // The sync and the inherited-cost answer fold this one (myinvestor-sync-plan,
    // inherited-cost): the first start may not have a second opinion.
    expect(incoming.transferCostMinor).toBe(costLeavingOrigin(out, rows));
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
    // And marked, so the ficha asks for the real cost (#1882).
    expect(entry.transferLegState).toBe("cost_pending");
    expect(view(d).rows[0]!.inheritedCostPending).toBe(true);
  });

  test("an internal traspaso nobody paired: the way out is a sale, the way in is pending (#1882)", () => {
    const d = discovery(
      [
        op("b1", A, { amount: "37", executedAt: "2025-03-04", units: "3.7" }),
        op("out", A, {
          amount: "41.3",
          executedAt: "2026-06-11",
          operation: "transfer_out",
          transfer: {
            inheritedCost: null,
            pairing: "unpaired",
            reason: "no_common_reference",
            transferId: "myinvestor-unpaired:out",
          },
          units: "3.7",
        }),
        op("in", B, {
          amount: "40.9",
          executedAt: "2026-06-16",
          operation: "transfer_in",
          transfer: {
            inheritedCost: "pending",
            pairing: "unpaired",
            reason: "no_common_reference",
            transferId: "myinvestor-unpaired:in",
          },
          units: "4.1",
        }),
      ],
      [fund(A, "0"), fund(B, "4.1")],
    );
    const rows = foldMyInvestorOperations(d, SOURCE);
    const out = rows.get(keyOf(A))!.find((row) => row.executedAt === "2026-06-11")!;
    const entry = rows.get(keyOf(B))!.find((row) => row.kind === "transfer_in")!;

    expect(out).toMatchObject({ kind: "sell", transferLegState: "unpaired_out" });
    expect(out.transferId).toBeUndefined();
    expect(entry).toMatchObject({
      transferCostMinor: 4090,
      transferId: "myinvestor-unpaired:in",
      transferLegState: "cost_pending",
    });
  });
});

describe("what can be included in this slice", () => {
  test("the cash account is a stored balance in Líquido, with no operation", () => {
    const d = discovery(
      [],
      [
        {
          accountKey: "cash:7",
          cash: { balance: "149.45", currency: "EUR", withheld: "149.23" },
          declared: null,
          identifier: "ES00 ···0000",
          instrument: null,
          key: "cash:7",
          kind: "cash",
          members: [],
          name: "Cuenta",
          otherHolder: false,
          portfolioKey: null,
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

describe("a cash account kept by hand that MyInvestor's may be (S6 for cash)", () => {
  const cash: MyInvestorDiscoveredProduct = {
    accountKey: "cash:7",
    cash: { balance: "1493.17", currency: "EUR", withheld: "0" },
    declared: null,
    identifier: "ES00 ···0000",
    instrument: null,
    key: "cash:7",
    kind: "cash",
    members: [],
    name: "Cuenta",
    otherHolder: false,
    portfolioKey: null,
    units: null,
  };
  const d = discovery([], [cash]);
  const manualCash = [
    { id: "hand-mi", name: "Cuenta MyInvestor", valueMinor: 120_311 },
    { id: "hand-other", name: "Cuenta nómina", valueMinor: 87_113 },
  ];
  const linkedKeys = new Set<string>();
  const v = myInvestorFirstStartView(d, {
    ledgers: new Map(),
    linkedKeys,
    sourceId: SOURCE,
    today: "2026-11-04",
    twins: findMyInvestorTwins(d, { cash: manualCash, linkedKeys, manual: [] }),
  });
  const row = v.rows[0]!;

  test("no IBAN to compare: a weak twin by name, opened at «No incluir»", () => {
    expect(row.twin).toMatchObject({
      candidates: [
        {
          assetId: "hand-mi",
          careo: null,
          cash: { afterMinor: 149_317, beforeMinor: 120_311 },
          name: "Cuenta MyInvestor",
        },
      ],
      defaultChoice: "skip",
      reason: "cash",
    });
    expect(row.selectedByDefault).toBe(false);
  });

  test("linking takes MyInvestor's balance: the patrimonio moves by the difference", () => {
    const summary = summarizeMyInvestorSelection(
      v.rows,
      new Set(),
      new Map([["cash:7", "link:hand-mi" as const]]),
    );
    expect(summary).toMatchObject({
      count: 0,
      linked: 1,
      valueMinor: 149_317 - 120_311,
    });

    const plan = planMyInvestorInclusion(d, {
      assetIdFor: () => "unused",
      links: [{ assetId: "hand-mi", productKey: "cash:7" }],
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      productKeys: [],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.command.cashLinks).toEqual([
      { assetId: "hand-mi", balanceMinor: 149_317, productKey: "cash:7" },
    ]);
    expect(plan.command.links).toEqual([]);
    expect(plan.command.holdings).toEqual([]);
  });

  test("a cash account with nothing of MyInvestor in its name is no twin", () => {
    const plain = findMyInvestorTwins(d, {
      cash: [{ id: "hand-other", name: "Cuenta nómina", valueMinor: 87_113 }],
      linkedKeys,
      manual: [],
    });
    expect(plain.size).toBe(0);
  });
});

describe("a product a manual holding already is (#1881)", () => {
  const d = discovery(
    [
      op("b1", A, { amount: "101.37", executedAt: "2025-02-11", units: "3.0317" }),
      op("b2", A, { amount: "51.13", executedAt: "2025-06-11", units: "1.4419" }),
      op("b3", B, { amount: "73.19", executedAt: "2025-03-03", units: "7.3117" }),
    ],
    [
      fund(A, "4.4736", { name: "Vanguard Global Stock Index Fund EUR Acc" }),
      fund(B, "7.3117", { name: "Fidelity MSCI World Index Fund EUR P Acc" }),
    ],
  );
  const manual: MyInvestorManualHolding[] = [
    { code: A, id: "global", name: "Global (a mano)" },
    { code: null, id: "world", name: "Fidelity World (a mano)" },
    { code: "ES0000000999", id: "other", name: "Otro fondo a mano" },
  ];
  const manualBuy = {
    assetId: "global",
    currency: "EUR",
    executedAt: "2025-02-11",
    feesMinor: 0,
    id: "m1",
    kind: "buy" as const,
    pricePerUnit: "33.43701",
    units: "3.0317",
  };
  const ledgers = new Map<string, MyInvestorTwinLedger>([
    [
      "global",
      {
        operations: [manualBuy],
        plan: {
          contributions: [
            {
              amount: { mode: "money", value: 5_013 },
              cadence: { dayOfMonth: 11, kind: "monthly" },
              destinationHoldingId: "global",
              id: "c1",
              startDate: "2025-02-11",
            },
          ],
          reconciliations: [],
        },
        pairedWith: [],
      },
    ],
  ]);

  test("the same identifier is proposed to link; a name alike is a suggestion left out", () => {
    const v = view(d, manual, ledgers);
    const byKey = new Map(v.rows.map((row) => [row.key, row]));
    const strong = byKey.get(keyOf(A))!;
    const alike = byKey.get(keyOf(B))!;

    expect(strong.twin).toMatchObject({
      candidates: [{ assetId: "global", name: "Global (a mano)" }],
      defaultChoice: "link:global",
      reason: "identifier",
    });
    expect(alike.twin).toMatchObject({
      candidates: [{ assetId: "world", name: "Fidelity World (a mano)" }],
      defaultChoice: "skip",
      reason: "name",
    });
    // A twin is decided by its three choices, never by a box ticked by default.
    expect(strong.selectedByDefault).toBe(false);
    expect(alike.selectedByDefault).toBe(false);
    expect(defaultMyInvestorTwinChoices(v.rows)).toEqual(
      new Map([
        [keyOf(A), "link:global"],
        [keyOf(B), "skip"],
      ]),
    );
  });

  test("the careo pairs the manual buy and says the plan closes today", () => {
    const strong = view(d, manual, ledgers).rows.find((row) => row.key === keyOf(A))!;
    const careo = strong.twin!.candidates[0]!.careo!;

    expect(careo.counts).toEqual({ enters: 1, leaves: 0, manual: 1, same: 1 });
    expect(careo.plan?.lines).toHaveLength(1);
  });

  test("the panel adds a linked holding by its difference, a separate one whole", () => {
    const v = view(d, manual, ledgers);
    const strong = v.rows.find((row) => row.key === keyOf(A))!;
    const careo = strong.twin!.candidates[0]!.careo!;

    const linked = summarizeMyInvestorSelection(
      v.rows,
      new Set(),
      defaultMyInvestorTwinChoices(v.rows),
    );
    expect(linked).toMatchObject({
      count: 0,
      linked: 1,
      linkedDeltaMinor: careo.valueDeltaMinor,
      plansClosing: 1,
      valueMinor: careo.valueDeltaMinor,
    });
    // 51.13 € more in MyInvestor than by hand: the one buy that only it has.
    expect(careo.valueDeltaMinor).toBe(5_113);

    const apart = summarizeMyInvestorSelection(
      v.rows,
      new Set(),
      new Map([[keyOf(A), "separate" as const]]),
    );
    expect(apart).toMatchObject({ count: 1, linked: 0, valueMinor: strong.valueMinor });
  });

  test("the batch links the holding with MyInvestor's rows and gives a name match its ISIN", () => {
    const v = view(d, manual, ledgers);
    const plan = planMyInvestorInclusion(d, {
      assetIdFor: (key) => `new:${key}`,
      links: [
        { assetId: "global", productKey: keyOf(A) },
        { assetId: "world", productKey: keyOf(B) },
      ],
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      productKeys: [],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.command.holdings).toEqual([]);
    expect(plan.command.links).toEqual([
      { assetId: "global", productKey: keyOf(A) },
      {
        assetId: "world",
        productKey: keyOf(B),
        securityId: { kind: "isin", value: B },
      },
    ]);
    expect(
      plan.command.facts.facts.map((fact) => [fact.key, fact.payload.assetId]),
    ).toEqual([
      ["b1", "global"],
      ["b2", "global"],
      ["b3", "world"],
    ]);
  });

  test("refuses a holding that is not the product's twin, and one claimed twice", () => {
    const v = view(d, manual, ledgers);
    const base = {
      assetIdFor: (key: string) => key,
      ownership: [],
      productKeys: [],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    };

    expect(
      planMyInvestorInclusion(d, {
        ...base,
        links: [{ assetId: "other", productKey: keyOf(A) }],
      }).ok,
    ).toBe(false);
    const twice = planMyInvestorInclusion(d, {
      ...base,
      links: [{ assetId: "global", productKey: keyOf(A) }],
      productKeys: [keyOf(A)],
    });
    expect(twice).toEqual({
      error:
        "«Vanguard Global Stock Index Fund EUR Acc» se enlaza o se crea aparte, no las dos cosas.",
      ok: false,
    });
  });

  test("a holding with half a traspaso links only with its other half (#1393)", () => {
    // «Global» received a traspaso from «World» by hand: linking «Global» alone
    // would leave World's half as a flow nobody made.
    const paired = new Map(ledgers);
    paired.set("global", {
      ...ledgers.get("global")!,
      pairedWith: [{ assetId: "world", name: "Fidelity World (a mano)" }],
    });
    paired.set("world", {
      operations: [],
      pairedWith: [{ assetId: "global", name: "Global (a mano)" }],
      plan: null,
    });
    const v = view(d, manual, paired);
    const strong = v.rows.find((row) => row.key === keyOf(A))!;

    // World is only a name suggestion (never linked by default), so Global's
    // default «Enlazar» would strand the pair: it opens on «No incluir».
    expect(strong.twin!.defaultChoice).toBe("skip");
    const base = {
      assetIdFor: (key: string) => key,
      ownership: [],
      productKeys: [],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    };
    expect(
      planMyInvestorInclusion(d, {
        ...base,
        links: [{ assetId: "global", productKey: keyOf(A) }],
      }),
    ).toEqual({
      error:
        "«Global (a mano)» tiene un traspaso con «Fidelity World (a mano)»: enlaza los dos a la vez, o deshaz el traspaso antes.",
      ok: false,
    });
    expect(
      planMyInvestorInclusion(d, {
        ...base,
        links: [
          { assetId: "global", productKey: keyOf(A) },
          { assetId: "world", productKey: keyOf(B) },
        ],
      }).ok,
    ).toBe(true);
  });
});
