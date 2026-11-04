/**
 * What worthline finds in a MyInvestor account on its first start (#1880, PRD #1876
 * S5): the accounts as the user sees them in the bank, the products in each with their
 * strong identifier (#1869 P3), the units of today and EVERY finished operation since
 * the account was opened. It is kept as one document per connection
 * (`connected_source_discoveries`), so choosing what to include, and including later
 * what was left out, never asks MyInvestor again.
 *
 * Two halves:
 * - {@link readMyInvestorDiscovery} does the reads, with a session's reader; the
 *   operations come from the ingestion adapter (#1878), the whole history from
 *   2000-01-01 (#1872).
 * - {@link buildMyInvestorDiscovery} is pure: what those reads mean.
 *
 * What it reads and what it never reads (PRD #1876, invariants 1 and 2): no cash
 * movements, and no valuation of MyInvestor's — worthline prices everything itself.
 */

import type { DecimalString, NormalizedFact } from "@worthline/domain";
import { addUnits, isPositiveDecimal } from "@worthline/domain";
import type {
  MyInvestorCashAccount,
  MyInvestorFact,
  MyInvestorInstrument,
  MyInvestorOperationFact,
  MyInvestorOwnership,
  MyInvestorPensionAccount,
  MyInvestorPensionPlan,
  MyInvestorReader,
  MyInvestorResult,
  MyInvestorSecuritiesAccount,
  MyInvestorSecuritiesAccountSummary,
} from "@worthline/pricing";
import {
  createMyInvestorAdapter,
  MyInvestorSyncError,
  myInvestorAccountId,
  myInvestorHoldingKey,
} from "@worthline/pricing";

export const MYINVESTOR_DISCOVERY_VERSION = 1;

/** What a product is, in the words the fold uses. */
export type MyInvestorProductKind =
  | "fund"
  | "etf"
  | "stock"
  | "plan"
  | "cash"
  | "managed";

export interface MyInvestorDiscoveredAccount {
  /** `securities:…`, `portfolio:…`, `pension:…` or `cash:…`. */
  readonly key: string;
  readonly kind: "securities" | "portfolio" | "pension" | "cash";
  readonly label: string;
  readonly sub: string;
  /** Someone else's (a minor the user represents): it arrives unticked (#1869 P3). */
  readonly otherHolder: boolean;
}

export interface MyInvestorDiscoveredProduct {
  /**
   * The strong identifier (#1869 P3): account + ISIN or DGS code for what has units
   * ({@link myInvestorHoldingKey}), the account for cash and for a managed portfolio.
   */
  readonly key: string;
  readonly accountKey: string;
  readonly kind: MyInvestorProductKind;
  readonly name: string;
  /** What the row prints: the ISIN, the DGS code or the shortened IBAN. */
  readonly identifier: string | null;
  /** ISIN or DGS code; null for cash and a managed portfolio. */
  readonly instrument: MyInvestorInstrument | null;
  /** The units MyInvestor reports today; null for cash and a managed portfolio. */
  readonly units: DecimalString | null;
  /** A cash account's balance today: what is available plus what is held (P4). */
  readonly cash: {
    readonly balance: DecimalString;
    readonly withheld: DecimalString;
    readonly currency: string;
  } | null;
  /** A managed portfolio's funds and its cash, as names (S8 links it as a block). */
  readonly members: readonly string[];
  readonly otherHolder: boolean;
}

export interface MyInvestorDiscovery {
  readonly version: typeof MYINVESTOR_DISCOVERY_VERSION;
  /** The day of the read, `YYYY-MM-DD`: the cursor a first start resumes from. */
  readonly readOn: string;
  readonly accounts: readonly MyInvestorDiscoveredAccount[];
  readonly products: readonly MyInvestorDiscoveredProduct[];
  /** Every finished operation of every securities and pension account, oldest first. */
  readonly operations: readonly NormalizedFact<MyInvestorOperationFact>[];
}

/** The reads the discovery is made of. */
export interface MyInvestorDiscoveryReads {
  readonly readOn: string;
  readonly cashAccounts: readonly MyInvestorCashAccount[];
  readonly securities: readonly {
    readonly summary: MyInvestorSecuritiesAccountSummary;
    readonly account: MyInvestorSecuritiesAccount;
  }[];
  readonly pensions: readonly {
    readonly account: MyInvestorPensionAccount;
    readonly plans: readonly MyInvestorPensionPlan[];
  }[];
  readonly operations: readonly MyInvestorFact[];
}

const PORTFOLIO = "SECURITIES_PORTFOLIO";

function lastDigits(id: string): string {
  return `···${id.slice(-4)}`;
}

function isOther(ownership: MyInvestorOwnership | undefined): boolean {
  return ownership !== undefined && ownership !== "me";
}

function otherSub(ownership: MyInvestorOwnership | undefined): string | null {
  if (ownership === "junior") return "De otro titular: la representas (menor de edad)";
  if (ownership === "other") return "De otro titular";
  return null;
}

function securitiesSub(summary: MyInvestorSecuritiesAccountSummary): string {
  const funds = summary.hasFundsOperations !== false;
  const broker = summary.hasBrokerOperations === true;
  if (funds && broker) return "Fondos y bróker";
  if (broker) return "Bróker";
  return "Fondos";
}

function operationFacts(
  facts: readonly MyInvestorFact[],
): NormalizedFact<MyInvestorOperationFact>[] {
  return facts.flatMap((fact) =>
    fact.payload.kind === "operation"
      ? [{ dateKey: fact.dateKey, key: fact.key, payload: fact.payload }]
      : [],
  );
}

/** The kind of a product with units, from what MyInvestor says it is. */
function unitKind(
  product: MyInvestorOperationFact["product"],
  brokerProductType: string | null,
): MyInvestorProductKind {
  if (product === "pension_plan") return "plan";
  if (product === "fund") return "fund";
  return brokerProductType === "ETF" ? "etf" : "stock";
}

/**
 * What the reads mean, as one document. Pure.
 *
 * - Each securities account is an account of the fold, with a product per fund or
 *   broker position today and per instrument it traded and no longer holds.
 * - A robo-advisor account (`SECURITIES_PORTFOLIO`) is ONE product, a managed
 *   portfolio with its funds and its own cash account inside: that cash account is
 *   not offered on its own, since S8 (#1883) links the three as one block.
 * - Each pension account is an account, with a product per plan (by DGS code).
 * - Each other cash account is an account with one product, its balance.
 * - Whose an account is follows the adapter (#1878): a securities account is its
 *   cash account's holder's.
 */
export function buildMyInvestorDiscovery(
  reads: MyInvestorDiscoveryReads,
): MyInvestorDiscovery {
  const cashById = new Map(reads.cashAccounts.map((cash) => [cash.accountId, cash]));
  const operations = operationFacts(reads.operations);
  const accounts: MyInvestorDiscoveredAccount[] = [];
  const products: MyInvestorDiscoveredProduct[] = [];
  const portfolioCash = new Set<string>();

  const addTradedWithoutPosition = (
    accountKey: string,
    accountId: string,
    otherHolder: boolean,
    seen: Set<string>,
  ) => {
    for (const { payload } of operations) {
      if (payload.accountId !== accountId) continue;
      const key = myInvestorHoldingKey(payload.accountId, payload.instrument);
      if (seen.has(key)) continue;
      seen.add(key);
      products.push({
        accountKey,
        cash: null,
        identifier: payload.instrument.code,
        instrument: payload.instrument,
        key,
        kind: unitKind(payload.product, null),
        members: [],
        name: payload.instrumentName ?? payload.instrument.code,
        otherHolder,
        units: "0",
      });
    }
  };

  for (const { summary, account } of reads.securities) {
    const cash =
      summary.cashAccountId === null ? undefined : cashById.get(summary.cashAccountId);
    const ownership = cash?.ownership;
    const otherHolder = isOther(ownership);

    if (summary.accountType === PORTFOLIO) {
      const key = `portfolio:${summary.accountId}`;
      if (summary.cashAccountId !== null) portfolioCash.add(summary.cashAccountId);
      const label = account.portfolioName ?? "Cartera del roboadvisor";
      accounts.push({
        key,
        kind: "portfolio",
        label,
        otherHolder,
        sub:
          otherSub(ownership) ??
          `Roboadvisor · cuenta de valores ${lastDigits(summary.accountId)}`,
      });
      products.push({
        accountKey: key,
        cash: null,
        identifier: null,
        instrument: null,
        key,
        kind: "managed",
        members: [
          ...account.positions.map((position) => position.name ?? position.isin ?? "?"),
          ...(cash ? [`${cash.alias ?? "Cuenta de efectivo"} (efectivo)`] : []),
        ],
        name: label,
        otherHolder,
        units: null,
      });
      continue;
    }

    const accountId = myInvestorAccountId("securities", summary.accountId);
    accounts.push({
      key: accountId,
      kind: "securities",
      label: `Cuenta de valores ${lastDigits(summary.accountId)}`,
      otherHolder,
      sub: otherSub(ownership) ?? securitiesSub(summary),
    });
    const seen = new Set<string>();
    for (const position of account.positions) {
      if (!position.isin) continue;
      const product = position.productType === "BROKER" ? "broker" : "fund";
      const instrument: MyInvestorInstrument = { code: position.isin, scheme: "isin" };
      const key = myInvestorHoldingKey(accountId, instrument);
      if (seen.has(key)) continue;
      seen.add(key);
      products.push({
        accountKey: accountId,
        cash: null,
        identifier: position.isin,
        instrument,
        key,
        kind: unitKind(product, position.brokerProductType),
        members: [],
        name: position.name ?? position.isin,
        otherHolder,
        units: position.shares,
      });
    }
    addTradedWithoutPosition(accountId, accountId, otherHolder, seen);
  }

  for (const { account, plans } of reads.pensions) {
    const accountId = myInvestorAccountId("pension", account.accountId);
    const otherHolder = isOther(account.ownership);
    accounts.push({
      key: accountId,
      kind: "pension",
      label: `Planes de pensiones ${lastDigits(account.accountId)}`,
      otherHolder,
      sub:
        otherSub(account.ownership) ??
        `${plans.length} ${plans.length === 1 ? "plan" : "planes"}`,
    });
    const seen = new Set<string>();
    for (const plan of plans) {
      const instrument: MyInvestorInstrument = { code: plan.dgsCode, scheme: "dgs" };
      const key = myInvestorHoldingKey(accountId, instrument);
      if (seen.has(key)) continue;
      seen.add(key);
      products.push({
        accountKey: accountId,
        cash: null,
        identifier: plan.dgsCode,
        instrument,
        key,
        kind: "plan",
        members: [],
        name: plan.name ?? plan.dgsCode,
        otherHolder,
        units: plan.shares,
      });
    }
    addTradedWithoutPosition(accountId, accountId, otherHolder, seen);
  }

  for (const cash of reads.cashAccounts) {
    if (portfolioCash.has(cash.accountId)) continue;
    const key = myInvestorAccountId("cash", cash.accountId);
    const otherHolder = isOther(cash.ownership);
    const name = cash.alias ?? "Cuenta de efectivo";
    accounts.push({
      key,
      kind: "cash",
      label: name,
      otherHolder,
      sub: otherSub(cash.ownership) ?? "Cuenta de efectivo",
    });
    products.push({
      accountKey: key,
      // `enabledBalance` leaves out what is held for orders in progress, and those
      // orders are not in the book until they finish (invariant 4): the held part
      // still belongs to the user, so it counts here, once (#1869 P4).
      cash: {
        balance: addUnits(cash.enabledBalance, cash.withheldBalance),
        currency: cash.currency,
        withheld: cash.withheldBalance,
      },
      identifier: cash.ibanMasked,
      instrument: null,
      key,
      kind: "cash",
      members: [],
      name,
      otherHolder,
      units: null,
    });
  }

  return {
    accounts,
    operations,
    products,
    readOn: reads.readOn,
    version: MYINVESTOR_DISCOVERY_VERSION,
  };
}

function unwrap<T>(result: MyInvestorResult<T>): T {
  if (!result.ok) throw new MyInvestorSyncError(result.error);
  return result.value;
}

/**
 * Read the whole account with a session's reader. Throws {@link MyInvestorSyncError}
 * with the client's typed error when a read fails; nothing is kept then.
 */
export async function readMyInvestorDiscovery(
  reader: MyInvestorReader,
  today: string,
): Promise<MyInvestorDiscovery> {
  const adapter = createMyInvestorAdapter({ reader, today });
  const transactions = await adapter.fetch({
    capability: "fetch_transactions",
    cursor: null,
  });

  const cashAccounts = unwrap(await reader.cashAccounts());
  const securities = [];
  for (const summary of unwrap(await reader.securitiesAccounts())) {
    securities.push({
      account: unwrap(await reader.securitiesAccount(summary.accountId)),
      summary,
    });
  }
  const pensions = [];
  for (const account of unwrap(await reader.pensionAccounts())) {
    pensions.push({
      account,
      plans: unwrap(await reader.pensionPlans(account.accountId)),
    });
  }

  return buildMyInvestorDiscovery({
    cashAccounts,
    operations: transactions.facts,
    pensions,
    readOn: today,
    securities,
  });
}

export function serializeMyInvestorDiscovery(discovery: MyInvestorDiscovery): string {
  return JSON.stringify(discovery);
}

/**
 * A stored discovery, or null when the row is not one this version reads (an older
 * shape, or a corrupt row): the fold then offers to read MyInvestor again instead of
 * trusting a document it cannot vouch for.
 */
export function parseMyInvestorDiscovery(
  payloadJson: string,
): MyInvestorDiscovery | null {
  try {
    const parsed = JSON.parse(payloadJson) as Partial<MyInvestorDiscovery> | null;
    if (
      parsed === null ||
      parsed.version !== MYINVESTOR_DISCOVERY_VERSION ||
      typeof parsed.readOn !== "string" ||
      !Array.isArray(parsed.accounts) ||
      !Array.isArray(parsed.products) ||
      !Array.isArray(parsed.operations)
    ) {
      return null;
    }
    return parsed as MyInvestorDiscovery;
  } catch {
    return null;
  }
}

/** Whether a product holds anything today: units above zero, or a cash balance. */
export function holdsSomethingToday(product: MyInvestorDiscoveredProduct): boolean {
  if (product.kind === "cash") return true;
  if (product.kind === "managed") return true;
  return product.units !== null && isPositiveDecimal(product.units);
}
