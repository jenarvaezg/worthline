/**
 * A fund of the robo-advisor in another currency (#1899, ADR 0072): MyInvestor states
 * its orders in the fund's class currency, and worthline writes them as it writes any
 * apunte captured outside the euro — in EUR at the ECB rate of their own day, with the
 * original apunte kept as the operation's `capture`. The holding is EUR, like every
 * holding.
 *
 * The rates are asked when MyInvestor is read and kept WITH the read (`fxRates`), so
 * the first start's fold, the inclusion and the sync convert with exactly the same
 * ones (#1438) and the Conexiones page reads only the store. A missing rate never
 * becomes a figure, and a traspaso waits whole.
 * Hand-built facts, so each case states the figures it proves.
 */
import type { FxRatePoint } from "@worthline/domain";
import { derivePosition } from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { describe, expect, test, vi } from "vitest";

import { myInvestorRowNotes } from "./conexiones/myinvestor-first-start-view";
import {
  type MyInvestorDiscoveredProduct,
  type MyInvestorDiscovery,
  parseMyInvestorDiscovery,
  serializeMyInvestorDiscovery,
} from "./myinvestor-discovery";
import { myInvestorFirstStartView } from "./myinvestor-first-start";
import { planMyInvestorInclusion } from "./myinvestor-inclusion-plan";
import {
  foldMyInvestorOperations,
  myInvestorOperationId,
} from "./myinvestor-operations-fold";
import { MYINVESTOR_ECB_TIMEOUT_MS, withMyInvestorRates } from "./myinvestor-rates";
import { isIncludable } from "./myinvestor-selection";
import { planMyInvestorSync } from "./myinvestor-sync-plan";
import { findMyInvestorTwins } from "./myinvestor-twins";

const SOURCE = "src";
const ROBO = "securities:9";
const BLOCK = "portfolio:9";
const EURO_FUND = "IE0000000058";
const DOLLAR_FUND = "IE0000000047";
const MONEY_FUND = "IE0000000069";

const keyOf = (isin: string) => `${ROBO}|isin:${isin}`;
const idOf = (factKey: string) => myInvestorOperationId(SOURCE, factKey);

/** What the ECB said when MyInvestor was read: 0,90 € or 0,80 € the dollar. */
const USD_RATES: Record<string, FxRatePoint[]> = {
  USD: [
    { dateKey: "2025-03-10", eurPerUnit: 0.9 },
    { dateKey: "2025-07-15", eurPerUnit: 0.8 },
    { dateKey: "2026-10-20", eurPerUnit: 0.9 },
  ],
};

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

function robo(
  operations: ReturnType<typeof op>[],
  fxRates: Record<string, FxRatePoint[]> | null = USD_RATES,
): MyInvestorDiscovery {
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
    ...(fxRates ? { fxRates } : {}),
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
      member(MONEY_FUND, "Monetario", "0"),
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

/** A traspaso from the euro fund into the dollar class, on a day of the read. */
function switchIntoDollars(day: string) {
  const transferId = "myinvestor-transfer:s-out:s-in";
  return [
    op("s-out", EURO_FUND, {
      amount: "40.00",
      executedAt: day,
      operation: "transfer_out",
      sourceType: "IIC_SWITCH_DEREGISTRATION",
      transfer: { counterpartKey: "s-in", pairing: "paired", transferId },
      units: "2",
    }),
    op("s-in", DOLLAR_FUND, {
      amount: "44.00",
      currency: "USD",
      executedAt: day,
      operation: "transfer_in",
      sourceType: "IIC_SWITCH_REGISTRATION",
      transfer: { counterpartKey: "s-out", pairing: "paired", transferId },
      units: "4",
    }),
  ];
}

/** A traspaso between two funds of the robo-advisor, paired as the adapter pairs it. */
function switchBetween(
  ref: string,
  from: { isin: string; currency?: string },
  to: { isin: string; currency?: string },
  day: string,
) {
  const transferId = `myinvestor-transfer:${ref}-out:${ref}-in`;
  return [
    op(`${ref}-out`, from.isin, {
      amount: "10.00",
      currency: from.currency ?? "EUR",
      executedAt: day,
      operation: "transfer_out",
      sourceType: "IIC_SWITCH_DEREGISTRATION",
      transfer: { counterpartKey: `${ref}-in`, pairing: "paired", transferId },
      units: "1",
    }),
    op(`${ref}-in`, to.isin, {
      amount: "10.00",
      currency: to.currency ?? "EUR",
      executedAt: day,
      operation: "transfer_in",
      sourceType: "IIC_SWITCH_REGISTRATION",
      transfer: { counterpartKey: `${ref}-out`, pairing: "paired", transferId },
      units: "1",
    }),
  ];
}

function view(d: MyInvestorDiscovery) {
  const linkedKeys = new Set<string>();
  return myInvestorFirstStartView(d, {
    ledgers: new Map(),
    linkedKeys,
    sourceId: SOURCE,
    today: "2026-11-04",
    twins: findMyInvestorTwins(d, { linkedKeys, manual: [] }),
  });
}

describe("the fold writes a dollar order in euros, keeping the dollars", () => {
  test("its price is the dollar price at the ECB rate of its day; the capture keeps the order", () => {
    const fold = foldMyInvestorOperations(robo([EURO_BUY, DOLLAR_BUY]), SOURCE);

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
    const fold = foldMyInvestorOperations(robo([EURO_BUY], null), SOURCE);
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
    const fold = foldMyInvestorOperations(robo([entry]), SOURCE);
    const [row] = fold.rows.get(keyOf(DOLLAR_FUND))!;
    // 50 US$ a 0,80 €: 40 €, never 50 «€».
    expect(row).toMatchObject({
      currency: "EUR",
      transferCostMinor: 4000,
      transferLegState: "cost_pending",
    });
  });

  test("with no ECB rate for its day, the order is left out and its product named", () => {
    const later = op("d2", DOLLAR_FUND, {
      amount: "30.00",
      currency: "USD",
      executedAt: "2025-09-01",
      units: "3",
    });
    const fold = foldMyInvestorOperations(robo([EURO_BUY, DOLLAR_BUY, later]), SOURCE);
    expect(fold.rows.get(keyOf(DOLLAR_FUND))!.map((row) => row.id)).toEqual([idOf("d1")]);
    expect(fold.missingRates).toEqual(new Set([keyOf(DOLLAR_FUND)]));
  });

  test("a currency worthline cannot capture is never written", () => {
    const yen = op("y1", DOLLAR_FUND, { amount: "1000", currency: "JPY", units: "1" });
    const fold = foldMyInvestorOperations(robo([yen]), SOURCE);
    expect(fold.rows.get(keyOf(DOLLAR_FUND)) ?? []).toEqual([]);
  });

  test("a traspaso waits whole: with no rate for its dollar leg, its euro leg waits too", () => {
    const fold = foldMyInvestorOperations(
      robo([EURO_BUY, DOLLAR_BUY, ...switchIntoDollars("2025-09-01")]),
      SOURCE,
    );
    expect(fold.rows.get(keyOf(EURO_FUND))!.map((row) => row.id)).toEqual([idOf("e1")]);
    expect(fold.rows.get(keyOf(DOLLAR_FUND))!.map((row) => row.id)).toEqual([idOf("d1")]);
    expect(fold.missingRates).toEqual(new Set([keyOf(EURO_FUND), keyOf(DOLLAR_FUND)]));
  });

  test("after a leg that waits, the rest of its holding waits behind it", () => {
    // A later buy of the euro fund would otherwise be folded on a ledger missing the
    // way out, and the cost a later traspaso carries would move when it lands.
    const laterEuro = op("e2", EURO_FUND, {
      amount: "21.00",
      executedAt: "2025-10-01",
      units: "1",
    });
    const fold = foldMyInvestorOperations(
      robo([EURO_BUY, ...switchIntoDollars("2025-09-01"), laterEuro]),
      SOURCE,
    );
    expect(fold.rows.get(keyOf(EURO_FUND))!.map((row) => row.id)).toEqual([idOf("e1")]);
  });
});

describe("the robo-advisor's block with a dollar fund", () => {
  test("it can be included: no currency block, and its value is in euros", () => {
    const [row] = view(robo([EURO_BUY, DOLLAR_BUY])).rows;
    expect(row).toMatchObject({ block: null, key: BLOCK, selectedByDefault: true });
    expect(isIncludable(row!)).toBe(true);
    // 80 € + 90 € (100 US$) + 3,21 € of cash.
    expect(row!.valueMinor).toBe(8000 + 9000 + 321);
    expect(myInvestorRowNotes(row!, String)).toEqual([]);
  });

  test("with no ECB rate in the read, the block waits for the next read, never a figure", () => {
    const [row] = view(robo([EURO_BUY, DOLLAR_BUY], null)).rows;
    expect(row!.block).toEqual({ reason: "rate_missing" });
    expect(isIncludable(row!)).toBe(false);
    expect(row!.selectedByDefault).toBe(false);
    expect(myInvestorRowNotes(row!, String)).toEqual([
      "No pudimos traer el tipo de cambio del BCE al leer MyInvestor: se completará en la próxima puesta al día",
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
    const plan = planMyInvestorInclusion(d, {
      assetIdFor: (key) => `new:${key}`,
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      productKeys: [BLOCK],
      sourceId: SOURCE,
      symbols: new Map(),
      today: "2026-11-04",
      view: view(d),
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
  const inBook = (...keys: string[]) => new Set(keys.map(idOf));

  test("a new dollar order is applied in euros with its capture", () => {
    const plan = planMyInvestorSync(robo([EURO_BUY, DOLLAR_BUY, NEW_DOLLAR]), {
      bookIds: inBook("e1", "d1"),
      cursor: "2026-11-04",
      links,
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
    const plan = planMyInvestorSync(
      robo([EURO_BUY, DOLLAR_BUY, NEW_DOLLAR, NEW_EURO], { USD: [] }),
      {
        bookIds: inBook("e1", "d1"),
        cursor: "2026-11-04",
        links,
        sourceId: SOURCE,
        windowKeys: new Set(["d9", "e9"]),
      },
    );
    expect(plan.facts.facts.map((fact) => fact.key)).toEqual(["e9"]);
  });

  test("an order that waited is planned once its rate is in, out of the window too", () => {
    // Only what the book lacks: what already landed is not asked about again.
    const plan = planMyInvestorSync(robo([EURO_BUY, DOLLAR_BUY, NEW_DOLLAR, NEW_EURO]), {
      bookIds: inBook("e1", "d1", "e9"),
      cursor: "2026-12-20",
      links,
      sourceId: SOURCE,
      windowKeys: new Set(),
    });
    expect(plan.facts.facts.map((fact) => fact.key)).toEqual(["d9"]);
  });

  test("a traspaso into dollars with the ECB down: no leg reaches the book alone", () => {
    const plan = planMyInvestorSync(
      robo([EURO_BUY, DOLLAR_BUY, ...switchIntoDollars("2026-10-21")], { USD: [] }),
      {
        bookIds: inBook("e1", "d1"),
        cursor: "2026-11-04",
        links,
        sourceId: SOURCE,
        windowKeys: new Set(["s-out", "s-in"]),
      },
    );
    expect(plan.facts.facts).toEqual([]);
  });

  test("a traspaso that waited lands whole once its rate is in, out of the window too", () => {
    const rates = {
      USD: [...USD_RATES.USD!, { dateKey: "2026-10-21", eurPerUnit: 0.9 }],
    };
    const plan = planMyInvestorSync(
      robo([EURO_BUY, DOLLAR_BUY, ...switchIntoDollars("2026-10-21")], rates),
      {
        bookIds: inBook("e1", "d1"),
        cursor: "2026-12-20",
        links,
        sourceId: SOURCE,
        windowKeys: new Set(),
      },
    );
    expect(plan.facts.facts.map((fact) => fact.key).sort()).toEqual(["s-in", "s-out"]);
  });

  test("an account in euros only plans its window, as before", () => {
    const plan = planMyInvestorSync(robo([EURO_BUY, NEW_EURO], null), {
      bookIds: inBook(),
      cursor: "2026-11-04",
      links,
      sourceId: SOURCE,
      windowKeys: new Set(["e9"]),
    });
    expect(plan.facts.facts.map((fact) => fact.key)).toEqual(["e9"]);
  });

  describe("a chain of traspasos from one wait (A→D in dollars, then A→C, then a buy in C)", () => {
    const chain = [
      ...switchBetween(
        "s",
        { isin: EURO_FUND },
        { currency: "USD", isin: DOLLAR_FUND },
        "2026-10-21",
      ),
      ...switchBetween("t", { isin: EURO_FUND }, { isin: MONEY_FUND }, "2026-10-22"),
      op("c2", MONEY_FUND, { amount: "10.00", executedAt: "2026-10-25", units: "1" }),
    ];
    const chainLinks = [...links, { assetId: "a-money", productKey: keyOf(MONEY_FUND) }];

    test("with the ECB down, the whole chain waits: nothing of it is planned", () => {
      const plan = planMyInvestorSync(
        robo([EURO_BUY, DOLLAR_BUY, ...chain], { USD: [] }),
        {
          bookIds: inBook("e1", "d1"),
          cursor: "2026-11-04",
          links: chainLinks,
          sourceId: SOURCE,
          windowKeys: new Set(chain.map((fact) => fact.key)),
        },
      );
      expect(plan.facts.facts).toEqual([]);
    });

    test("back out of the window, the whole chain is planned — never half a traspaso", () => {
      const rates = {
        USD: [...USD_RATES.USD!, { dateKey: "2026-10-21", eurPerUnit: 0.9 }],
      };
      const plan = planMyInvestorSync(robo([EURO_BUY, DOLLAR_BUY, ...chain], rates), {
        bookIds: inBook("e1", "d1"),
        cursor: "2026-12-20",
        links: chainLinks,
        sourceId: SOURCE,
        windowKeys: new Set(),
      });
      expect(plan.facts.facts.map((fact) => fact.key).sort()).toEqual([
        "c2",
        "s-in",
        "s-out",
        "t-in",
        "t-out",
      ]);
    });
  });
});

describe("a currency worthline cannot capture, across a traspaso", () => {
  // A fund in yen has no ECB rate worthline captures in (ADR 0072, decision 6): it is
  // not waiting for anything, so nothing promises it will come.
  const fromYen = switchBetween(
    "j",
    { currency: "JPY", isin: MONEY_FUND },
    { isin: EURO_FUND },
    "2025-09-01",
  );

  test("the holding at the other end says «otra divisa», not that a rate will come", () => {
    const d: MyInvestorDiscovery = {
      ...robo([EURO_BUY, ...fromYen]),
      accounts: [
        {
          key: "securities:9",
          kind: "securities",
          label: "Cuenta",
          otherHolder: false,
          sub: "Fondos",
        },
      ],
      products: robo([])
        .products.filter((product) => product.kind === "fund")
        .map((product) => ({ ...product, accountKey: ROBO, portfolioKey: null })),
    };
    const rows = view(d).rows;
    expect(rows.find((row) => row.key === keyOf(EURO_FUND))!.block).toEqual({
      reason: "currency",
    });
    expect(rows.find((row) => row.key === keyOf(MONEY_FUND))!.block).toEqual({
      reason: "currency",
    });
  });

  test("the sync never writes half of it", () => {
    const later = op("e3", EURO_FUND, {
      amount: "20.00",
      executedAt: "2025-10-01",
      units: "1",
    });
    const plan = planMyInvestorSync(robo([EURO_BUY, ...fromYen, later]), {
      bookIds: new Set([idOf("e1")]),
      cursor: "2026-11-04",
      links: [{ assetId: "a-euro", productKey: keyOf(EURO_FUND) }],
      sourceId: SOURCE,
      windowKeys: new Set(["j-in", "e3"]),
    });
    expect(plan.facts.facts.map((fact) => fact.key)).not.toContain("j-in");
  });
});

describe("the rates travel with the read", () => {
  test("a read stored before the rates existed still parses", () => {
    const old = robo([EURO_BUY], null);
    const parsed = parseMyInvestorDiscovery(serializeMyInvestorDiscovery(old));
    expect(parsed).not.toBeNull();
    expect(parsed!.fxRates).toBeUndefined();
  });

  test("a read keeps its rates through the store", () => {
    const parsed = parseMyInvestorDiscovery(
      serializeMyInvestorDiscovery(robo([EURO_BUY, DOLLAR_BUY])),
    );
    expect(parsed!.fxRates).toEqual(USD_RATES);
  });

  test("the ECB is asked only for the days of orders in another currency it lacks", async () => {
    const asked: string[] = [];
    const later = op("d2", DOLLAR_FUND, {
      amount: "30.00",
      currency: "USD",
      executedAt: "2025-09-01",
      units: "3",
    });
    const read = await withMyInvestorRates(robo([EURO_BUY, DOLLAR_BUY, later], null), {
      fetchDailyRates: async (currency, fromMs, toMs) => {
        asked.push(currency);
        const rates = new Map<string, number>();
        for (let at = fromMs; at <= toMs; at += 86_400_000) {
          rates.set(new Date(at).toISOString().slice(0, 10), 0.9);
        }
        return rates;
      },
      known: { USD: [{ dateKey: "2025-03-10", eurPerUnit: 0.91 }] },
    });
    expect(asked).toEqual(["USD"]);
    // One rate per day of an order: the known one kept, the missing one fetched.
    expect(read.fxRates).toEqual({
      USD: [
        { dateKey: "2025-03-10", eurPerUnit: 0.91 },
        { dateKey: "2025-09-01", eurPerUnit: 0.9 },
      ],
    });
  });

  test("a read in euros only asks the ECB nothing", async () => {
    const read = await withMyInvestorRates(robo([EURO_BUY], null), {
      fetchDailyRates: async () => {
        throw new Error("the ECB must not be asked");
      },
    });
    expect(read.fxRates).toBeUndefined();
  });

  test("with the ECB down, the rates already known are kept and the rest stay missing", async () => {
    const later = op("d2", DOLLAR_FUND, {
      amount: "30.00",
      currency: "USD",
      executedAt: "2025-09-01",
      units: "3",
    });
    const read = await withMyInvestorRates(robo([EURO_BUY, DOLLAR_BUY, later], null), {
      fetchDailyRates: async () => new Map(),
      known: { USD: [{ dateKey: "2025-03-10", eurPerUnit: 0.91 }] },
    });
    expect(read.fxRates).toEqual({ USD: [{ dateKey: "2025-03-10", eurPerUnit: 0.91 }] });
  });

  test("a silent ECB is given one attempt, cut at its deadline: 4 s by default", async () => {
    expect(MYINVESTOR_ECB_TIMEOUT_MS).toBe(4_000);
    let calls = 0;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      calls += 1;
      // Never answers: only its deadline ends the wait.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    try {
      // The real default fetcher, with its deadline brought down to a few ms.
      const read = await withMyInvestorRates(robo([EURO_BUY, DOLLAR_BUY], null), {
        ecbTimeoutMs: 20,
      });
      expect(calls).toBe(1);
      expect(read.fxRates).toBeUndefined();
    } finally {
      network.mockRestore();
    }
  });
});
