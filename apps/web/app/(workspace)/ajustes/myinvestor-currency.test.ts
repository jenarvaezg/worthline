/**
 * A fund of the robo-advisor in another currency (#1899, ADR 0072): MyInvestor states
 * its orders in the fund's class currency, and worthline writes them as it writes any
 * apunte captured outside the euro — in EUR at the ECB rate of their own day, with the
 * original apunte kept as the operation's `capture`. The holding is EUR, like every
 * holding. The conversion happens in the ONE fold the first start shows, the inclusion
 * writes and the sync applies (#1438); a missing rate never becomes a figure.
 * Hand-built facts, so each case states the figures it proves.
 */
import { createFxRateSnapshot, derivePosition } from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { describe, expect, test } from "vitest";

import { myInvestorRowNotes } from "./conexiones/myinvestor-first-start-view";
import type {
  MyInvestorDiscoveredProduct,
  MyInvestorDiscovery,
} from "./myinvestor-discovery";
import { myInvestorFirstStartView } from "./myinvestor-first-start";
import { planMyInvestorInclusion } from "./myinvestor-inclusion-plan";
import {
  foldMyInvestorOperations,
  myInvestorOperationId,
} from "./myinvestor-operations-fold";
import { isIncludable } from "./myinvestor-selection";
import { planMyInvestorSync } from "./myinvestor-sync-plan";
import { findMyInvestorTwins } from "./myinvestor-twins";

const SOURCE = "src";
const ROBO = "securities:9";
const BLOCK = "portfolio:9";
const EURO_FUND = "IE0000000058";
const DOLLAR_FUND = "IE0000000047";

const keyOf = (isin: string) => `${ROBO}|isin:${isin}`;

/** One dollar is worth 0,90 € every day of these cases. */
const RATES = createFxRateSnapshot({
  USD: [
    { dateKey: "2025-03-10", eurPerUnit: 0.9 },
    { dateKey: "2025-07-15", eurPerUnit: 0.8 },
    { dateKey: "2026-10-20", eurPerUnit: 0.9 },
  ],
});
const NO_RATES = createFxRateSnapshot({});

function op(
  reference: string,
  isin: string,
  overrides: Partial<MyInvestorOperationFact>,
): { key: string; dateKey: string; payload: MyInvestorOperationFact } {
  const payload: MyInvestorOperationFact = {
    accountId: ROBO,
    amount: null,
    currency: "EUR",
    executedAt: "2025-03-10",
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

function robo(operations: ReturnType<typeof op>[]): MyInvestorDiscovery {
  return {
    accounts: [
      {
        key: BLOCK,
        kind: "portfolio",
        label: "Cartera sintética",
        otherHolder: false,
        sub: "Roboadvisor · cuenta de valores ···0009",
      },
    ],
    operations,
    products: [
      {
        accountKey: BLOCK,
        cash: null,
        declared: { currency: "EUR", value: "180.00" },
        identifier: null,
        instrument: null,
        key: BLOCK,
        kind: "managed",
        members: ["Euro", "Dólar", "Cuenta (efectivo)"],
        name: "Cartera sintética",
        otherHolder: false,
        portfolioKey: null,
        units: null,
      },
      member(EURO_FUND, "Euro", "4"),
      member(DOLLAR_FUND, "Dólar", "10"),
      {
        accountKey: BLOCK,
        cash: { balance: "3.21", currency: "EUR", withheld: "0" },
        declared: null,
        identifier: "ES00 ···0000",
        instrument: null,
        key: "cash:8",
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
}

// 4 participaciones a 20 € y 10 a 10 US$: 100 US$ el 10/03/2025, a 0,90 € el dólar.
const EURO_BUY = op("e1", EURO_FUND, { amount: "80.00", units: "4" });
const DOLLAR_BUY = op("d1", DOLLAR_FUND, {
  amount: "100.00",
  currency: "USD",
  pricePerUnit: "10",
  units: "10",
});

function view(d: MyInvestorDiscovery, rates = RATES) {
  const linkedKeys = new Set<string>();
  return myInvestorFirstStartView(d, {
    ledgers: new Map(),
    linkedKeys,
    rates,
    sourceId: SOURCE,
    today: "2026-11-04",
    twins: findMyInvestorTwins(d, { linkedKeys, manual: [] }),
  });
}

describe("the fold writes a dollar order in euros, keeping the dollars", () => {
  test("its price is the dollar price at the ECB rate of its day; the capture keeps the order", () => {
    const fold = foldMyInvestorOperations(robo([EURO_BUY, DOLLAR_BUY]), SOURCE, RATES);

    const [dollar] = fold.rows.get(keyOf(DOLLAR_FUND))!;
    expect(dollar).toMatchObject({
      capture: { currency: "USD", eurPerUnit: 0.9, feesMinor: 0, pricePerUnit: "10" },
      currency: "EUR",
      pricePerUnit: "9",
    });
    expect(
      derivePosition([dollar!], { assetId: "x", currency: "EUR" }).costBasis.amountMinor,
    ).toBe(9000);
    expect(fold.missingRates.size).toBe(0);
  });

  test("a euro order goes through untouched, with no capture", () => {
    const fold = foldMyInvestorOperations(robo([EURO_BUY]), SOURCE, NO_RATES);
    const [euro] = fold.rows.get(keyOf(EURO_FUND))!;
    expect(euro).toMatchObject({ currency: "EUR", pricePerUnit: "20" });
    expect(euro!.capture).toBeUndefined();
  });

  test("the provisional cost of an entry from another institution is converted too", () => {
    const entry = op("x1", DOLLAR_FUND, {
      amount: "50.00",
      currency: "USD",
      executedAt: "2025-07-15",
      operation: "transfer_in",
      sourceType: "IIC_SWITCH_REGISTRATION",
      transfer: {
        inheritedCost: "pending",
        pairing: "external_in",
        transferId: "myinvestor-external:x1",
      },
      units: "5",
    });
    const fold = foldMyInvestorOperations(robo([entry]), SOURCE, RATES);
    const [row] = fold.rows.get(keyOf(DOLLAR_FUND))!;
    // 50 US$ a 0,80 €: 40 €, never 50 «€».
    expect(row).toMatchObject({
      currency: "EUR",
      transferCostMinor: 4000,
      transferLegState: "cost_pending",
    });
  });

  test("with no ECB rate for its day, the order is left out and its day named", () => {
    const later = op("d2", DOLLAR_FUND, {
      amount: "30.00",
      currency: "USD",
      executedAt: "2025-09-01",
      units: "3",
    });
    const fold = foldMyInvestorOperations(
      robo([EURO_BUY, DOLLAR_BUY, later]),
      SOURCE,
      RATES,
    );
    expect(fold.rows.get(keyOf(DOLLAR_FUND))!.map((row) => row.id)).toEqual([
      myInvestorOperationId(SOURCE, "d1"),
    ]);
    expect(fold.missingRates).toEqual(new Map([[keyOf(DOLLAR_FUND), "2025-09-01"]]));
  });

  test("a currency worthline cannot capture is never written", () => {
    const yen = op("y1", DOLLAR_FUND, { amount: "1000", currency: "JPY", units: "1" });
    const fold = foldMyInvestorOperations(robo([yen]), SOURCE, RATES);
    expect(fold.rows.get(keyOf(DOLLAR_FUND)) ?? []).toEqual([]);
  });
});

describe("the robo-advisor's block with a dollar fund", () => {
  test("it can be included: no currency block, and its value is in euros", () => {
    const v = view(robo([EURO_BUY, DOLLAR_BUY]));
    const [row] = v.rows;
    expect(row).toMatchObject({ block: null, key: BLOCK, selectedByDefault: true });
    expect(isIncludable(row!)).toBe(true);
    // 80 € + 90 € (100 US$) + 3,21 € of cash.
    expect(row!.valueMinor).toBe(8000 + 9000 + 321);
    expect(myInvestorRowNotes(row!, String)).toEqual([]);
  });

  test("with no ECB rate, the block waits and says which day, never a figure", () => {
    const v = view(robo([EURO_BUY, DOLLAR_BUY]), NO_RATES);
    const [row] = v.rows;
    expect(row!.block).toEqual({ date: "2025-03-10", reason: "rate_missing" });
    expect(isIncludable(row!)).toBe(false);
    expect(row!.selectedByDefault).toBe(false);
    expect(myInvestorRowNotes(row!, String)).toEqual([
      "Falta el tipo de cambio del BCE del 10/03: vuelve a probar mañana",
    ]);
  });

  test("a currency outside the capture vocabulary still blocks as today", () => {
    const yen = op("y1", DOLLAR_FUND, { amount: "1000", currency: "JPY", units: "1" });
    const [row] = view(robo([EURO_BUY, yen])).rows;
    expect(row!.block).toEqual({ reason: "currency" });
    expect(myInvestorRowNotes(row!, String)).toEqual([
      "Opera en otra divisa: aún no se puede incluir",
    ]);
  });

  test("including it writes the dollar fund's operations in euros, with their capture", () => {
    const d = robo([EURO_BUY, DOLLAR_BUY]);
    const v = view(d);
    const plan = planMyInvestorInclusion(d, {
      assetIdFor: (key) => `new:${key}`,
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      productKeys: [BLOCK],
      rates: RATES,
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: v,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const dollar = plan.command.facts.facts.find((fact) => fact.key === "d1")!;
    expect(dollar.payload).toMatchObject({
      assetId: `new:${keyOf(DOLLAR_FUND)}`,
      capture: { currency: "USD", eurPerUnit: 0.9, pricePerUnit: "10" },
      currency: "EUR",
      pricePerUnit: "9",
    });
    // The holding is EUR, like every holding (ADR 0072, decision 5).
    const holding = plan.command.holdings.find(
      (entry) => entry.productKey === keyOf(DOLLAR_FUND),
    )!;
    expect(holding.holding.asset.currency).toBe("EUR");
  });
});

describe("the daily sync of a dollar fund", () => {
  const links = [
    { assetId: "a-euro", productKey: keyOf(EURO_FUND) },
    { assetId: "a-dollar", productKey: keyOf(DOLLAR_FUND) },
  ];
  const NEW_DOLLAR = op("d9", DOLLAR_FUND, {
    amount: "20.00",
    currency: "USD",
    executedAt: "2026-10-20",
    units: "2",
  });
  const NEW_EURO = op("e9", EURO_FUND, {
    amount: "40.00",
    executedAt: "2026-10-20",
    units: "2",
  });

  test("a new dollar order is applied in euros with its capture", () => {
    const plan = planMyInvestorSync(robo([EURO_BUY, DOLLAR_BUY, NEW_DOLLAR]), {
      cursor: "2026-11-04",
      links,
      rates: RATES,
      sourceId: SOURCE,
      windowKeys: new Set(["d9"]),
    });
    expect(plan.facts.facts.find((fact) => fact.key === "d9")?.payload).toMatchObject({
      assetId: "a-dollar",
      capture: { currency: "USD", eurPerUnit: 0.9, pricePerUnit: "10" },
      currency: "EUR",
      pricePerUnit: "9",
    });
  });

  test("with no rate it waits; the rest of the pass is applied", () => {
    const plan = planMyInvestorSync(robo([EURO_BUY, DOLLAR_BUY, NEW_DOLLAR, NEW_EURO]), {
      cursor: "2026-11-04",
      links,
      rates: NO_RATES,
      sourceId: SOURCE,
      windowKeys: new Set(["d9", "e9"]),
    });
    expect(plan.facts.facts.map((fact) => fact.key)).toEqual(["e9"]);
  });

  test("an order that waited is planned again once its day falls out of the window", () => {
    // The ledger drops whatever was already applied: a dollar order is asked about
    // until it lands, so a long ECB gap cannot lose it behind the cursor.
    const plan = planMyInvestorSync(robo([EURO_BUY, DOLLAR_BUY, NEW_DOLLAR, NEW_EURO]), {
      cursor: "2026-12-20",
      links,
      rates: RATES,
      sourceId: SOURCE,
      windowKeys: new Set(),
    });
    expect(plan.facts.facts.map((fact) => fact.key).sort()).toEqual(["d1", "d9"]);
  });
});
