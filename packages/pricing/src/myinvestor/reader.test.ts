/**
 * Every read of the connector against the S1 fixtures (#1887): the fake transport
 * answers each request with the body its manifest entry records, so a wrong path or
 * query fails loudly. The figures are never written here: each parsed amount is
 * checked against the same fixture read raw.
 */
import {
  MYINVESTOR_FIXTURES,
  readMyInvestorFixture,
} from "@pricing/__fixtures__/myinvestor";
import { addUnits, compareUnits } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createMyInvestorClient } from "./client";
import type { DateRange, MyInvestorReader } from "./reader";
import { fixtureTransport } from "./testing/fake-transport";

const TOKENS = { accessToken: "access-sintetico", refreshToken: "refresh-sintetico" };

type Raw = Record<string, unknown>;
type FixtureManifestEntry = (typeof MYINVESTOR_FIXTURES)[number];

function reader(): {
  read: MyInvestorReader;
  requests: ReturnType<typeof fixtureTransport>["requests"];
} {
  const transport = fixtureTransport();
  const client = createMyInvestorClient({ transport, deviceId: "device-sintetico" });
  return { read: client.reader(TOKENS), requests: transport.requests };
}

function rawData(entry: FixtureManifestEntry | undefined): unknown {
  if (!entry?.file) throw new Error("Falta el fixture");
  return (readMyInvestorFixture(entry.file) as { payload: { data: unknown } }).payload
    .data;
}

function entries(pattern: RegExp): { entry: FixtureManifestEntry; id: string }[] {
  return MYINVESTOR_FIXTURES.filter(
    (entry) => entry.method === "GET" && entry.file !== null && pattern.test(entry.path),
  ).map((entry) => ({ entry, id: pattern.exec(entry.path)?.[1] ?? "" }));
}

/** A decimal string worth exactly what the raw JSON number says, or null with it. */
function expectDecimal(parsed: string | null, raw: unknown): void {
  if (raw === null || raw === undefined) {
    expect(parsed).toBeNull();
    return;
  }
  expect(typeof parsed).toBe("string");
  expect(parsed).toMatch(/^-?\d+(\.\d+)?$/);
  expect(Number(parsed)).toBe(raw);
}

function isoOf(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`Lectura fallida: ${JSON.stringify(result.error)}`);
  return result.value;
}

const ORDERS = /^\/cperf-server\/api\/v3\/securities-accounts\/([^/]+)\/orders$/;
const PENSION_ORDERS = /^\/cperf-server\/api\/v2\/pension-accounts\/([^/]+)\/orders$/;

describe("the MyInvestor reader against the S1 fixtures", () => {
  it("reads the cash accounts with both balances in decimal and who owns them", async () => {
    const { read } = reader();
    const [entry] = entries(/^\/cperf-server\/api\/v2\/cash-accounts\/self$/).filter(
      ({ entry }) => entry.origin === "capture",
    );
    const raw = rawData(entry?.entry) as Raw[];

    const accounts = unwrap(await read.cashAccounts());

    expect(accounts).toHaveLength(raw.length);
    accounts.forEach((account, index) => {
      expectDecimal(account.enabledBalance, raw[index]?.enabledBalance);
      expectDecimal(account.withheldBalance, raw[index]?.withheldBalance);
      expect(account.accountId).toBe(raw[index]?.accountId);
    });
    expect(new Set(accounts.map((account) => account.ownership))).toEqual(
      new Set(["me", "junior"]),
    );
  });

  it("never keeps a holder's name, document or IBAN", async () => {
    const { read } = reader();
    const accounts = unwrap(await read.cashAccounts());
    const text = JSON.stringify(accounts);

    for (const key of ["documentNumber", "surname1", "iban", "name", "userId"]) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(Object.keys(accounts[0]?.holders[0] ?? {}).sort()).toEqual([
      "me",
      "participantType",
    ]);
  });

  it("reads the fund orders of every securities account with dashed dates and decimal amounts", async () => {
    const found = entries(ORDERS);
    expect(found.length).toBeGreaterThan(0);

    for (const { entry, id } of found) {
      const { read } = reader();
      const range: DateRange = {
        from: entry.query.dateFrom ?? "",
        to: entry.query.dateTo ?? "",
      };
      const raw = rawData(entry) as Raw[];

      const orders = unwrap(await read.securitiesOrders(id, range));

      expect(orders).toHaveLength(raw.length);
      orders.forEach((order, index) => {
        const source = raw[index] as Raw;
        expect(order.reference).toBe(source.reference);
        expect(order.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(order.orderDate).toBe(String(source.orderDate).slice(0, 10));
        expectDecimal(order.cash, source.cash);
        expectDecimal(order.shares, source.shares);
        expectDecimal(order.amountToBlock, source.amountToBlock);
        expectDecimal(order.executionNav, source.amountBuyVL);
        expect(order.isin).toBe(source.isin);
      });
    }
  });

  it("asks a plan's orders with undashed dates, as the web does", async () => {
    const found = entries(PENSION_ORDERS);
    expect(found.length).toBeGreaterThan(0);

    for (const { entry, id } of found) {
      const { read, requests } = reader();
      const range = {
        from: isoOf(entry.query.dateFrom ?? ""),
        to: isoOf(entry.query.dateTo ?? ""),
      };
      const raw = rawData(entry) as Raw[];

      const orders = unwrap(await read.pensionOrders(id, range));

      expect(requests[0]?.query).toEqual(entry.query);
      expect(orders).toHaveLength(raw.length);
      orders.forEach((order, index) => {
        const source = raw[index] as Raw;
        expect(order.dgsCode).toBe(source.dgsCode);
        expect(order.accountId).toBe(source.pensionAccountId);
        expectDecimal(order.cash, source.cash);
        expectDecimal(order.shares, source.shares);
      });
    }
  });

  it("rejects a date range that is not two calendar days in order", async () => {
    const { read, requests } = reader();

    await expect(
      read.pensionOrders("1", { from: "2025-02-01", to: "2025-01-01" }),
    ).rejects.toThrow(RangeError);
    await expect(
      read.securitiesOrders("1", { from: "2025-1-1", to: "2025-01-31" }),
    ).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it("reads the positions of each securities account, shares in decimal, funds and broker alike", async () => {
    const found = entries(/^\/cperf-server\/api\/v2\/securities-accounts\/(\d+)$/);
    expect(found.length).toBeGreaterThan(0);

    const kinds = new Set<string>();
    for (const { entry, id } of found) {
      const { read } = reader();
      const raw = rawData(entry) as {
        securitiesAccountInvestments: Record<string, { investmentList: Raw[] }>;
      };
      const rawPositions = Object.values(raw.securitiesAccountInvestments).flatMap(
        (group) => group.investmentList,
      );

      const account = unwrap(await read.securitiesAccount(id));

      expect(account.accountId).toBe(id);
      expect(account.positions).toHaveLength(rawPositions.length);
      account.positions.forEach((position, index) => {
        const source = rawPositions[index] as Raw;
        expect(position.isin).toBe(source.isin);
        expectDecimal(position.shares, source.shares);
        kinds.add(position.productType ?? "");
      });
    }
    expect(kinds).toContain("BROKER");
    expect(kinds).toContain("INDEXED_FUND");
  });

  it("lists the securities accounts with their cash account", async () => {
    const { read } = reader();
    const accounts = unwrap(await read.securitiesAccounts());

    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(account.accountId).toMatch(/^\d+$/);
      expect(account.cashAccountId).toMatch(/^\d+$/);
    }
    expect(accounts.map((account) => account.accountType)).toContain(
      "SECURITIES_PORTFOLIO",
    );
  });

  it("reads the broker orders and the detail of each, which carries the ISIN and the execution", async () => {
    const lists = entries(/^\/broker\/v2\/stock-orders()$/);
    expect(lists.length).toBeGreaterThan(0);
    let details = 0;

    for (const { entry } of lists) {
      const { read } = reader();
      const range = { from: entry.query.dateFrom ?? "", to: entry.query.dateTo ?? "" };
      const raw = rawData(entry) as Raw[];

      const orders = unwrap(
        await read.brokerOrders(entry.query.stockAccountId ?? "", range),
      );

      expect(orders).toHaveLength(raw.length);
      for (const [index, order] of orders.entries()) {
        expectDecimal(order.amount, raw[index]?.amount);
        const detail = unwrap(await read.brokerOrderDetail(order.id));
        expect(detail.orderReference).toBe(order.id);
        expect(detail.instrumentIsin).toMatch(/^[A-Z]{2}[A-Z0-9]{10}$/);
        expect(["BUY", "SELL"]).toContain(detail.side);
        expect(typeof detail.executedShares).toBe("string");
        expect(typeof detail.netAmountAccountCurrency).toBe("string");
        details += 1;
      }
    }
    expect(details).toBeGreaterThan(0);
  });

  it("never keeps who ordered a broker order nor its account number", async () => {
    const [first] = entries(/^\/broker\/v2\/stock-orders\/([^/]+)$/);
    const { read } = reader();

    const detail = unwrap(await read.brokerOrderDetail(first?.id ?? ""));

    expect(detail).not.toHaveProperty("ordererCustomer");
    expect(detail).not.toHaveProperty("accountNumber");
  });

  it("reads the plans: accounts, positions and the SINCE_BEGINNING share series", async () => {
    const { read, requests } = reader();
    const accounts = unwrap(await read.pensionAccounts());
    expect(accounts.length).toBeGreaterThan(0);

    for (const account of accounts) {
      const [entry] = entries(
        new RegExp(`^/cperf-server/api/v2/pension-accounts/(${account.accountId})$`),
      );
      const raw = rawData(entry?.entry) as Raw[];

      const plans = unwrap(await read.pensionPlans(account.accountId));
      expect(plans).toHaveLength(raw.length);
      plans.forEach((plan, index) => {
        expect(plan.dgsCode).toBe(raw[index]?.dgsCode);
        expectDecimal(plan.shares, raw[index]?.shares);
      });

      const series = unwrap(await read.pensionShareSeries(account.accountId));
      expect(requests.at(-1)?.query).toEqual({ groupType: "SINCE_BEGINNING" });
      for (const plan of plans) {
        const points = series[plan.dgsCode] ?? [];
        expect(points.length).toBeGreaterThan(0);
        for (const point of points) {
          expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(typeof point.totalShares).toBe("string");
        }
      }
    }
  });

  it("reads the scheduled contributions with the amount in decimal and the euro as EUR", async () => {
    const { read } = reader();
    const [found] = entries(/^\/cperf-server\/api\/v2\/automatic-contributions\/self$/);
    const raw = rawData(found?.entry) as Raw[];

    const contributions = unwrap(await read.automaticContributions());

    expect(contributions).toHaveLength(raw.length);
    contributions.forEach((contribution, index) => {
      expectDecimal(contribution.amount, raw[index]?.amount);
      expect(contribution.currency).toBe("EUR");
      expect(contribution.timeFrame?.recurrence).toBeTruthy();
    });
    expect(
      new Set(contributions.map((contribution) => contribution.toAccountType)),
    ).toEqual(new Set(["SECURITIES_ACCOUNT", "PENSION_PLAN"]));
  });

  it("reads the robo-advisor catalog and the pending fund transfers", async () => {
    const { read } = reader();
    const portfolios = unwrap(await read.portfolios());
    expect(portfolios.length).toBeGreaterThan(0);
    for (const fund of portfolios.flatMap((portfolio) => portfolio.funds)) {
      expect(fund.isin).toMatch(/^[A-Z]{2}[A-Z0-9]{10}$/);
      expect(typeof fund.percentage).toBe("string");
    }

    for (const { id } of entries(
      /^\/cperf-server\/api\/v2\/securities-accounts\/([^/]+)\/transfers\/pending$/,
    )) {
      const pending = unwrap(await reader().read.pendingFundTransfers(id));
      expect(Number.isInteger(pending)).toBe(true);
    }
  });

  it("adds up exactly: what a cash account withholds is the amountToBlock of its orders in progress", async () => {
    const { read } = reader();
    const cash = unwrap(await read.cashAccounts());
    const securities = unwrap(await read.securitiesAccounts());
    const pensions = unwrap(await read.pensionAccounts());
    const captured = (pattern: RegExp) =>
      entries(pattern).filter(({ entry }) => entry.origin === "capture");

    async function ordersOf(accountId: string, pension: boolean) {
      const found = captured(pension ? PENSION_ORDERS : ORDERS).find(
        ({ id }) => id === accountId,
      );
      if (!found) return [];
      const { dateFrom = "", dateTo = "" } = found.entry.query;
      return pension
        ? unwrap(
            await reader().read.pensionOrders(accountId, {
              from: isoOf(dateFrom),
              to: isoOf(dateTo),
            }),
          )
        : unwrap(
            await reader().read.securitiesOrders(accountId, {
              from: dateFrom,
              to: dateTo,
            }),
          );
    }

    let checked = 0;
    for (const account of cash) {
      const linked = [
        ...securities
          .filter((s) => s.cashAccountId === account.accountId)
          .map((s) => ({ accountId: s.accountId, pension: false })),
        ...pensions
          .filter((p) => p.cashAccountId === account.accountId)
          .map((p) => ({ accountId: p.accountId, pension: true })),
      ];
      let blocked = "0";
      for (const { accountId, pension } of linked) {
        for (const order of await ordersOf(accountId, pension)) {
          if (order.status === "IN_PROGRESS" && order.amountToBlock) {
            blocked = addUnits(blocked, order.amountToBlock);
          }
        }
      }
      if (compareUnits(blocked, "0") === 0) continue;
      expect(compareUnits(account.withheldBalance, blocked)).toBe(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
