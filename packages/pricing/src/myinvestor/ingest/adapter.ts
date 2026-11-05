/**
 * The MyInvestor ingestion adapter (#1878, ADR 0115): the port of ADR 0066 over the
 * read-only client of #1877. It reads, normalizes and returns facts; it never
 * touches the workspace, and the application reconciles and commits them.
 *
 * - `fetch_transactions`: the finished orders of every securities and pension
 *   account, as operation facts ({@link normalizeMyInvestorOrders}). The cursor is
 *   the day of the last good sync; each sync re-reads the 30 days before it (ADR
 *   0114, decision 5), the first one the whole history from 2000-01-01 (#1872).
 *   The broker's list is asked one calendar year at a time
 *   ({@link calendarYearWindows}): with a long history MyInvestor answers the whole
 *   range with a 500, every time, while each year on its own reads fine.
 * - `fetch_positions`: the units of every holding today, the witness of P8.
 * - `fetch_balances`: every cash account's balance today, holds included.
 * - `discover_accounts`: the cash, securities and pension accounts, with what
 *   belongs to someone else unticked (#1869 P3).
 * - `disconnect`: nothing to undo at MyInvestor (the connector never writes there);
 *   declared so the application's unlink runs the same path as every connector.
 *
 * Positions and balances are today's picture, not a resumable stream: they hand
 * the cursor back untouched, so they can never move the orders' cursor past an
 * order nobody read.
 *
 * Cash movements are never asked for (PRD #1876, invariant 1).
 */

import {
  type MyInvestorError,
  type MyInvestorResult,
  safeCode,
} from "@pricing/myinvestor/errors";
import type {
  MyInvestorBrokerOrder,
  MyInvestorCashAccount,
  MyInvestorOwnership,
  MyInvestorSecuritiesAccountSummary,
} from "@pricing/myinvestor/models";
import type { DateRange, MyInvestorReader } from "@pricing/myinvestor/reader";
import {
  addUnits,
  type ConnectorAccount,
  type ConnectorAdapter,
  type ConnectorCapability,
  type FetchRequest,
  type NormalizedBatch,
  overlappingDateWindow,
} from "@worthline/domain";
import type {
  MyInvestorCashBalanceFact,
  MyInvestorFact,
  MyInvestorFactPayload,
  MyInvestorPositionFact,
  MyInvestorSkippedOrder,
} from "./facts";
import {
  type MyInvestorAccountOrders,
  type MyInvestorBrokerExecution,
  normalizeMyInvestorOrders,
} from "./normalize";

export const MYINVESTOR_ADAPTER_ID = "myinvestor";
/** Where the first sync starts: before any MyInvestor account existed (#1872). */
export const MYINVESTOR_HISTORY_ORIGIN = "2000-01-01";
/** Days each sync re-reads before the last good one (ADR 0114, decision 5). */
export const MYINVESTOR_CURSOR_OVERLAP_DAYS = 30;

const CAPABILITIES: readonly ConnectorCapability[] = [
  { kind: "discover_accounts" },
  { kind: "fetch_transactions" },
  { kind: "fetch_positions" },
  { kind: "fetch_balances" },
  { kind: "disconnect" },
];

/** A read that failed: the client's typed error, for the sync to map to its action. */
export class MyInvestorSyncError extends Error {
  readonly error: MyInvestorError;

  constructor(error: MyInvestorError) {
    super(`MyInvestor read failed: ${error.kind} at ${error.step}`);
    this.name = "MyInvestorSyncError";
    this.error = error;
  }
}

export interface MyInvestorAdapterOptions {
  /** The reads of this sync's session (`client.reader(tokens)`). */
  readonly reader: MyInvestorReader;
  /** The day of this sync, `AAAA-MM-DD`: injected, never read from the clock. */
  readonly today: string;
  /** Hears every finished order or position that produced no fact, and why. */
  readonly onSkipped?: (skipped: MyInvestorSkippedOrder) => void;
}

/** The account ids of the facts and of discovery: one namespace per kind of account. */
export function myInvestorAccountId(
  kind: "cash" | "securities" | "pension",
  id: string,
): string {
  return `${kind}:${id}`;
}

function unwrap<T>(result: MyInvestorResult<T>): T {
  if (!result.ok) throw new MyInvestorSyncError(result.error);
  return result.value;
}

/** A failed call about one securities account names that account's type, never its id. */
function ofAccount<T>(
  result: MyInvestorResult<T>,
  summary: MyInvestorSecuritiesAccountSummary,
): MyInvestorResult<T> {
  return result.ok
    ? result
    : {
        error: { ...result.error, accountType: safeCode(summary.accountType) },
        ok: false,
      };
}

function includedByDefault(
  ownership: MyInvestorOwnership | undefined,
): boolean | undefined {
  return ownership === undefined ? undefined : ownership === "me";
}

function securitiesLabel(account: MyInvestorSecuritiesAccountSummary): string {
  return account.accountType === "SECURITIES_PORTFOLIO"
    ? "Cartera del roboadvisor"
    : "Cuenta de valores";
}

/** Broker order details asked at once (see `transactions`). */
const DETAIL_CONCURRENCY = 4;

/** `run` over `items`, `size` at a time, the results in the items' order. */
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  }
  return results;
}

/**
 * `range` cut into calendar years, in order: the first from `range.from`, the last
 * up to `range.to`, each one inside a single year. A range inside one year is
 * itself.
 */
export function calendarYearWindows(range: DateRange): DateRange[] {
  const windows: DateRange[] = [];
  let from = range.from;
  while (from <= range.to) {
    const yearEnd = `${from.slice(0, 4)}-12-31`;
    const to = yearEnd < range.to ? yearEnd : range.to;
    windows.push({ from, to });
    from = `${Number(from.slice(0, 4)) + 1}-01-01`;
  }
  return windows;
}

export function createMyInvestorAdapter(
  options: MyInvestorAdapterOptions,
): ConnectorAdapter<MyInvestorFactPayload> {
  const { reader, today } = options;
  const report = options.onSkipped ?? (() => {});

  async function transactions(
    cursor: FetchRequest["cursor"],
  ): Promise<NormalizedBatch<MyInvestorFactPayload>> {
    const window = overlappingDateWindow(cursor, today, {
      origin: MYINVESTOR_HISTORY_ORIGIN,
      overlapDays: MYINVESTOR_CURSOR_OVERLAP_DAYS,
    });
    const range: DateRange = { from: window.from, to: window.to };

    const accounts: MyInvestorAccountOrders[] = [];
    const broker: MyInvestorBrokerExecution[] = [];
    for (const summary of unwrap(await reader.securitiesAccounts())) {
      const accountId = myInvestorAccountId("securities", summary.accountId);
      if (summary.hasFundsOperations !== false) {
        const orders = unwrap(
          ofAccount(await reader.securitiesOrders(summary.accountId, range), summary),
        );
        accounts.push({ accountId, product: "fund", orders });
      }
      if (summary.hasBrokerOperations !== false) {
        const listed: MyInvestorBrokerOrder[] = [];
        const seen = new Set<string>();
        for (const year of calendarYearWindows(range)) {
          const orders = unwrap(
            ofAccount(await reader.brokerOrders(summary.accountId, year), summary),
          );
          for (const order of orders) {
            if (seen.has(order.id)) continue;
            seen.add(order.id);
            listed.push(order);
          }
        }
        // The list has neither ISIN nor execution; only a finished order is worth its
        // detail. A long history has a hundred of them: asked four at a time, as a
        // browser would, or the first sync outlasts the cron's 60 s.
        const finished = listed.filter((order) => order.status === "COMPLETE");
        const details = await inBatches(finished, DETAIL_CONCURRENCY, (order) =>
          reader.brokerOrderDetail(order.id),
        );
        for (const detail of details) {
          broker.push({ accountId, detail: unwrap(ofAccount(detail, summary)) });
        }
      }
    }
    for (const pension of unwrap(await reader.pensionAccounts())) {
      const orders = unwrap(await reader.pensionOrders(pension.accountId, range));
      accounts.push({
        accountId: myInvestorAccountId("pension", pension.accountId),
        product: "pension_plan",
        orders,
      });
    }

    const facts: MyInvestorFact[] = normalizeMyInvestorOrders(
      { accounts, broker },
      report,
    );
    return { facts, cursor: window.next };
  }

  async function positions(): Promise<MyInvestorFact[]> {
    const payloads: MyInvestorPositionFact[] = [];
    for (const summary of unwrap(await reader.securitiesAccounts())) {
      const accountId = myInvestorAccountId("securities", summary.accountId);
      const account = unwrap(await reader.securitiesAccount(summary.accountId));
      for (const position of account.positions) {
        const product = position.productType === "BROKER" ? "broker" : "fund";
        if (!position.isin) {
          report({
            reference: `${accountId}:${position.ticker ?? position.name ?? "?"}`,
            product,
            sourceType: position.productType,
            reason: "missing_instrument",
          });
          continue;
        }
        payloads.push({
          kind: "position",
          product,
          accountId,
          instrument: { scheme: "isin", code: position.isin },
          instrumentName: position.name,
          units: position.shares,
          asOf: today,
        });
      }
    }
    for (const pension of unwrap(await reader.pensionAccounts())) {
      const accountId = myInvestorAccountId("pension", pension.accountId);
      for (const plan of unwrap(await reader.pensionPlans(pension.accountId))) {
        payloads.push({
          kind: "position",
          product: "pension_plan",
          accountId,
          instrument: { scheme: "dgs", code: plan.dgsCode },
          instrumentName: plan.name,
          units: plan.shares,
          asOf: today,
        });
      }
    }
    // The units are in the key: a second read of the same day with other units is a new fact.
    return payloads.map((payload) => ({
      key: `position:${payload.accountId}:${payload.instrument.scheme}:${payload.instrument.code}:${today}:${payload.units}`,
      dateKey: today,
      payload,
    }));
  }

  function balanceOf(account: MyInvestorCashAccount): MyInvestorCashBalanceFact {
    return {
      kind: "cash_balance",
      accountId: myInvestorAccountId("cash", account.accountId),
      currency: account.currency,
      available: account.enabledBalance,
      withheld: account.withheldBalance,
      // `enabledBalance` leaves the holds of orders in progress out; they are still the user's.
      balance: addUnits(account.enabledBalance, account.withheldBalance),
      ownership: account.ownership,
      asOf: today,
    };
  }

  async function balances(): Promise<MyInvestorFact[]> {
    return unwrap(await reader.cashAccounts()).map((account) => {
      const payload = balanceOf(account);
      return {
        key: `balance:${payload.accountId}:${today}:${payload.balance}`,
        dateKey: today,
        payload,
      };
    });
  }

  return {
    id: MYINVESTOR_ADAPTER_ID,
    capabilities: CAPABILITIES,
    discoverAccounts: async (): Promise<ConnectorAccount[]> => {
      const cash = unwrap(await reader.cashAccounts());
      const ownershipOfCash = new Map(
        cash.map((account) => [account.accountId, account.ownership]),
      );
      const securities = unwrap(await reader.securitiesAccounts());
      const pensions = unwrap(await reader.pensionAccounts());

      const accounts: ConnectorAccount[] = [
        ...cash.map((account) => ({
          externalId: myInvestorAccountId("cash", account.accountId),
          label: account.alias ?? "Cuenta de efectivo",
          includedByDefault: account.ownership === "me",
        })),
        ...securities.map((account) => {
          const included = includedByDefault(
            account.cashAccountId === null
              ? undefined
              : ownershipOfCash.get(account.cashAccountId),
          );
          return {
            externalId: myInvestorAccountId("securities", account.accountId),
            label: securitiesLabel(account),
            ...(included === undefined ? {} : { includedByDefault: included }),
          };
        }),
        ...pensions.map((account) => ({
          externalId: myInvestorAccountId("pension", account.accountId),
          label: "Planes de pensiones",
          includedByDefault: account.ownership === "me",
        })),
      ];
      return accounts;
    },
    fetch: async (request) => {
      switch (request.capability) {
        case "fetch_transactions":
          return transactions(request.cursor);
        case "fetch_positions":
          return { facts: await positions(), cursor: request.cursor };
        case "fetch_balances":
          return { facts: await balances(), cursor: request.cursor };
      }
    },
    disconnect: async () => {},
  };
}
