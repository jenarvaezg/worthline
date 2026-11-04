/**
 * The second pass of the MyInvestor anonymizer (#1887): after `anonymize.ts` has invented
 * every amount and share count, this recalculates whatever the API derives from them, so
 * the fixture adds up as the real response did.
 *
 * - Orders: an inbound order keeps its invented amount and gets its shares as amount /
 *   real price (NAV or share price, public), at the decimals the API uses for that
 *   instrument. An outbound order that closed the real position closes the invented one;
 *   a partial one sells the same fraction. The two legs of an internal transfer move the
 *   same cash. A broker order invents its shares and recalculates gross and net.
 * - Positions (P8): today's shares of every plan, fund and stock are the sum of the
 *   invented COMPLETE orders; invested is their average cost; value = shares × real price.
 * - Balances: `withheldBalance` is the sum of `amountToBlock` of the orders in progress
 *   charged to the cash account. `enabledBalance` stays invented: no order backs it.
 * - Series (`SINCE_BEGINNING`): shares and invested at each date come from the invented
 *   orders; the price of each date is the real one (value / shares of the real point).
 *
 * It works on the trees in place: they are fresh copies made by the first pass.
 */
import {
  addDecimals,
  canonicalDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  roundDecimal,
  subtractDecimal,
} from "./decimal";
import { isPlainObject, type LiteralJson, NumberLiteral } from "./json-literals";

export interface CaptureTrees {
  /** The raw file name without `.json`, as `capture.sh` writes it. */
  readonly name: string;
  readonly raw: LiteralJson;
  readonly fake: LiteralJson;
}

type Obj = { [key: string]: LiteralJson };

const PLAN_IN = new Set([
  "PLAN_CONTRIBUTION",
  "REGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
  "REGISTRATION_BY_EXTERNAL_PLAN_TRANSFER",
]);
const PLAN_OUT = new Set(["DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER"]);
const FUND_IN = new Set([
  "INVESTMENT_FUNDS_SUBSCRIPTION",
  "IIC_SWITCH_REGISTRATION",
  "INTERNAL_TRANSFER_SUBSCRIPTION",
]);
const FUND_OUT = new Set([
  "INVESTMENT_FUNDS_REIMBURSEMENT",
  "IIC_SWITCH_DEREGISTRATION",
  "INTERNAL_TRANSFER_REIMBURSEMENT",
]);
/** Inbound legs whose outbound twin, same date and same cash, is in the same file. */
const TWIN_OF: Readonly<Record<string, string>> = {
  REGISTRATION_BY_INTERNAL_PLAN_TRANSFER: "DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
  IIC_SWITCH_REGISTRATION: "IIC_SWITCH_DEREGISTRATION",
};

// ── tree access ──────────────────────────────────────────────────────────────

const asObj = (value: LiteralJson | undefined): Obj | null =>
  value !== undefined && isPlainObject(value) ? value : null;

function dataOf(tree: LiteralJson): LiteralJson | undefined {
  return asObj(asObj(tree)?.payload)?.data;
}

function rowsOf(tree: LiteralJson): Obj[] {
  const data = dataOf(tree);
  if (Array.isArray(data)) return data.filter(isPlainObject);
  const single = asObj(data);
  return single ? [single] : [];
}

const num = (row: Obj | null | undefined, key: string): string | null => {
  const value = row?.[key];
  return value instanceof NumberLiteral ? canonicalDecimal(value.source) : null;
};
const need = (row: Obj, key: string, where: string): string => {
  const value = num(row, key);
  if (value === null) throw new Error(`${where}: falta ${key}`);
  return value;
};
const text = (row: Obj | null | undefined, key: string): string => {
  const value = row?.[key];
  return typeof value === "string" ? value : "";
};
/** Writes a figure only where the response has one: a `null` stays `null`. */
function put(row: Obj, key: string, value: string) {
  if (row[key] instanceof NumberLiteral) row[key] = new NumberLiteral(value);
}

const day = (value: string) => value.slice(0, 10);
const decimalsOf = (literal: string) =>
  canonicalDecimal(literal).split(".")[1]?.length ?? 0;
const unitOf = (decimals: number) =>
  decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
const isZero = (value: string | null) =>
  value === null || compareDecimal(value, "0") === 0;
const positive = (value: string | null): value is string =>
  value !== null && compareDecimal(value, "0") > 0;

// ── the ledger of one instrument ─────────────────────────────────────────────

interface Point {
  readonly date: string;
  readonly shares: string;
  readonly invested: string;
}

/** Real and invented position of one instrument, walked order by order. */
class Ledger {
  real = "0";
  shares = "0";
  invested = "0";
  readonly points: Point[] = [];

  constructor(
    readonly decimals: number,
    /** Today's real price of the instrument, from its account, when it is still held. */
    private readonly price: string | null,
    private readonly avoid: Avoid,
  ) {}

  buy(date: string, realShares: string, shares: string, cost: string) {
    this.real = addDecimals([this.real, realShares]);
    this.shares = addDecimals([this.shares, shares]);
    this.invested = addDecimals([this.invested, cost]);
    this.points.push({ date, shares: this.shares, invested: this.invested });
  }

  /** The invented shares an outbound order of `realShares` takes. */
  outbound(realShares: string): string {
    if (compareDecimal(realShares, this.real) >= 0) return this.shares;
    const unit = unitOf(this.decimals);
    const fraction = divideDecimal(
      multiplyDecimal(this.shares, realShares),
      this.real,
      this.decimals,
    );
    const ceiling = subtractDecimal(this.shares, unit);
    if (compareDecimal(ceiling, unit) < 0) return this.shares;
    if (compareDecimal(fraction, unit) < 0) return unit;
    return compareDecimal(fraction, ceiling) > 0 ? ceiling : fraction;
  }

  /**
   * The shares of an order, nudged one unit at a time away from a coincidence with the
   * real capture: the invented position must not end equal to the real one, and neither
   * the position, its value at today's price, the invested left, nor the figures `clash`
   * derives from the shares may exist in the capture. A closing sale is never nudged: it
   * must take the whole position. `cost` is what an inbound order adds to invested.
   */
  settle(
    side: "in" | "out",
    realShares: string,
    proposed: string,
    clash: (s: string) => boolean,
    cost: (s: string) => string = () => "0",
  ) {
    const unit = unitOf(this.decimals);
    const closing = side === "out" && compareDecimal(proposed, this.shares) >= 0;
    if (closing) return proposed;
    const realAfter =
      side === "in"
        ? addDecimals([this.real, realShares])
        : subtractDecimal(this.real, realShares);
    const fine = (shares: string) => {
      if (compareDecimal(shares, unit) < 0) return false;
      if (side === "out" && compareDecimal(shares, this.shares) >= 0) return false;
      const after =
        side === "in"
          ? addDecimals([this.shares, shares])
          : subtractDecimal(this.shares, shares);
      const invested =
        side === "in"
          ? addDecimals([this.invested, cost(shares)])
          : subtractDecimal(this.invested, this.costOfSale(shares));
      if (compareDecimal(after, realAfter) === 0 || clash(shares)) return false;
      if (this.avoid.quantity(after) || this.avoid.amount(invested)) return false;
      return !(this.price && this.avoid.amount(multiplyDecimal(after, this.price)));
    };
    for (let step = 0; step < 60; step++) {
      const offset = multiplyDecimal(unit, String(Math.ceil(step / 2)));
      const candidate =
        step % 2 === 0
          ? addDecimals([proposed, offset])
          : subtractDecimal(proposed, offset);
      if (fine(candidate)) return candidate;
    }
    return proposed;
  }

  /** The invested a sale of `shares` takes away, at average cost. */
  costOfSale(shares: string): string {
    if (compareDecimal(shares, this.shares) >= 0) return this.invested;
    return roundDecimal(
      divideDecimal(multiplyDecimal(this.invested, shares), this.shares, 6),
      2,
    );
  }

  sell(date: string, realShares: string, shares: string) {
    const closes = compareDecimal(shares, this.shares) >= 0;
    const cost = this.costOfSale(shares);
    this.real = subtractDecimal(this.real, realShares);
    this.shares = closes ? "0" : subtractDecimal(this.shares, shares);
    this.invested = closes ? "0" : subtractDecimal(this.invested, cost);
    this.points.push({ date, shares: this.shares, invested: this.invested });
  }

  at(date: string): Point {
    let last: Point = { date: "", shares: "0", invested: "0" };
    for (const point of this.points) if (point.date <= date) last = point;
    return last;
  }
}

class Ledgers {
  private readonly byKey = new Map<string, Ledger>();
  constructor(
    private readonly decimals: ReadonlyMap<string, number>,
    private readonly prices: ReadonlyMap<string, string>,
    private readonly avoid: Avoid,
  ) {}

  get(account: string, instrument: string): Ledger {
    const key = `${account}\u0000${instrument}`;
    let ledger = this.byKey.get(key);
    if (!ledger) {
      ledger = new Ledger(
        this.decimals.get(instrument) ?? 3,
        this.prices.get(key) ?? null,
        this.avoid,
      );
      this.byKey.set(key, ledger);
    }
    return ledger;
  }

  find(account: string, instrument: string): Ledger | undefined {
    return this.byKey.get(`${account}\u0000${instrument}`);
  }
}

// ── the captures, by kind ────────────────────────────────────────────────────

interface Pair {
  readonly raw: Obj;
  readonly fake: Obj;
}

function pairsOf(capture: CaptureTrees): Pair[] {
  const raw = rowsOf(capture.raw);
  const fake = rowsOf(capture.fake);
  return raw.map((row, i) => ({ raw: row, fake: fake[i] as Obj }));
}

function index(captures: readonly CaptureTrees[]) {
  const single = new Map<string, CaptureTrees>();
  const perAccount = new Map<string, Map<string, CaptureTrees>>();
  for (const capture of captures) {
    const match = /^(.+?)-(\d+)$/.exec(capture.name);
    if (!match) {
      single.set(capture.name, capture);
      continue;
    }
    const [, kind = "", id = ""] = match;
    const group = perAccount.get(kind) ?? new Map<string, CaptureTrees>();
    group.set(id, capture);
    perAccount.set(kind, group);
  }
  const of = (kind: string) => perAccount.get(kind) ?? new Map<string, CaptureTrees>();
  return { single, of };
}

/** The decimals the API uses for each instrument's shares: the most any real literal has. */
function shareDecimals(captures: readonly CaptureTrees[]): Map<string, number> {
  const decimals = new Map<string, number>();
  const note = (instrument: string, literal: LiteralJson | undefined) => {
    if (!instrument || !(literal instanceof NumberLiteral)) return;
    const places = decimalsOf(literal.source);
    decimals.set(instrument, Math.max(decimals.get(instrument) ?? 0, places));
  };
  const visit = (value: LiteralJson | undefined, instrument: string) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, instrument);
      return;
    }
    const row = asObj(value);
    if (!row) return;
    const own =
      text(row, "dgsCode") ||
      text(row, "isin") ||
      text(row, "instrumentIsin") ||
      instrument;
    for (const key of ["shares", "totalShares", "executedShares"]) note(own, row[key]);
    for (const [key, inner] of Object.entries(row)) {
      if (key === "positions") {
        for (const [code, series] of Object.entries(asObj(inner) ?? {}))
          visit(series, code);
      } else {
        visit(inner, own);
      }
    }
  };
  for (const capture of captures) visit(capture.raw, "");
  return decimals;
}

// ── orders ───────────────────────────────────────────────────────────────────

/** Whether an invented figure would equal a real one of the capture. */
interface Avoid {
  readonly amount: (value: string) => boolean;
  readonly quantity: (value: string) => boolean;
}

interface OrderKinds {
  readonly key: "dgsCode" | "isin";
  readonly inbound: ReadonlySet<string>;
  readonly outbound: ReadonlySet<string>;
}

const PLAN_KINDS: OrderKinds = { key: "dgsCode", inbound: PLAN_IN, outbound: PLAN_OUT };
const FUND_KINDS: OrderKinds = { key: "isin", inbound: FUND_IN, outbound: FUND_OUT };

/** Chronological, and on the same day the outbound legs first. */
function chronological(pairs: readonly Pair[], outbound: ReadonlySet<string>): Pair[] {
  return [...pairs].sort((a, b) => {
    const byDay = day(text(a.raw, "orderDate")).localeCompare(
      day(text(b.raw, "orderDate")),
    );
    if (byDay !== 0) return byDay;
    const rank = (pair: Pair) => (outbound.has(text(pair.raw, "operationType")) ? 0 : 1);
    return rank(a) - rank(b);
  });
}

function rebuildOrders(
  account: string,
  capture: CaptureTrees,
  kinds: OrderKinds,
  ledgers: Ledgers,
  navAt: (instrument: string, date: string) => string | null,
  avoid: Avoid,
) {
  const done: { type: string; date: string; realCash: string | null; cash: string }[] =
    [];
  for (const { raw, fake } of chronological(pairsOf(capture), kinds.outbound)) {
    const where = `${capture.name} ${text(raw, "reference")}`;
    const type = text(raw, "operationType");
    const date = day(text(raw, "orderDate"));
    const instrument = text(raw, kinds.key);
    const realCash = num(raw, "cash");
    const realShares = num(raw, "shares") ?? "0";
    const nav = num(raw, "amountBuyVL");
    const blocksCash = realCash !== null && num(raw, "amountToBlock") === realCash;
    const inbound = kinds.inbound.has(type);
    if (!inbound && !kinds.outbound.has(type)) {
      throw new Error(`${where}: tipo de orden sin signo conocido: ${type}`);
    }
    if (kinds === FUND_KINDS && text(raw, "productType") !== "IIC") {
      throw new Error(`${where}: orden de fondos que no es IIC`);
    }
    let cash = num(fake, "cash") ?? "0";
    if (text(raw, "status") === "COMPLETE" && !isZero(realShares)) {
      const ledger = ledgers.get(account, instrument);
      let shares: string;
      if (inbound) {
        const twin = TWIN_OF[type];
        const leg = done.find(
          (other) =>
            other.type === twin && other.date === date && other.realCash === realCash,
        );
        if (leg) cash = leg.cash;
        shares = positive(nav)
          ? divideDecimal(cash, nav, ledger.decimals)
          : (num(fake, "shares") ?? "0");
        if (compareDecimal(shares, unitOf(ledger.decimals)) < 0) {
          shares = unitOf(ledger.decimals);
        }
        const price = positive(nav) ? null : navAt(instrument, date);
        const costOf = (s: string) =>
          positive(cash)
            ? cash
            : price
              ? roundDecimal(multiplyDecimal(s, price), 2)
              : "0";
        shares = ledger.settle("in", realShares, shares, avoid.quantity, costOf);
        const cost = costOf(shares);
        ledger.buy(date, realShares, shares, cost);
      } else {
        shares = ledger.settle(
          "out",
          realShares,
          ledger.outbound(realShares),
          (s) =>
            avoid.quantity(s) ||
            (positive(nav) && avoid.amount(roundDecimal(multiplyDecimal(s, nav), 2))),
        );
        if (positive(nav)) cash = roundDecimal(multiplyDecimal(shares, nav), 2);
        ledger.sell(date, realShares, shares);
      }
      put(fake, "shares", shares);
      put(fake, "cash", cash);
    }
    if (blocksCash) put(fake, "amountToBlock", cash);
    done.push({ type, date, realCash, cash });
  }
}

function rebuildBroker(
  account: string,
  listing: CaptureTrees,
  details: ReadonlyMap<string, CaptureTrees>,
  ledgers: Ledgers,
  avoid: Avoid,
) {
  const orders = pairsOf(listing).map((row) => {
    const id = text(row.raw, "id");
    const detail = details.get(id);
    if (!detail) throw new Error(`${listing.name}: falta el detalle de una orden`);
    const [pair] = pairsOf(detail);
    if (!pair) throw new Error(`${detail.name}: detalle vacío`);
    return { row, detail: pair };
  });
  orders.sort((a, b) => {
    const byDay = text(a.detail.raw, "orderDate").localeCompare(
      text(b.detail.raw, "orderDate"),
    );
    if (byDay !== 0) return byDay;
    const rank = (o: typeof a) =>
      text(o.detail.raw, "orderOperationTypeEnum") === "SELL" ? 0 : 1;
    return rank(a) - rank(b);
  });
  for (const { row, detail } of orders) {
    const { raw, fake } = detail;
    if (text(raw, "orderStatus") !== "COMPLETE") continue;
    const where = `orden de broker ${text(raw, "orderReference")}`;
    const side = text(raw, "orderOperationTypeEnum");
    if (side !== "BUY" && side !== "SELL")
      throw new Error(`${where}: lado desconocido ${side}`);
    if (num(raw, "exchangeRate") !== "1")
      throw new Error(`${where}: divisa no soportada`);
    const realShares = need(raw, "executedShares", where);
    const price = need(raw, "priceCurrency", where);
    const ledger = ledgers.get(account, text(raw, "instrumentIsin"));
    const date = day(text(raw, "orderDate"));
    const fees = addDecimals([
      num(fake, "tradeCommissions") ?? "0",
      num(fake, "otherCommissions") ?? "0",
    ]);
    const grossOf = (s: string) => roundDecimal(multiplyDecimal(s, price), 2);
    const netOf = (s: string) =>
      side === "BUY"
        ? addDecimals([grossOf(s), fees])
        : subtractDecimal(grossOf(s), fees);
    const shares = ledger.settle(
      side === "BUY" ? "in" : "out",
      realShares,
      side === "BUY" ? need(fake, "executedShares", where) : ledger.outbound(realShares),
      (s) => avoid.amount(grossOf(s)) || avoid.amount(netOf(s)),
      netOf,
    );
    const gross = grossOf(shares);
    const net = netOf(shares);
    if (side === "BUY") ledger.buy(date, realShares, shares, net);
    else ledger.sell(date, realShares, shares);
    put(fake, "executedShares", shares);
    if (num(raw, "shares") === realShares) put(fake, "shares", shares);
    put(fake, "grossAmountOperationCurrency", gross);
    for (const key of ["netAmountEUR", "netAmountAccountCurrency", "netAmountCurrency"]) {
      put(fake, key, net);
    }
    if (num(row.raw, "shares") === realShares) put(row.fake, "shares", shares);
  }
}

// ── positions and balances ───────────────────────────────────────────────────

interface Totals {
  value: string[];
  invested: string[];
}

const returnPct = (profit: string, invested: string) =>
  positive(invested) ? divideDecimal(multiplyDecimal(profit, "100"), invested, 8) : "0";

/** Writes shares, invested, value, profit, average cost and return of one holding. */
function holding(row: Obj, ledger: Ledger, price: string, totals: Totals[]) {
  const value = multiplyDecimal(ledger.shares, price);
  const profit = subtractDecimal(value, ledger.invested);
  put(row, "shares", ledger.shares);
  put(row, "availableShares", ledger.shares);
  put(row, "totalInvested", ledger.invested);
  put(row, "initialInvestment", ledger.invested);
  put(row, "initialInvestmentCurrency", ledger.invested);
  put(row, "marketValue", value);
  put(row, "profit", profit);
  put(
    row,
    "averageCost",
    positive(ledger.shares) ? divideDecimal(ledger.invested, ledger.shares, 9) : "0",
  );
  put(row, "totalReturn", returnPct(profit, ledger.invested));
  for (const total of totals) {
    total.value.push(value);
    total.invested.push(ledger.invested);
  }
}

function writeTotals(row: Obj, prefix: "" | "funds" | "stocks", totals: Totals) {
  const key = (name: string) =>
    prefix ? `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
  const value = addDecimals(totals.value);
  const invested = addDecimals(totals.invested);
  const profit = subtractDecimal(value, invested);
  put(row, key("marketValue"), value);
  put(row, key("totalInvested"), invested);
  put(row, key("profit"), profit);
  put(row, key("totalReturn"), returnPct(profit, invested));
}

const emptyTotals = (): Totals => ({ value: [], invested: [] });

function rebuildPlans(
  id: string,
  capture: CaptureTrees,
  ledgers: Ledgers,
  account: Totals,
) {
  for (const { raw, fake } of pairsOf(capture)) {
    const dgs = text(raw, "dgsCode");
    const ledger = ledgers.find(id, dgs);
    if (!ledger) throw new Error(`${capture.name}: plan sin órdenes (${dgs})`);
    holding(fake, ledger, need(raw, "liquidationValue", capture.name), [account]);
  }
}

function rebuildSecuritiesAccount(id: string, capture: CaptureTrees, ledgers: Ledgers) {
  const raw = asObj(dataOf(capture.raw));
  const fake = asObj(dataOf(capture.fake));
  if (!raw || !fake) return;
  const all = emptyTotals();
  const funds = emptyTotals();
  const stocks = emptyTotals();
  const rawGroups = asObj(raw.securitiesAccountInvestments) ?? {};
  const fakeGroups = asObj(fake.securitiesAccountInvestments) ?? {};
  for (const [name, rawGroup] of Object.entries(rawGroups)) {
    const fakeGroup = asObj(fakeGroups[name]);
    const rawList = asObj(rawGroup)?.investmentList;
    const fakeList = fakeGroup?.investmentList;
    if (!fakeGroup || !Array.isArray(rawList) || !Array.isArray(fakeList)) continue;
    const group = emptyTotals();
    rawList.forEach((rawItem, i) => {
      const item = asObj(rawItem);
      const fakeItem = asObj(fakeList[i]);
      if (!item || !fakeItem) return;
      const isin = text(item, "isin");
      const ledger = ledgers.find(id, isin);
      if (!ledger) throw new Error(`${capture.name}: posición sin órdenes (${isin})`);
      const kind = text(item, "productTypeCode") === "IIC" ? funds : stocks;
      holding(fakeItem, ledger, need(item, "liquidationValue", capture.name), [
        group,
        all,
        kind,
      ]);
    });
    put(fakeGroup, "totalAmount", addDecimals(group.value));
  }
  writeTotals(fake, "", all);
  writeTotals(fake, "funds", funds);
  writeTotals(fake, "stocks", stocks);
  put(
    fake,
    "amount",
    addDecimals([addDecimals(all.value), num(fake, "cashAccountBalance") ?? "0"]),
  );
}

function rebuildSeries(id: string, capture: CaptureTrees, ledgers: Ledgers) {
  const rawSeries = asObj(asObj(dataOf(capture.raw))?.positions) ?? {};
  const fakeSeries = asObj(asObj(dataOf(capture.fake))?.positions) ?? {};
  for (const [instrument, rawPoints] of Object.entries(rawSeries)) {
    const fakePoints = fakeSeries[instrument];
    if (!Array.isArray(rawPoints) || !Array.isArray(fakePoints)) continue;
    const ledger = ledgers.find(id, instrument);
    if (!ledger) throw new Error(`${capture.name}: serie sin órdenes (${instrument})`);
    const prices = rawPoints.map((point) => priceOfPoint(asObj(point)));
    rawPoints.forEach((rawPoint, i) => {
      const point = asObj(rawPoint);
      const fakePoint = asObj(fakePoints[i]);
      if (!point || !fakePoint) return;
      const { shares, invested } = ledger.at(day(text(point, "date")));
      const price = prices[i] ?? nearest(prices, i);
      const value = price ? roundDecimal(multiplyDecimal(shares, price), 6) : "0";
      put(fakePoint, "totalShares", shares);
      put(fakePoint, "investmentAddedValue", invested);
      put(fakePoint, "marketValue", value);
      put(fakePoint, "currencyMarketValue", value);
      put(
        fakePoint,
        "returnValue",
        returnPct(subtractDecimal(value, invested), invested),
      );
      put(
        fakePoint,
        "avgPositionCost",
        positive(shares) ? divideDecimal(invested, shares, 9) : "0",
      );
    });
  }
}

/** The real price of a series point: its value over its shares, when it holds any. */
function priceOfPoint(point: Obj | null): string | null {
  const shares = num(point, "totalShares");
  const value = num(point, "marketValue");
  return positive(shares) && value !== null ? divideDecimal(value, shares, 6) : null;
}

function nearest(prices: readonly (string | null)[], i: number): string | null {
  for (let step = 1; step < prices.length; step++) {
    const before = prices[i - step];
    if (before) return before;
    const after = prices[i + step];
    if (after) return after;
  }
  return null;
}

/** The real price of an instrument on a date, from its series: for a transfer with no cash. */
function seriesPrices(captures: Iterable<CaptureTrees>) {
  const byInstrument = new Map<string, { date: string; price: string }[]>();
  for (const capture of captures) {
    const series = asObj(asObj(dataOf(capture.raw))?.positions) ?? {};
    for (const [instrument, points] of Object.entries(series)) {
      if (!Array.isArray(points)) continue;
      const list = byInstrument.get(instrument) ?? [];
      for (const point of points) {
        const price = priceOfPoint(asObj(point));
        if (price) list.push({ date: day(text(asObj(point), "date")), price });
      }
      byInstrument.set(
        instrument,
        list.sort((a, b) => a.date.localeCompare(b.date)),
      );
    }
  }
  return (instrument: string, date: string): string | null => {
    const list = byInstrument.get(instrument) ?? [];
    const after = list.find((point) => point.date >= date);
    return after?.price ?? list.at(-1)?.price ?? null;
  };
}

function rebuildWithheld(
  single: ReadonlyMap<string, CaptureTrees>,
  orders: readonly { cashAccount: string; capture: CaptureTrees }[],
) {
  const cashAccounts = single.get("cash-accounts");
  if (!cashAccounts) return;
  const sums = new Map<string, { real: string[]; fake: string[] }>();
  for (const { cashAccount, capture } of orders) {
    for (const { raw, fake } of pairsOf(capture)) {
      if (text(raw, "status") !== "IN_PROGRESS") continue;
      const sum = sums.get(cashAccount) ?? { real: [], fake: [] };
      sum.real.push(num(raw, "amountToBlock") ?? "0");
      sum.fake.push(num(fake, "amountToBlock") ?? "0");
      sums.set(cashAccount, sum);
    }
  }
  for (const { raw, fake } of pairsOf(cashAccounts)) {
    const sum = sums.get(text(raw, "accountId")) ?? { real: [], fake: [] };
    const withheld = num(raw, "withheldBalance");
    if (withheld === null) continue;
    if (compareDecimal(withheld, addDecimals(sum.real)) !== 0) {
      throw new Error("cash-accounts: lo retenido no es la suma de las órdenes en curso");
    }
    put(fake, "withheldBalance", addDecimals(sum.fake));
  }
}

/** Today's real price of every held instrument, by `account \0 instrument`. */
function todayPrices(
  of: (kind: string) => Map<string, CaptureTrees>,
): Map<string, string> {
  const prices = new Map<string, string>();
  for (const [id, capture] of of("pension-account")) {
    for (const plan of rowsOf(capture.raw)) {
      const price = num(plan, "liquidationValue");
      if (price) prices.set(`${id}\u0000${text(plan, "dgsCode")}`, price);
    }
  }
  for (const [id, capture] of of("securities-account")) {
    const groups = asObj(asObj(dataOf(capture.raw))?.securitiesAccountInvestments) ?? {};
    for (const group of Object.values(groups)) {
      const list = asObj(group)?.investmentList;
      if (!Array.isArray(list)) continue;
      for (const item of list.filter(isPlainObject)) {
        const price = num(item, "liquidationValue");
        if (price) prices.set(`${id}\u0000${text(item, "isin")}`, price);
      }
    }
  }
  return prices;
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface RebuildOptions {
  /** The real amounts and fractional share counts of the capture, never to be produced. */
  readonly forbidden?: {
    readonly amounts?: ReadonlySet<string>;
    readonly quantities?: ReadonlySet<string>;
  };
}

export function rebuildCaptures(
  captures: readonly CaptureTrees[],
  options: RebuildOptions = {},
) {
  const avoid: Avoid = {
    amount: (value) => options.forbidden?.amounts?.has(canonicalDecimal(value)) ?? false,
    quantity: (value) =>
      options.forbidden?.quantities?.has(canonicalDecimal(value)) ?? false,
  };
  const { single, of } = index(captures);
  const ledgers = new Ledgers(shareDecimals(captures), todayPrices(of), avoid);
  const navAt = seriesPrices([
    ...of("pension-positions").values(),
    ...of("securities-positions").values(),
  ]);

  for (const [id, capture] of of("pension-orders")) {
    rebuildOrders(id, capture, PLAN_KINDS, ledgers, navAt, avoid);
  }
  for (const [id, capture] of of("securities-orders")) {
    rebuildOrders(id, capture, FUND_KINDS, ledgers, navAt, avoid);
  }
  const details = new Map(
    [...of("broker-order-detail")].map(([id, capture]) => [id, capture] as const),
  );
  for (const [id, capture] of of("broker-orders"))
    rebuildBroker(id, capture, details, ledgers, avoid);

  const pensionTotals = new Map<string, Totals>();
  for (const [id, capture] of of("pension-account")) {
    const totals = emptyTotals();
    rebuildPlans(id, capture, ledgers, totals);
    pensionTotals.set(id, totals);
  }
  const pensionAccounts = single.get("pension-accounts");
  if (pensionAccounts) {
    for (const { raw, fake } of pairsOf(pensionAccounts)) {
      const totals = pensionTotals.get(text(raw, "accountId"));
      if (!totals) continue;
      writeTotals(fake, "", totals);
      put(fake, "amountAccount", addDecimals(totals.value));
    }
  }
  for (const [id, capture] of of("securities-account")) {
    rebuildSecuritiesAccount(id, capture, ledgers);
  }
  for (const [id, capture] of of("pension-positions"))
    rebuildSeries(id, capture, ledgers);
  for (const [id, capture] of of("securities-positions"))
    rebuildSeries(id, capture, ledgers);

  const cashOf = (listName: string) =>
    new Map(
      (single.get(listName) ? pairsOf(single.get(listName) as CaptureTrees) : []).map(
        ({ raw }) => [text(raw, "accountId"), text(raw, "cashAccountId")] as const,
      ),
    );
  const pensionCash = cashOf("pension-accounts");
  const securitiesCash = cashOf("securities-accounts");
  rebuildWithheld(single, [
    ...[...of("pension-orders")].map(([id, capture]) => ({
      cashAccount: pensionCash.get(id) ?? "",
      capture,
    })),
    ...[...of("securities-orders")].map(([id, capture]) => ({
      cashAccount: securitiesCash.get(id) ?? "",
      capture,
    })),
  ]);
}
