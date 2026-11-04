import { describe, expect, it } from "vitest";

import { anonymizeTree } from "./anonymize";
import { addDecimals, canonicalDecimal, multiplyDecimal, roundDecimal } from "./decimal";
import { createFigureMap } from "./figure-map";
import { type LiteralJson, NumberLiteral, parseWithLiterals } from "./json-literals";
import { createPseudonymizer } from "./pseudonymizer";
import { rebuildCaptures } from "./rebuild";

const SECRET = "test-secret-not-the-real-one";
const ok = (data: unknown) =>
  JSON.stringify({
    status: { timestamp: "2026-01-02T08:00:00.000Z", code: "OK" },
    payload: { data },
  });

// An invented account, shaped like the real API: no value here is real.
const planOrder = (o: Record<string, unknown>) => ({
  pensionAccountId: "100003",
  reference: "202401010000001",
  ticker: o.dgsCode,
  status: "COMPLETE",
  amountToBlock: o.cash,
  ...o,
});
const RAW: Record<string, string> = {
  "cash-accounts": ok([
    {
      accountId: "100001",
      enabledBalance: 13.6,
      withheldBalance: 68.3,
      accountType: "CASH_ACCOUNT",
    },
  ]),
  "pension-accounts": ok([
    {
      accountId: "100003",
      cashAccountId: "100001",
      amountAccount: 1,
      marketValue: 1,
      totalInvested: 1,
      profit: 1,
      totalReturn: 1,
    },
  ]),
  "securities-accounts": ok([
    { accountId: "100002", cashAccountId: "100001", marketValue: null },
  ]),
  "pension-orders-100003": ok([
    planOrder({
      orderDate: "2024-01-10",
      dgsCode: "N0001",
      operationType: "REGISTRATION_BY_EXTERNAL_PLAN_TRANSFER",
      cash: 0,
      shares: 37.6,
      amountBuyVL: 0,
    }),
    planOrder({
      orderDate: "2024-02-01",
      dgsCode: "N0001",
      operationType: "PLAN_CONTRIBUTION",
      cash: 104.6,
      shares: 10.356,
      amountBuyVL: 10.1,
    }),
    planOrder({
      orderDate: "2024-03-01",
      dgsCode: "N0001",
      operationType: "DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
      cash: 494.77,
      shares: 47.956,
      amountBuyVL: 10.3172,
    }),
    planOrder({
      orderDate: "2024-03-01",
      dgsCode: "N0002",
      operationType: "REGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
      cash: 494.77,
      shares: 23.153,
      amountBuyVL: 21.37,
    }),
    planOrder({
      orderDate: "2024-04-01",
      dgsCode: "N0002",
      operationType: "PLAN_CONTRIBUTION",
      cash: 68.3,
      shares: 0,
      amountBuyVL: null,
      status: "IN_PROGRESS",
    }),
  ]),
  "pension-account-100003": ok([
    {
      dgsCode: "N0002",
      shares: 23.153,
      liquidationValue: 22.61,
      marketValue: 523.49,
      totalInvested: 494.77,
      profit: 28.72,
      averageCost: 21.37,
      totalReturn: 5.8,
    },
  ]),
  "pension-positions-100003": ok({
    positions: {
      N0001: [
        {
          date: "2024-02-02",
          marketValue: 495.3,
          investmentAddedValue: 470.1,
          returnValue: 5.36,
          currencyMarketValue: 495.3,
          totalShares: 47.956,
          avgPositionCost: 9.803,
        },
      ],
      N0002: [
        {
          date: "2024-03-02",
          marketValue: 503.6,
          investmentAddedValue: 494.77,
          returnValue: 1.78,
          currencyMarketValue: 503.6,
          totalShares: 23.153,
          avgPositionCost: 21.37,
        },
      ],
    },
  }),
  "securities-account-100002": ok({
    accountId: "100002",
    amount: 1,
    marketValue: 1,
    totalInvested: 1,
    profit: 1,
    totalReturn: 1,
    fundsMarketValue: 1,
    fundsTotalInvested: 1,
    fundsProfit: 1,
    fundsTotalReturn: 1,
    stocksMarketValue: 1,
    stocksTotalInvested: 1,
    stocksProfit: 1,
    stocksTotalReturn: 1,
    cashAccountBalance: 0,
    securitiesAccountInvestments: {
      BROKER: {
        totalAmount: 1,
        investmentList: [
          {
            isin: "DE0000000001",
            productTypeCode: "RV",
            shares: 3,
            availableShares: 3,
            liquidationValue: 43.59,
            initialInvestment: 1,
            initialInvestmentCurrency: 1,
            marketValue: 1,
            profit: 1,
            averageCost: 1,
            totalReturn: 1,
          },
        ],
      },
    },
  }),
  "securities-orders-100002": ok([]),
  "broker-orders-100002": ok([
    { id: "202401050000011", shares: 6, amount: 0, status: "COMPLETE" },
    { id: "202402050000012", shares: 3, amount: 0, status: "COMPLETE" },
  ]),
  "broker-order-detail-202401050000011": ok({
    orderReference: "202401050000011",
    orderStatus: "COMPLETE",
    orderOperationTypeEnum: "BUY",
    instrumentIsin: "DE0000000001",
    orderDate: "2024-01-05T09:00:00.000Z",
    shares: 6,
    executedShares: 6,
    priceCurrency: 38.71,
    grossAmountOperationCurrency: 232.26,
    grossAmountCurrency: 0,
    tradeCommissions: 0.47,
    otherCommissions: 0,
    exchangeRate: 1,
    netAmountEUR: 232.73,
    netAmountAccountCurrency: 232.73,
    netAmountCurrency: 232.73,
  }),
  "broker-order-detail-202402050000012": ok({
    orderReference: "202402050000012",
    orderStatus: "COMPLETE",
    orderOperationTypeEnum: "SELL",
    instrumentIsin: "DE0000000001",
    orderDate: "2024-02-05T09:00:00.000Z",
    shares: 3,
    executedShares: 3,
    priceCurrency: 41.18,
    grossAmountOperationCurrency: 123.54,
    grossAmountCurrency: 0,
    tradeCommissions: 0.47,
    otherCommissions: 0,
    exchangeRate: 1,
    netAmountEUR: 123.07,
    netAmountAccountCurrency: 123.07,
    netAmountCurrency: 123.07,
  }),
};

type Obj = { [key: string]: LiteralJson };
const num = (value: LiteralJson | undefined) =>
  value instanceof NumberLiteral ? canonicalDecimal(value.source) : String(value);
const data = (tree: LiteralJson | undefined) => (tree as Obj).payload as Obj;

function rebuilt() {
  const pseudonyms = createPseudonymizer(SECRET);
  const figures = createFigureMap(SECRET);
  const captures = Object.entries(RAW).map(([name, text]) => {
    const raw = parseWithLiterals(text);
    return { name, raw, fake: anonymizeTree(raw, { pseudonyms, figures }) };
  });
  rebuildCaptures(captures);
  const byName = Object.fromEntries(captures.map((c) => [c.name, data(c.fake).data]));
  return { figures, byName };
}

const rows = (value: LiteralJson | undefined) => value as Obj[];

describe("rebuildCaptures", () => {
  it("derives each order's shares from its invented amount and its real price", () => {
    const { figures, byName } = rebuilt();
    const contribution = rows(byName["pension-orders-100003"])[1] as Obj;
    expect(num(contribution.cash)).toBe(figures.amount("104.6"));
    expect(num(contribution.amountBuyVL)).toBe("10.1");
    expect(num(contribution.shares)).toBe(
      roundDecimal(String(Number(figures.amount("104.6")) / 10.1), 3),
    );
    expect(num(contribution.amountToBlock)).toBe(num(contribution.cash));
  });

  it("closes a position the real order closed, and both legs of a transfer move the same cash", () => {
    const { byName } = rebuilt();
    const [external, contribution, out, into] = rows(
      byName["pension-orders-100003"],
    ) as Obj[];
    expect(num(out?.shares)).toBe(
      addDecimals([num(external?.shares), num(contribution?.shares)]),
    );
    expect(num(out?.cash)).toBe(num(into?.cash));
    expect(num(out?.cash)).toBe(
      roundDecimal(multiplyDecimal(num(out?.shares), "10.3172"), 2),
    );
  });

  it("recalculates today's shares, invested and value of every plan from its orders (P8)", () => {
    const { byName } = rebuilt();
    const into = rows(byName["pension-orders-100003"])[3] as Obj;
    const plan = rows(byName["pension-account-100003"])[0] as Obj;
    expect(num(plan.shares)).toBe(num(into.shares));
    expect(num(plan.totalInvested)).toBe(num(into.cash));
    expect(num(plan.marketValue)).toBe(multiplyDecimal(num(plan.shares), "22.61"));
    const account = rows(byName["pension-accounts"])[0] as Obj;
    expect(num(account.amountAccount)).toBe(num(plan.marketValue));
  });

  it("holds as withheld exactly what the orders in progress block", () => {
    const { byName } = rebuilt();
    const inProgress = rows(byName["pension-orders-100003"])[4] as Obj;
    const cash = rows(byName["cash-accounts"])[0] as Obj;
    expect(num(cash.withheldBalance)).toBe(num(inProgress.amountToBlock));
  });

  it("recalculates the broker's position, gross and net from invented shares and real prices", () => {
    const { byName } = rebuilt();
    const buy = byName["broker-order-detail-202401050000011"] as Obj;
    const sell = byName["broker-order-detail-202402050000012"] as Obj;
    expect(num(buy.grossAmountOperationCurrency)).toBe(
      multiplyDecimal(num(buy.executedShares), "38.71"),
    );
    expect(num(buy.netAmountEUR)).toBe(
      addDecimals([num(buy.grossAmountOperationCurrency), num(buy.tradeCommissions)]),
    );
    const listing = rows(byName["broker-orders-100002"]);
    expect(num(listing[0]?.shares)).toBe(num(buy.executedShares));
    const account = byName["securities-account-100002"] as Obj;
    const item = ((account.securitiesAccountInvestments as Obj).BROKER as Obj)
      .investmentList as Obj[];
    expect(num(item[0]?.shares)).toBe(
      addDecimals([num(buy.executedShares), `-${num(sell.executedShares)}`]),
    );
    expect(num(item[0]?.availableShares)).toBe(num(item[0]?.shares));
    expect(num(account.stocksMarketValue)).toBe(num(item[0]?.marketValue));
  });

  it("rebuilds the position series from the invented orders", () => {
    const { byName } = rebuilt();
    const series = (byName["pension-positions-100003"] as Obj).positions as Obj;
    const plan = rows(byName["pension-account-100003"])[0] as Obj;
    const last = (series.N0002 as Obj[])[0] as Obj;
    expect(num(last.totalShares)).toBe(num(plan.shares));
    expect(num(last.investmentAddedValue)).toBe(num(plan.totalInvested));
    expect(num(last.currencyMarketValue)).toBe(num(last.marketValue));
  });

  it("leaves no real amount behind", () => {
    const { byName } = rebuilt();
    const text = JSON.stringify(byName, (_key, value) =>
      value instanceof NumberLiteral ? canonicalDecimal(value.source) : value,
    );
    for (const real of ['"494.77"', '"68.3"', '"232.73"', '"523.49"'])
      expect(text).not.toContain(real);
  });
});
