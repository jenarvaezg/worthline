/**
 * The reads of the MyInvestor connector (#1877), all GET and all read-only (PRD
 * #1876, invariant 1): cash, securities accounts with their positions and orders
 * (funds from cperf, stocks/ETF/ETC from the broker), plans with their orders and
 * `SINCE_BEGINNING` series, the scheduled contributions and the robo-advisor
 * catalog. No cash movements are ever asked for.
 *
 * A reader holds the session of one sync: on a 401 it renews the access token once
 * with the refresh token and repeats the read.
 */
import type { z } from "zod";

import { fail, type MyInvestorResult, type MyInvestorStep, succeed } from "./errors";
import { answerError, type ExchangeContext, envelopeData, exchange } from "./exchange";
import {
  brokerOrderDetailSchema,
  brokerOrdersSchema,
  cashAccountsSchema,
  contributionsSchema,
  type IsoDate,
  type MyInvestorBrokerOrder,
  type MyInvestorBrokerOrderDetail,
  type MyInvestorCashAccount,
  type MyInvestorContribution,
  type MyInvestorOrder,
  type MyInvestorPensionAccount,
  type MyInvestorPensionPlan,
  type MyInvestorPortfolio,
  type MyInvestorSecuritiesAccount,
  type MyInvestorSecuritiesAccountSummary,
  type MyInvestorShareSeries,
  ordersSchema,
  pendingTransfersSchema,
  pensionAccountsSchema,
  pensionPlansSchema,
  portfoliosSchema,
  securitiesAccountSchema,
  securitiesAccountsSchema,
  shareSeriesSchema,
} from "./models";
import { type MyInvestorTokens, refresh } from "./session";

const CPERF = "/cperf-server/api";
const BROKER = "/broker/v2";

/** Both days included, `AAAA-MM-DD`. */
export interface DateRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export interface MyInvestorReader {
  /** The session as it is now: a read may have renewed it. */
  tokens(): MyInvestorTokens;
  cashAccounts(): Promise<MyInvestorResult<MyInvestorCashAccount[]>>;
  securitiesAccounts(): Promise<MyInvestorResult<MyInvestorSecuritiesAccountSummary[]>>;
  /** Today's positions of a securities account. */
  securitiesAccount(
    accountId: string,
  ): Promise<MyInvestorResult<MyInvestorSecuritiesAccount>>;
  /** Fund orders. The full history is `from: "2000-01-01"`. */
  securitiesOrders(
    accountId: string,
    range: DateRange,
  ): Promise<MyInvestorResult<MyInvestorOrder[]>>;
  /** Stock, ETF and ETC orders: no ISIN nor execution, those are in the detail. */
  brokerOrders(
    securitiesAccountId: string,
    range: DateRange,
  ): Promise<MyInvestorResult<MyInvestorBrokerOrder[]>>;
  brokerOrderDetail(
    orderId: string,
  ): Promise<MyInvestorResult<MyInvestorBrokerOrderDetail>>;
  /** How many fund transfers of a securities account are still in progress. */
  pendingFundTransfers(accountId: string): Promise<MyInvestorResult<number>>;
  pensionAccounts(): Promise<MyInvestorResult<MyInvestorPensionAccount[]>>;
  /** Today's plans of a pension account. */
  pensionPlans(accountId: string): Promise<MyInvestorResult<MyInvestorPensionPlan[]>>;
  /** Plan orders. The full history is `from: "2000-01-01"` (#1872). */
  pensionOrders(
    accountId: string,
    range: DateRange,
  ): Promise<MyInvestorResult<MyInvestorOrder[]>>;
  /** Shares per plan since the first contribution (`SINCE_BEGINNING`). */
  pensionShareSeries(accountId: string): Promise<MyInvestorResult<MyInvestorShareSeries>>;
  automaticContributions(): Promise<MyInvestorResult<MyInvestorContribution[]>>;
  portfolios(): Promise<MyInvestorResult<MyInvestorPortfolio[]>>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function checkedRange(range: DateRange): DateRange {
  if (!DAY.test(range.from) || !DAY.test(range.to) || range.from > range.to) {
    throw new RangeError("A MyInvestor date range is two days AAAA-MM-DD, from ≤ to");
  }
  return range;
}

/** The plans' orders take their days undashed, as the web sends them (myinvestor-cli #69). */
function compact(day: IsoDate): string {
  return day.replaceAll("-", "");
}

/** An id as one path segment, so it cannot change the route. */
function segment(id: string): string {
  return encodeURIComponent(id);
}

interface Read<T> {
  readonly step: MyInvestorStep;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly schema: z.ZodType<T, unknown>;
}

export function createMyInvestorReader(
  context: ExchangeContext,
  deviceId: string,
  initial: MyInvestorTokens,
): MyInvestorReader {
  let tokens = initial;

  async function get<T>(read: Read<T>): Promise<MyInvestorResult<T>> {
    let renewed = false;
    for (;;) {
      const result = await exchange(
        context,
        {
          method: "GET",
          path: read.path,
          ...(read.query ? { query: read.query } : {}),
          headers: {
            authorization: `Bearer ${tokens.accessToken}`,
            "x-device-id": deviceId,
          },
        },
        read.step,
      );
      if (!result.ok) return result;
      const answer = result.value;

      if (answer.status === 401) {
        if (renewed || tokens.refreshToken === null) {
          return fail(answerError("session_expired", read.step, answer));
        }
        const fresh = await refresh(context, deviceId, tokens.refreshToken);
        if (!fresh.ok) return fail(fresh.error);
        tokens = fresh.value;
        renewed = true;
        continue;
      }
      if (answer.status === 202) {
        return fail(answerError("sms_required", read.step, answer, null));
      }
      if (answer.status !== 200) {
        return fail(answerError("unexpected_response", read.step, answer));
      }
      const parsed = read.schema.safeParse(envelopeData(answer.body));
      return parsed.success
        ? succeed(parsed.data)
        : fail(answerError("unexpected_response", read.step, answer, null));
    }
  }

  return {
    tokens: () => tokens,
    cashAccounts: () =>
      get({
        step: "cash",
        path: `${CPERF}/v2/cash-accounts/self`,
        schema: cashAccountsSchema,
      }),
    securitiesAccounts: () =>
      get({
        step: "positions",
        path: `${CPERF}/v2/securities-accounts/self-basic`,
        schema: securitiesAccountsSchema,
      }),
    securitiesAccount: (accountId) =>
      get({
        step: "positions",
        path: `${CPERF}/v2/securities-accounts/${segment(accountId)}`,
        schema: securitiesAccountSchema,
      }),
    securitiesOrders: async (accountId, range) => {
      const { from, to } = checkedRange(range);
      return get({
        step: "orders",
        path: `${CPERF}/v3/securities-accounts/${segment(accountId)}/orders`,
        query: { dateFrom: from, dateTo: to },
        schema: ordersSchema,
      });
    },
    brokerOrders: async (securitiesAccountId, range) => {
      const { from, to } = checkedRange(range);
      return get({
        step: "orders",
        path: `${BROKER}/stock-orders`,
        query: {
          stockAccountId: securitiesAccountId,
          type: "ALL",
          dateFrom: from,
          dateTo: to,
        },
        schema: brokerOrdersSchema,
      });
    },
    brokerOrderDetail: (orderId) =>
      get({
        step: "orders",
        path: `${BROKER}/stock-orders/${segment(orderId)}`,
        schema: brokerOrderDetailSchema,
      }),
    pendingFundTransfers: (accountId) =>
      get({
        step: "orders",
        path: `${CPERF}/v2/securities-accounts/${segment(accountId)}/transfers/pending`,
        schema: pendingTransfersSchema,
      }),
    pensionAccounts: () =>
      get({
        step: "plans",
        path: `${CPERF}/v2/pension-accounts/self`,
        schema: pensionAccountsSchema,
      }),
    pensionPlans: (accountId) =>
      get({
        step: "plans",
        path: `${CPERF}/v2/pension-accounts/${segment(accountId)}`,
        schema: pensionPlansSchema,
      }),
    pensionOrders: async (accountId, range) => {
      const { from, to } = checkedRange(range);
      return get({
        step: "plans",
        path: `${CPERF}/v2/pension-accounts/${segment(accountId)}/orders`,
        query: { dateFrom: compact(from), dateTo: compact(to) },
        schema: ordersSchema,
      });
    },
    pensionShareSeries: (accountId) =>
      get({
        step: "plans",
        path: `${CPERF}/v2/pension-accounts/${segment(accountId)}/positions`,
        query: { groupType: "SINCE_BEGINNING" },
        schema: shareSeriesSchema,
      }),
    automaticContributions: () =>
      get({
        step: "contributions",
        path: `${CPERF}/v2/automatic-contributions/self`,
        schema: contributionsSchema,
      }),
    portfolios: () =>
      get({
        step: "positions",
        path: `${CPERF}/v2/portfolios`,
        schema: portfoliosSchema,
      }),
  };
}
