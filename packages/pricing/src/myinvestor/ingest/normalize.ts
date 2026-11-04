/**
 * MyInvestor orders → operation facts (#1878, ADR 0115). Pure: no network, no clock.
 *
 * The rules, each from the real captures (#1872, #1887):
 * - **Only finished orders** (`COMPLETE`) become facts; in progress, rejected or
 *   cancelled ones are ignored (PRD #1876, invariant 4). The overlap of the cursor
 *   re-reads them until they settle.
 * - **The direction comes from the type.** DEREGISTRATION and REIMBURSEMENT take units
 *   out, everything else puts them in; MyInvestor writes every `shares` positive.
 *   Folding the facts that way rebuilds today's units exactly (#1869 P8).
 * - **The dedup key is the order's own id**: the `reference` of a fund or plan order
 *   (one namespace, the same server), `broker:` + `orderReference` for the broker,
 *   which numbers its orders apart. Re-reading an overlapping window gives the same
 *   keys.
 * - **The day is `orderDate`**. `effectiveDate` and `expirationDate` are not a
 *   settlement date; the broker's own execution day wins when it has one.
 * - **A plan is its DGS code**, never an ISIN (#1454).
 * - **The broker is read in euros only.** An execution in another currency, or at a
 *   rate that is not one, is skipped as `unsupported_currency`: its amount and its
 *   fees would be added in two currencies.
 *
 * Traspasos (ADR 0115, decision 4) — see {@link pairTransfers}.
 */

import type {
  MyInvestorBrokerOrderDetail,
  MyInvestorOrder,
} from "@pricing/myinvestor/models";
import {
  addUnits,
  compareUnits,
  type DecimalString,
  isPositiveDecimal,
  type NormalizedFact,
  normalizeDecimal,
  type OperationKind,
  subtractUnits,
} from "@worthline/domain";
import type {
  MyInvestorInstrument,
  MyInvestorOperationFact,
  MyInvestorProduct,
  MyInvestorSkippedOrder,
  MyInvestorTransferLeg,
  MyInvestorUnpairedReason,
} from "./facts";

/** The orders of one securities or pension account, as one read returned them. */
export interface MyInvestorAccountOrders {
  readonly accountId: string;
  readonly product: Extract<MyInvestorProduct, "fund" | "pension_plan">;
  readonly orders: readonly MyInvestorOrder[];
}

/** A broker order's detail, with the securities account it was listed under. */
export interface MyInvestorBrokerExecution {
  readonly accountId: string;
  readonly detail: MyInvestorBrokerOrderDetail;
}

export interface MyInvestorOrderBook {
  readonly accounts: readonly MyInvestorAccountOrders[];
  readonly broker: readonly MyInvestorBrokerExecution[];
}

const FINISHED = "COMPLETE";
/**
 * The statuses of an order that is still on its way. Only these hold a finished leg
 * back while it waits for its other half: an allow-list, so a status nobody has seen
 * (or none) never stalls a leg past the cursor's overlap.
 */
const IN_PROGRESS: ReadonlySet<string> = new Set(["IN_PROGRESS"]);

/**
 * How each traspaso type pairs.
 * - `switch`: a traspaso between two funds (`IIC_SWITCH_*`) — same day and amount, no
 *   common id.
 * - `plan_internal`: a traspaso between two plans inside MyInvestor — same shape (#1872).
 * - `internal_transfer`: `INTERNAL_TRANSFER_*` — the captured pair shares neither the
 *   day nor the amount nor any id, so nothing ties it safely: never paired.
 * - `external_in`: the capital came from another institution.
 */
export type MyInvestorTransferGroup =
  | "switch"
  | "plan_internal"
  | "internal_transfer"
  | "external_in";

/** What an order type means: the operation, its account kind and how it pairs. */
export interface MyInvestorTypeRule {
  readonly operation: OperationKind;
  /** The kind of account whose orders carry this type. */
  readonly product: Extract<MyInvestorProduct, "fund" | "pension_plan">;
  readonly transfer: MyInvestorTransferGroup | null;
}

/**
 * The sign table of MyInvestor's order types: the one source for the adapter and for
 * the fixtures' anonymizer (`fixtures/rebuild.ts`), so both fold the same units. A type
 * that is not here has no known sign.
 */
export const MYINVESTOR_TYPE_RULES: Readonly<Record<string, MyInvestorTypeRule>> = {
  INVESTMENT_FUNDS_SUBSCRIPTION: { operation: "buy", product: "fund", transfer: null },
  INVESTMENT_FUNDS_REIMBURSEMENT: { operation: "sell", product: "fund", transfer: null },
  PLAN_CONTRIBUTION: { operation: "buy", product: "pension_plan", transfer: null },
  IIC_SWITCH_DEREGISTRATION: {
    operation: "transfer_out",
    product: "fund",
    transfer: "switch",
  },
  IIC_SWITCH_REGISTRATION: {
    operation: "transfer_in",
    product: "fund",
    transfer: "switch",
  },
  DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER: {
    operation: "transfer_out",
    product: "pension_plan",
    transfer: "plan_internal",
  },
  REGISTRATION_BY_INTERNAL_PLAN_TRANSFER: {
    operation: "transfer_in",
    product: "pension_plan",
    transfer: "plan_internal",
  },
  INTERNAL_TRANSFER_REIMBURSEMENT: {
    operation: "transfer_out",
    product: "fund",
    transfer: "internal_transfer",
  },
  INTERNAL_TRANSFER_SUBSCRIPTION: {
    operation: "transfer_in",
    product: "fund",
    transfer: "internal_transfer",
  },
  REGISTRATION_BY_EXTERNAL_PLAN_TRANSFER: {
    operation: "transfer_in",
    product: "pension_plan",
    transfer: "external_in",
  },
};

/** The broker's sides, by `orderOperationTypeEnum`. */
export const MYINVESTOR_BROKER_SIDES: Readonly<Record<string, OperationKind>> = {
  BUY: "buy",
  SELL: "sell",
};

const OUTGOING: ReadonlySet<OperationKind> = new Set(["sell", "transfer_out"]);

/** Whether an operation takes units out of its holding (MyInvestor writes them positive). */
export function takesUnitsOut(operation: OperationKind): boolean {
  return OUTGOING.has(operation);
}

/**
 * Whether the two halves of this traspaso group are tied by day and amount
 * ({@link pairTransfers}): the halves of any other group are never paired.
 */
export function isPairedTransferGroup(
  group: MyInvestorTransferGroup | null,
): group is "switch" | "plan_internal" {
  return group === "switch" || group === "plan_internal";
}

const EURO = "EUR";

type Report = (skipped: MyInvestorSkippedOrder) => void;

function absolute(value: DecimalString): DecimalString {
  return value.startsWith("-") ? normalizeDecimal(value.slice(1)) : value;
}

/** The figure when it is above zero; `null` for zero, a negative or no figure. */
function positiveOrNull(value: DecimalString | null): DecimalString | null {
  return value !== null && isPositiveDecimal(value) ? value : null;
}

/** Euros on both sides at a rate of exactly one: the only executions folded as they are. */
function isEuroAtParity(detail: MyInvestorBrokerOrderDetail): boolean {
  return (
    (detail.instrumentCurrency ?? detail.currency) === EURO &&
    detail.currency === EURO &&
    detail.exchangeRate !== null &&
    compareUnits(detail.exchangeRate, "1") === 0
  );
}

function instrumentOf(
  product: MyInvestorAccountOrders["product"],
  order: MyInvestorOrder,
): MyInvestorInstrument | null {
  if (product === "pension_plan") {
    return order.dgsCode ? { scheme: "dgs", code: order.dgsCode } : null;
  }
  return order.isin ? { scheme: "isin", code: order.isin } : null;
}

/** A traspaso leg waiting for {@link pairTransfers}. */
interface Leg {
  readonly fact: MyInvestorOperationFact;
  readonly group: "switch" | "plan_internal";
}

/** An order that could still become the other half of a finished leg. */
interface Candidate {
  readonly key: string;
  readonly accountId: string;
  readonly group: MyInvestorTransferGroup;
  readonly operation: OperationKind;
  readonly day: string;
  readonly amount: DecimalString | null;
  readonly instrumentCode: string;
  readonly finished: boolean;
}

function fitsAsOtherHalf(leg: Candidate, other: Candidate): boolean {
  return (
    other.key !== leg.key &&
    other.group === leg.group &&
    other.accountId === leg.accountId &&
    other.operation !== leg.operation &&
    other.day === leg.day &&
    leg.amount !== null &&
    other.amount !== null &&
    compareUnits(leg.amount, other.amount) === 0 &&
    other.instrumentCode !== leg.instrumentCode
  );
}

function transferIdOf(outKey: string, inKey: string): string {
  return `myinvestor-transfer:${outKey}:${inKey}`;
}

type Pairing =
  | { readonly kind: "leg"; readonly transfer: MyInvestorTransferLeg }
  | { readonly kind: "wait" };

/**
 * Ties the two halves of a traspaso between funds or between plans (ADR 0115,
 * decision 4). MyInvestor gives them no common id (#1872), so the key is synthetic:
 * same account, same day, same amount, opposite directions and a different
 * instrument (ISIN for funds, DGS code for plans).
 *
 * It pairs only when the match is mutual and unique. Anything else stays explicit:
 * - no candidate → `unpaired` / `no_counterpart`;
 * - more than one → `unpaired` / `ambiguous`: which fund the cost travels to would be
 *   a guess;
 * - the only candidate is still in progress → the leg waits (no fact). Once both are
 *   finished, the cursor's overlap re-reads them and they pair: emitting the lone leg
 *   now would burn its key in the dedup ledger and the pair could never form.
 */
function pairTransfers(
  legs: readonly Leg[],
  candidates: readonly Candidate[],
): ReadonlyMap<string, Pairing> {
  const candidateOf = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const fitsOf = (candidate: Candidate) =>
    candidates.filter((other) => fitsAsOtherHalf(candidate, other));

  const result = new Map<string, Pairing>();
  for (const { fact } of legs) {
    const self = candidateOf.get(fact.reference);
    const fits = self ? fitsOf(self) : [];
    const [only] = fits;
    if (fits.length === 0 || !only) {
      result.set(fact.reference, {
        kind: "leg",
        transfer: unpairedLeg(fact, "no_counterpart"),
      });
      continue;
    }
    if (fits.length > 1 || fitsOf(only).length > 1) {
      result.set(fact.reference, {
        kind: "leg",
        transfer: unpairedLeg(fact, "ambiguous"),
      });
      continue;
    }
    if (!only.finished) {
      result.set(fact.reference, { kind: "wait" });
      continue;
    }
    const outKey = fact.operation === "transfer_out" ? fact.reference : only.key;
    const inKey = fact.operation === "transfer_out" ? only.key : fact.reference;
    result.set(fact.reference, {
      kind: "leg",
      transfer: {
        pairing: "paired",
        transferId: transferIdOf(outKey, inKey),
        counterpartKey: only.key,
      },
    });
  }
  return result;
}

function unpairedLeg(
  fact: Pick<MyInvestorOperationFact, "reference" | "operation">,
  reason: MyInvestorUnpairedReason,
): MyInvestorTransferLeg {
  return {
    pairing: "unpaired",
    reason,
    transferId: `myinvestor-unpaired:${fact.reference}`,
    inheritedCost: fact.operation === "transfer_in" ? "pending" : null,
  };
}

interface Classified {
  readonly facts: MyInvestorOperationFact[];
  readonly legs: Leg[];
  readonly candidates: Candidate[];
}

function classifyAccount(
  account: MyInvestorAccountOrders,
  report: Report,
  into: Classified,
): void {
  for (const order of account.orders) {
    const status = order.status ?? "";
    const rule = order.operationType
      ? MYINVESTOR_TYPE_RULES[order.operationType]
      : undefined;
    const instrument = instrumentOf(account.product, order);
    const finished = status === FINISHED;

    // A leg in progress can still become the other half of a finished one: it holds
    // that one back. A finished leg joins once it has produced its own fact, so a leg
    // is never paired with an order that left no fact behind.
    const candidate = (isFinished: boolean): Candidate | null =>
      rule?.transfer && instrument
        ? {
            key: order.reference,
            accountId: account.accountId,
            group: rule.transfer,
            operation: rule.operation,
            day: order.orderDate,
            amount: order.cash,
            instrumentCode: instrument.code,
            finished: isFinished,
          }
        : null;
    if (!finished) {
      const pending = IN_PROGRESS.has(status) ? candidate(false) : null;
      if (pending) into.candidates.push(pending);
      continue;
    }

    const skip = (reason: MyInvestorSkippedOrder["reason"]) =>
      report({
        reference: order.reference,
        product: account.product,
        sourceType: order.operationType,
        reason,
      });
    if (!rule || !order.operationType) {
      skip("unrecognized_type");
      continue;
    }
    if (!instrument) {
      skip("missing_instrument");
      continue;
    }
    const units = positiveOrNull(order.shares === null ? null : absolute(order.shares));
    if (units === null) {
      skip("no_units");
      continue;
    }

    const external = rule.transfer === "external_in";
    const fact: MyInvestorOperationFact = {
      kind: "operation",
      reference: order.reference,
      product: account.product,
      accountId: account.accountId,
      instrument,
      instrumentName: order.fundName,
      operation: rule.operation,
      executedAt: order.orderDate,
      units,
      // An external entry states `cash: 0` and `amountBuyVL: 0`: no figure, not a free one.
      pricePerUnit: positiveOrNull(order.executionNav),
      amount: positiveOrNull(order.cash),
      fees: "0",
      currency: order.currency,
      sourceType: order.operationType,
      transfer: external
        ? {
            pairing: "external_in",
            transferId: `myinvestor-external:${order.reference}`,
            inheritedCost: "pending",
          }
        : rule.transfer === "internal_transfer"
          ? unpairedLeg(
              { reference: order.reference, operation: rule.operation },
              "no_common_reference",
            )
          : null,
    };
    if (isPairedTransferGroup(rule.transfer)) {
      into.legs.push({ fact, group: rule.transfer });
      const joined = candidate(true);
      if (joined) into.candidates.push(joined);
    }
    into.facts.push(fact);
  }
}

function brokerFact(
  execution: MyInvestorBrokerExecution,
  report: Report,
): MyInvestorOperationFact | null {
  const { detail } = execution;
  if (detail.orderStatus !== FINISHED) return null;
  const skip = (reason: MyInvestorSkippedOrder["reason"]) => {
    report({
      reference: detail.orderReference,
      product: "broker",
      sourceType: detail.side,
      reason,
    });
    return null;
  };

  const operation = detail.side ? MYINVESTOR_BROKER_SIDES[detail.side] : undefined;
  if (!operation) return skip("unrecognized_type");
  if (!detail.instrumentIsin) return skip("missing_instrument");
  const executed = detail.executedShares ?? detail.shares;
  const units = positiveOrNull(executed === null ? null : absolute(executed));
  if (units === null) return skip("no_units");
  const day = detail.executionDate ?? detail.orderDate;
  if (!day) return skip("missing_date");
  if (!isEuroAtParity(detail)) return skip("unsupported_currency");

  return {
    kind: "operation",
    reference: detail.orderReference,
    product: "broker",
    accountId: execution.accountId,
    instrument: { scheme: "isin", code: detail.instrumentIsin },
    instrumentName: detail.instrumentName,
    operation,
    executedAt: day,
    units,
    pricePerUnit: positiveOrNull(detail.priceCurrency),
    amount: positiveOrNull(detail.grossAmountOperationCurrency),
    fees: addUnits(detail.tradeCommissions ?? "0", detail.otherCommissions ?? "0"),
    currency: EURO,
    sourceType: detail.side ?? "",
    transfer: null,
  };
}

/** The dedup key of an operation fact: see the module comment. */
export function operationKey(
  fact: Pick<MyInvestorOperationFact, "product" | "reference">,
) {
  return fact.product === "broker" ? `broker:${fact.reference}` : fact.reference;
}

/**
 * Normalize the orders of one read into operation facts, oldest day first (input
 * order within a day). `report` hears every finished order that produced no fact
 * and why; an order in progress is not reported, it is simply not finished yet.
 */
export function normalizeMyInvestorOrders(
  book: MyInvestorOrderBook,
  report: Report = () => {},
): NormalizedFact<MyInvestorOperationFact>[] {
  const classified: Classified = { facts: [], legs: [], candidates: [] };
  for (const account of book.accounts) classifyAccount(account, report, classified);

  const pairing = pairTransfers(classified.legs, classified.candidates);
  const facts: MyInvestorOperationFact[] = [];
  for (const fact of classified.facts) {
    const decided = pairing.get(fact.reference);
    if (decided?.kind === "wait") continue;
    facts.push(decided ? { ...fact, transfer: decided.transfer } : fact);
  }
  for (const execution of book.broker) {
    const fact = brokerFact(execution, report);
    if (fact) facts.push(fact);
  }

  return facts
    .map((payload) => ({
      key: operationKey(payload),
      dateKey: payload.executedAt,
      payload,
    }))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}

/** The identity of a holding at MyInvestor: its account and its instrument. */
export function holdingKey(accountId: string, instrument: MyInvestorInstrument): string {
  return `${accountId}|${instrument.scheme}:${instrument.code}`;
}

/**
 * The units each holding ends with after folding these operations, by
 * {@link holdingKey}, in exact decimals; a holding folded to zero is kept, at `"0"`.
 *
 * It proves the ADAPTER's reading of the orders (the direction of each type) against
 * the units MyInvestor reports today. It is not the sync's P8 check: that one compares
 * the book's own units, folded by `derivePosition` with its clamps (ADR 0115,
 * decision 3), so it is deliberately not exported from the package.
 */
export function unitsByHolding(
  facts: readonly MyInvestorOperationFact[],
): Map<string, DecimalString> {
  const units = new Map<string, DecimalString>();
  for (const fact of facts) {
    const key = holdingKey(fact.accountId, fact.instrument);
    const held = units.get(key) ?? "0";
    units.set(
      key,
      takesUnitsOut(fact.operation)
        ? subtractUnits(held, fact.units)
        : addUnits(held, fact.units),
    );
  }
  return units;
}
