/**
 * A robo-advisor's account as a managed portfolio, pure (#1883): ONE row whose
 * funds — those the manager sold too — and cash ride under it; including it plans ONE
 * portfolio with the declared balance as witness; a portfolio kept by hand is
 * offered as a block, careed fund by fund, and blocked by a member MyInvestor lacks.
 */
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { describe, expect, test } from "vitest";

import type {
  MyInvestorDiscoveredProduct,
  MyInvestorDiscovery,
} from "./myinvestor-discovery";
import {
  findMyInvestorTwins,
  type MyInvestorTwinLedger,
  myInvestorFirstStartView,
  planMyInvestorInclusion,
} from "./myinvestor-first-start";
import {
  findMyInvestorPortfolioTwins,
  type MyInvestorManualPortfolio,
} from "./myinvestor-portfolio";
import {
  defaultMyInvestorTwinChoices,
  summarizeMyInvestorSelection,
} from "./myinvestor-selection";

const SOURCE = "src";
const ROBO = "securities:9";
const BLOCK = "portfolio:9";
const GOLD = "IE0000000011";
const SILVER = "IE0000000022";
const COPPER = "IE0000000033";
const OWNER = [{ memberId: "m", shareBps: 10_000 }];

const keyOf = (isin: string) => `${ROBO}|isin:${isin}`;

function op(
  reference: string,
  isin: string,
  overrides: Partial<MyInvestorOperationFact>,
): { key: string; dateKey: string; payload: MyInvestorOperationFact } {
  const payload: MyInvestorOperationFact = {
    accountId: ROBO,
    amount: null,
    currency: "EUR",
    executedAt: "2025-02-11",
    fees: "0",
    instrument: { code: isin, scheme: "isin" },
    instrumentName: `Fondo ${isin.slice(-2)}`,
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
  return { dateKey: payload.executedAt.slice(0, 10), key: reference, payload };
}

function member(isin: string, name: string, units: string): MyInvestorDiscoveredProduct {
  return {
    accountKey: BLOCK,
    cash: null,
    declared: null,
    identifier: isin,
    instrument: { code: isin, scheme: "isin" },
    key: keyOf(isin),
    kind: "fund",
    members: [],
    name,
    otherHolder: false,
    portfolioKey: BLOCK,
    units,
  };
}

const robo: MyInvestorDiscovery = {
  accounts: [
    {
      key: BLOCK,
      kind: "portfolio",
      label: "Cartera sintética",
      otherHolder: false,
      sub: "Roboadvisor · cuenta de valores ···0009",
    },
  ],
  operations: [
    op("g1", GOLD, { amount: "301.17", units: "11.0213" }),
    op("s1", SILVER, { amount: "203.41", executedAt: "2025-03-12", units: "7.1191" }),
    op("c1", COPPER, { amount: "51.13", executedAt: "2025-01-14", units: "3.0113" }),
    op("c2", COPPER, {
      amount: "52.07",
      executedAt: "2025-06-17",
      operation: "sell",
      units: "3.0113",
    }),
  ],
  products: [
    {
      accountKey: BLOCK,
      cash: null,
      declared: { currency: "EUR", value: "509.83" },
      identifier: null,
      instrument: null,
      key: BLOCK,
      kind: "managed",
      members: ["Oro", "Plata", "Cuenta (efectivo)"],
      name: "Cartera sintética",
      otherHolder: false,
      portfolioKey: null,
      units: null,
    },
    member(GOLD, "Oro", "11.0213"),
    member(SILVER, "Plata", "7.1191"),
    member(COPPER, "Cobre", "0"),
    {
      accountKey: BLOCK,
      cash: { balance: "7.34", currency: "EUR", withheld: "0" },
      declared: null,
      identifier: "ES00 ···0000",
      instrument: null,
      key: "cash:7",
      kind: "cash",
      members: [],
      name: "Cuenta",
      otherHolder: false,
      portfolioKey: BLOCK,
      units: null,
    },
  ],
  readOn: "2026-11-04",
  version: 2,
};

function view(
  portfolios: MyInvestorManualPortfolio[] = [],
  ledgers: Map<string, MyInvestorTwinLedger> = new Map(),
) {
  const linkedKeys = new Set<string>();
  return myInvestorFirstStartView(robo, {
    ledgers,
    linkedKeys,
    portfolioTwins: findMyInvestorPortfolioTwins(robo, { linkedKeys, portfolios }),
    sourceId: SOURCE,
    today: "2026-11-04",
    twins: findMyInvestorTwins(robo, { linkedKeys, manual: [] }),
  });
}

function plan(
  v: ReturnType<typeof view>,
  input: { productKeys?: string[]; links?: { productKey: string; assetId: string }[] },
) {
  return planMyInvestorInclusion(robo, {
    assetIdFor: (key) => `new:${key}`,
    links: input.links ?? [],
    ownership: OWNER,
    productKeys: input.productKeys ?? [],
    sourceId: SOURCE,
    symbols: new Map(),
    today: "2026-11-04",
    view: v,
  });
}

describe("the robo-advisor's account is one row", () => {
  test("its funds — the sold one too — and its cash ride under it, never as rows", () => {
    const v = view();
    expect(v.rows.map((row) => row.key)).toEqual([BLOCK]);
    const row = v.rows[0]!;
    expect(row).toMatchObject({
      block: null,
      kind: "managed",
      operations: 4,
      portfolioTwin: null,
      selectedByDefault: true,
      since: "2025-01-14",
      // The funds at the cost of the same fold the batch writes, plus the cash.
      valueMinor: 30_117 + 20_341 + 734,
    });
    expect(row.portfolio).toMatchObject({
      cash: { key: "cash:7", valueMinor: 734 },
      declaredMinor: 50_983,
    });
    expect(
      row.portfolio!.members.map((fund) => [
        fund.name,
        fund.soldByManager,
        fund.valueMinor,
      ]),
    ).toEqual([
      ["Oro", false, 30_117],
      ["Plata", false, 20_341],
      ["Cobre", true, 0],
    ]);
    // In «Así queda tu patrimonio» it counts as ONE portfolio: funds in Invertido,
    // its cash in Líquido, as the patrimonio files them.
    const summary = summarizeMyInvestorSelection(v.rows, new Set([BLOCK]));
    expect(summary).toMatchObject({
      byRung: { invested: 50_458, liquid: 734, retirement: 0 },
      count: 1,
      operations: 4,
    });
  });

  test("including it plans ONE portfolio: every fund, the cash sibling and the witness", () => {
    const result = plan(view(), { productKeys: [BLOCK] });
    if (!result.ok) throw new Error(result.error);
    const { command } = result;

    expect(command.holdings.map((entry) => entry.productKey)).toEqual([
      keyOf(GOLD),
      keyOf(SILVER),
      keyOf(COPPER),
      "cash:7",
    ]);
    expect(command.holdings[3]!.holding).toMatchObject({
      asset: { currentValueMinor: 734, type: "cash" },
      kind: "cash",
    });
    expect(command.portfolios).toEqual([
      {
        memberAssetIds: [
          `new:${keyOf(GOLD)}`,
          `new:${keyOf(SILVER)}`,
          `new:${keyOf(COPPER)}`,
          "new:cash:7",
        ],
        name: "Cartera sintética",
        productKey: BLOCK,
        provider: "MyInvestor",
        scopeId: "m",
        witness: {
          declaredDate: "2026-11-04",
          declaredValue: { amountMinor: 50_983, currency: "EUR" },
        },
      },
    ]);
    // The sold fund keeps its whole history: the portfolio's return needs it (#1552).
    expect(
      command.facts.facts
        .filter((fact) => fact.payload.assetId === `new:${keyOf(COPPER)}`)
        .map((fact) => fact.payload.kind),
    ).toEqual(["buy", "sell"]);
  });

  test("a fund of the block is never included on its own", () => {
    const result = plan(view(), { productKeys: [keyOf(GOLD)] });
    expect(result).toEqual({
      error: "«Oro» se incluye con su cartera gestionada, no por separado.",
      ok: false,
    });
  });
});

describe("a portfolio kept by hand, offered as a block", () => {
  const goldBuy = {
    assetId: "hand-gold",
    currency: "EUR",
    executedAt: "2025-02-11",
    feesMinor: 0,
    id: "m1",
    kind: "buy" as const,
    pricePerUnit: "27.32622",
    units: "11.0213",
  };
  const ledgers = new Map<string, MyInvestorTwinLedger>([
    ["hand-gold", { operations: [goldBuy], pairedWith: [], plan: null }],
  ]);
  const metal: MyInvestorManualPortfolio = {
    href: "/patrimonio/carteras/wl_prt_1",
    id: "metal",
    members: [
      {
        code: GOLD,
        id: "hand-gold",
        name: "Oro (a mano)",
        type: "investment",
        valueMinor: 0,
      },
      { code: null, id: "box", name: "Efectivo Metal", type: "cash", valueMinor: 517 },
    ],
    name: "Metal",
  };

  test("it opens set to link, careed fund by fund, with the cash before and after", () => {
    const v = view([metal], ledgers);
    const row = v.rows[0]!;
    const twin = row.portfolioTwin!;
    expect(row.selectedByDefault).toBe(false);
    expect(defaultMyInvestorTwinChoices(v.rows).get(BLOCK)).toBe("link:metal");
    const [candidate] = twin.candidates;
    expect(candidate).toMatchObject({
      blockers: [],
      cash: { afterMinor: 734, assetId: "box", beforeMinor: 517 },
      portfolioId: "metal",
    });
    expect(candidate!.members.map((fund) => [fund.name, fund.assetId])).toEqual([
      ["Oro", "hand-gold"],
      ["Plata", null],
      ["Cobre", null],
    ]);
    expect(candidate!.members[0]!.careo!.counts).toMatchObject({ manual: 1, same: 1 });
    // Same units, so Oro adds nothing; Plata enters whole; the cash by difference.
    expect(candidate!.valueDeltaMinor).toBe(20_341 + (734 - 517));
    const summary = summarizeMyInvestorSelection(
      v.rows,
      new Set(),
      defaultMyInvestorTwinChoices(v.rows),
    );
    expect(summary).toMatchObject({ count: 0, linked: 1, valueMinor: 20_558 });
  });

  test("linking plans the members, the cash and the funds it lacked, in one command", () => {
    const result = plan(view([metal], ledgers), {
      links: [{ assetId: "metal", productKey: BLOCK }],
    });
    if (!result.ok) throw new Error(result.error);
    const { command } = result;

    expect(command.links).toEqual([{ assetId: "hand-gold", productKey: keyOf(GOLD) }]);
    expect(command.cashLinks).toEqual([
      { assetId: "box", balanceMinor: 734, productKey: "cash:7" },
    ]);
    expect(command.holdings.map((entry) => entry.productKey)).toEqual([
      keyOf(SILVER),
      keyOf(COPPER),
    ]);
    expect(command.portfolioLinks).toEqual([
      {
        addMemberAssetIds: [`new:${keyOf(SILVER)}`, `new:${keyOf(COPPER)}`],
        portfolioId: "metal",
        productKey: BLOCK,
        witness: {
          declaredDate: "2026-11-04",
          declaredValue: { amountMinor: 50_983, currency: "EUR" },
        },
      },
    ]);
    expect(
      command.facts.facts
        .filter((fact) => fact.payload.assetId === "hand-gold")
        .map((fact) => fact.key),
    ).toEqual(["g1"]);
    expect(command.portfolios).toBeUndefined();
  });

  test("a manual member MyInvestor lacks blocks the link, and the block opens unticked", () => {
    const bronze: MyInvestorManualPortfolio = {
      ...metal,
      members: [
        ...metal.members,
        {
          code: "IE0000000044",
          id: "hand-bronze",
          name: "Bronce (a mano)",
          type: "investment",
          valueMinor: 0,
        },
      ],
    };
    const v = view([bronze], ledgers);
    expect(v.rows[0]!.portfolioTwin!.candidates[0]!.blockers).toEqual([
      "Bronce (a mano)",
    ]);
    expect(defaultMyInvestorTwinChoices(v.rows).get(BLOCK)).toBe("skip");
    expect(v.rows[0]!.selectedByDefault).toBe(false);

    const result = plan(v, { links: [{ assetId: "metal", productKey: BLOCK }] });
    expect(result).toEqual({
      error:
        "No se puede enlazar: «Bronce (a mano)» está en tu cartera y MyInvestor no lo tiene en esta cuenta. Sácalo de la cartera o envíalo a la papelera, y vuelve aquí.",
      ok: false,
    });
  });

  test("with no cash account at MyInvestor, the cash box stays manual and does not block", () => {
    const noCash: MyInvestorDiscovery = {
      ...robo,
      products: robo.products.filter((product) => product.key !== "cash:7"),
    };
    const linkedKeys = new Set<string>();
    const v = myInvestorFirstStartView(noCash, {
      ledgers,
      linkedKeys,
      portfolioTwins: findMyInvestorPortfolioTwins(noCash, {
        linkedKeys,
        portfolios: [metal],
      }),
      sourceId: SOURCE,
      today: "2026-11-04",
      twins: new Map(),
    });
    const [candidate] = v.rows[0]!.portfolioTwin!.candidates;
    expect(candidate).toMatchObject({ blockers: [], cash: null });
    const result = planMyInvestorInclusion(noCash, {
      assetIdFor: (key) => `new:${key}`,
      links: [{ assetId: "metal", productKey: BLOCK }],
      ownership: OWNER,
      productKeys: [],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    });
    expect(result.ok && result.command.cashLinks).toBeUndefined();
  });

  test("a portfolio with no fund of the block is not offered", () => {
    const other: MyInvestorManualPortfolio = {
      ...metal,
      members: [
        {
          code: "IE0000000044",
          id: "x",
          name: "Otro",
          type: "investment",
          valueMinor: 0,
        },
      ],
    };
    expect(view([other], ledgers).rows[0]!.portfolioTwin).toBeNull();
  });
});

describe("a block already linked whose manager bought a fund since", () => {
  const linkedKeys = new Set([keyOf(GOLD), keyOf(COPPER), "cash:7"]);
  const v = myInvestorFirstStartView(robo, {
    connectedPortfolios: new Map([
      [BLOCK, { name: "Cartera sintética", portfolioId: "p9" }],
    ]),
    ledgers: new Map(),
    linkedKeys,
    portfolioTwins: findMyInvestorPortfolioTwins(robo, { linkedKeys, portfolios: [] }),
    sourceId: SOURCE,
    today: "2026-11-04",
    twins: findMyInvestorTwins(robo, { linkedKeys, manual: [] }),
  });

  test("only what is new is offered, and it joins the portfolio the block lives in", () => {
    const row = v.rows[0]!;
    expect(row.linked).toBe(false);
    expect(row.portfolio).toMatchObject({
      cash: null,
      joins: { name: "Cartera sintética", portfolioId: "p9" },
    });
    expect(row.portfolio!.members.map((member) => member.name)).toEqual(["Plata"]);
    expect(row.valueMinor).toBe(20_341);

    const result = plan(v, { productKeys: [BLOCK] });
    if (!result.ok) throw new Error(result.error);
    expect(result.command.holdings.map((entry) => entry.productKey)).toEqual([
      keyOf(SILVER),
    ]);
    expect(result.command.portfolios).toBeUndefined();
    expect(result.command.portfolioLinks).toEqual([
      {
        addMemberAssetIds: [`new:${keyOf(SILVER)}`],
        portfolioId: "p9",
        productKey: BLOCK,
        witness: {
          declaredDate: "2026-11-04",
          declaredValue: { amountMinor: 50_983, currency: "EUR" },
        },
      },
    ]);
  });

  test("its portfolio dissolved since: the new fund is offered as a product of its own", () => {
    // The owner dissolved the portfolio in worthline: there is nothing to join.
    const dissolved = myInvestorFirstStartView(robo, {
      ledgers: new Map(),
      linkedKeys,
      portfolioTwins: findMyInvestorPortfolioTwins(robo, { linkedKeys, portfolios: [] }),
      sourceId: SOURCE,
      today: "2026-11-04",
      twins: findMyInvestorTwins(robo, { linkedKeys, manual: [] }),
    });
    expect(dissolved.rows.map((row) => [row.key, row.linked])).toEqual([
      [BLOCK, true],
      [keyOf(SILVER), false],
    ]);
    expect(dissolved.rows[1]).toMatchObject({
      kind: "fund",
      portfolio: null,
      selectedByDefault: true,
      valueMinor: 20_341,
    });

    const result = plan(dissolved, { productKeys: [keyOf(SILVER)] });
    if (!result.ok) throw new Error(result.error);
    expect(result.command.holdings.map((entry) => entry.productKey)).toEqual([
      keyOf(SILVER),
    ]);
    expect(result.command.portfolios).toBeUndefined();
    expect(result.command.portfolioLinks).toBeUndefined();
  });

  test("a block linked whole is linked, and offers nothing", () => {
    const all = new Set([keyOf(GOLD), keyOf(SILVER), keyOf(COPPER), "cash:7"]);
    const whole = myInvestorFirstStartView(robo, {
      connectedPortfolios: new Map([[BLOCK, { name: "Cartera", portfolioId: "p9" }]]),
      ledgers: new Map(),
      linkedKeys: all,
      sourceId: SOURCE,
      today: "2026-11-04",
      twins: new Map(),
    });
    expect(whole.rows[0]!.linked).toBe(true);
  });
});
