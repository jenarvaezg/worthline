/**
 * The operations of a MyInvestor discovery folded ONCE into worthline rows (#1880,
 * PRD #1876 S5): the first start's fold shows them, its batch writes them, and the
 * sync (#1884) writes the window's through the same rows, so no figure is promised
 * that the book will not hold (#1438).
 *
 * The cost (PRD #1876, invariant 3; ADR 0082):
 * - it is worthline's moving average, folded by `derivePosition`; MyInvestor's
 *   «invertido» is never read;
 * - an internal traspaso carries, on its `transfer_in`, exactly the cost its
 *   `transfer_out` takes out of the origin: `costLeavingOrigin` over the origin's
 *   rows before the leg that leaves, the same fold the sync and the inherited-cost
 *   answer use (ADR 0115). The origin is folded from the discovery
 *   whether or not it is included, so the cost travels the same either way;
 * - an entry from another institution (or a leg nobody could pair) has no origin
 *   here: its inherited cost is PENDING (#1882 asks for it). Until then it carries
 *   the amount that arrived, the default of every external entry (no latent gain
 *   invented), valued at the nearest execution NAV of the same product when
 *   MyInvestor states no figure for it. The row carries the `cost_pending` mark,
 *   so the ficha asks for the real cost and never shows this one as a figure;
 * - an outgoing leg nobody could pair is written as the sale it reads as, marked
 *   `unpaired_out`, until the user confirms which entry it funded (#1882, ADR 0115
 *   as amended 2026-11-04): then the two become one traspaso and the cost travels.
 *
 * The currency (#1899, ADR 0072): an order MyInvestor states in another currency (a
 * fund's USD class) is written as every apunte captured outside the euro, through the
 * same door (`convertOperationToBaseCurrency`): in EUR at the ECB rate of its own
 * day, with the original price, fees and rate kept as its `capture`. The holding is
 * EUR. The rates are the ones kept WITH the read (`discovery.fxRates`), so whoever
 * folds the same read converts the same. With no rate for its day — or a currency
 * worthline cannot capture — the order WAITS, never written at an invented rate, and
 * with it whatever its figures would move:
 * - the other half of its traspaso: the book never holds half a pair (#1393);
 * - everything after it in its holding's ledger, so the cost a later traspaso
 *   carries out of that holding is folded on the ledger it will really have.
 */
import type {
  CreateInvestmentOperationInput,
  DecimalString,
  FxRateSnapshot,
  InvestmentOperation,
  NormalizedFact,
} from "@worthline/domain";
import {
  BASE_CURRENCY,
  compareInvestmentOperations,
  convertOperationToBaseCurrency,
  costLeavingOrigin,
  createInvestmentOperation,
  createMoneyConverter,
  divideUnits,
  isCaptureCurrency,
  isPositiveDecimal,
  money,
  multiplyToMinor,
  PRICE_READBACK_DECIMALS,
} from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import { myInvestorHoldingKey } from "@worthline/pricing";
import type { MyInvestorDiscovery } from "./myinvestor-discovery";

/** A product's operations as worthline rows, with every inherited cost resolved. */
export type FoldedRows = ReadonlyMap<string, readonly InvestmentOperation[]>;

/** The fold of a discovery: its rows, and what waits for an ECB rate. */
export interface MyInvestorFold {
  readonly rows: FoldedRows;
  /**
   * The products with an operation left out of `rows` because it waits for an ECB
   * rate (#1899): the first start blocks them, the sync applies them on a later pass.
   */
  readonly missingRates: ReadonlySet<string>;
}

/**
 * The ECB rates kept with a read (#1899), looked up by the EXACT day: each point is
 * already the rate in force on the day of an order (the ECB's carry-forward was
 * applied when it was asked), so a day the read lacks has no rate — never the one of
 * a neighbouring order. EUR is always 1.
 */
export function myInvestorRatesOf(
  discovery: Pick<MyInvestorDiscovery, "fxRates">,
): FxRateSnapshot {
  const byDay = new Map<string, number>();
  for (const [currency, points] of Object.entries(discovery.fxRates ?? {})) {
    for (const point of points) {
      if (Number.isFinite(point.eurPerUnit) && point.eurPerUnit > 0) {
        byDay.set(`${currency}|${point.dateKey}`, point.eurPerUnit);
      }
    }
  }
  return {
    eurPerUnit: (currency, asOf) =>
      currency === BASE_CURRENCY
        ? 1
        : (byDay.get(`${currency}|${asOf.slice(0, 10)}`) ?? null),
  };
}

/** The id an operation of this source gets in the book: stable per fact and per connection. */
export function myInvestorOperationId(sourceId: string, factKey: string): string {
  return `mi_${sourceId}_${factKey}`;
}

export function productKeyOf(fact: MyInvestorOperationFact): string {
  return myInvestorHoldingKey(fact.accountId, fact.instrument);
}

export function toMinor(amount: DecimalString): number {
  return multiplyToMinor(amount, "1");
}

export function pendingInheritedCost(fact: MyInvestorOperationFact): boolean {
  const transfer = fact.transfer;
  if (fact.operation !== "transfer_in" || transfer === null) return false;
  return transfer.pairing === "external_in" || transfer.pairing === "unpaired";
}

/** An outgoing traspaso leg the adapter could not tie to its other half (#1882). */
function unpairedOut(fact: MyInvestorOperationFact): boolean {
  return fact.operation === "transfer_out" && fact.transfer?.pairing === "unpaired";
}

/**
 * The execution NAV of the same instrument closest in time, for an entry that states
 * no figure of its own (an external mobilization arrives with `cash: 0`).
 */
function nearestNav(
  fact: MyInvestorOperationFact,
  all: readonly NormalizedFact<MyInvestorOperationFact>[],
): DecimalString | null {
  let best: { distance: number; nav: DecimalString } | null = null;
  const at = Date.parse(fact.executedAt);
  for (const { payload } of all) {
    if (payload.instrument.code !== fact.instrument.code) continue;
    if (payload.pricePerUnit === null || !isPositiveDecimal(payload.pricePerUnit)) {
      continue;
    }
    const distance = Math.abs(Date.parse(payload.executedAt) - at);
    if (best === null || distance < best.distance) {
      best = { distance, nav: payload.pricePerUnit };
    }
  }
  return best?.nav ?? null;
}

/** The unit price a row states: the cash it moved over its units, as on a buy (#1544). */
function rowPrice(
  fact: MyInvestorOperationFact,
  all: readonly NormalizedFact<MyInvestorOperationFact>[],
): DecimalString {
  if (fact.amount !== null && isPositiveDecimal(fact.amount)) {
    return divideUnits(fact.amount, fact.units, PRICE_READBACK_DECIMALS);
  }
  return fact.pricePerUnit ?? nearestNav(fact, all) ?? "0";
}
/** The ledger's own order (`compareInvestmentOperations`: day, then id), from a fact. */
function compareLedgerOrder(
  left: NormalizedFact<MyInvestorOperationFact>,
  right: NormalizedFact<MyInvestorOperationFact>,
): number {
  const byDay = left.payload.executedAt
    .slice(0, 10)
    .localeCompare(right.payload.executedAt.slice(0, 10));
  return byDay !== 0 ? byDay : left.key.localeCompare(right.key);
}

/**
 * Every operation of the discovery as a worthline row, keyed by product, with the
 * inherited cost of each `transfer_in` resolved. Each cost depends only on rows
 * earlier in its origin's ledger, so the dependencies follow time and a round trip
 * (A → B, later B → A) resolves; a cycle could only come from two legs of one day
 * ordered against each other, and it throws instead of guessing.
 */
export function foldMyInvestorOperations(
  discovery: MyInvestorDiscovery,
  sourceId: string,
): MyInvestorFold {
  const rates = myInvestorRatesOf(discovery);
  const facts = discovery.operations;
  const byKey = new Map(facts.map((fact) => [fact.key, fact]));
  const resolved = new Map<string, InvestmentOperation | null>();
  const resolving = new Set<string>();
  const rowsByProduct = new Map<string, NormalizedFact<MyInvestorOperationFact>[]>();
  for (const fact of facts) {
    const key = productKeyOf(fact.payload);
    const list = rowsByProduct.get(key) ?? [];
    list.push(fact);
    rowsByProduct.set(key, list);
  }

  /** The row's input in euros (ADR 0072), or null when no rate converts it. */
  const baseInput = (
    fact: NormalizedFact<MyInvestorOperationFact>,
  ): CreateInvestmentOperationInput | null => {
    if (!isCaptureCurrency(fact.payload.currency)) return null;
    const converted = convertOperationToBaseCurrency(nativeInput(fact), rates);
    return converted.ok ? converted.value : null;
  };

  /** The row's input as MyInvestor states it, in the order's own currency. */
  const nativeInput = (
    fact: NormalizedFact<MyInvestorOperationFact>,
  ): CreateInvestmentOperationInput => {
    const { payload } = fact;
    const common = {
      assetId: productKeyOf(payload),
      currency: payload.currency,
      executedAt: payload.executedAt,
      id: myInvestorOperationId(sourceId, fact.key),
      pricePerUnit: rowPrice(payload, facts),
      source: "connected" as const,
      units: payload.units,
    };
    // An outgoing leg nothing tied to its entry is, until the user confirms where
    // it went (#1882), what it reads as: a sale. A lone `transfer_out` would take
    // the capital out of the book with neither a destination nor a gain, and the
    // traspaso audit reads it as broken. The mark keeps it findable as a candidate.
    if (unpairedOut(payload)) {
      return { ...common, feesMinor: 0, kind: "sell", transferLegState: "unpaired_out" };
    }
    const transferId = payload.transfer?.transferId;
    return {
      ...common,
      // A traspaso's commission rides its `transfer_in` (ADR 0082); MyInvestor
      // charges none on funds and plans, and the broker only buys and sells.
      feesMinor: payload.operation === "transfer_out" ? 0 : toMinor(payload.fees),
      kind: payload.operation,
      ...(transferId === undefined ? {} : { transferId }),
      // The entry with no origin carries a provisional cost; the mark is what lets
      // the ficha ask for the real one and never show this one as a figure.
      ...(pendingInheritedCost(payload)
        ? { transferLegState: "cost_pending" as const }
        : {}),
    };
  };

  /**
   * The cost a `transfer_out` takes out of its origin: `costLeavingOrigin`, the one
   * fold the sync, the inherited-cost answer and the traspaso audit use (ADR 0115).
   * Null when the way out, or a row before it, waits for its rate.
   */
  const costLeaving = (out: NormalizedFact<MyInvestorOperationFact>): number | null => {
    const outRow = resolve(out);
    const origin = rowsByProduct.get(productKeyOf(out.payload)) ?? [];
    // Only the rows BEFORE the leg that leaves are resolved: a later entry into the
    // origin (capital that comes back) has a cost of its own that may depend on this
    // one, and resolving it here would chase its tail. The ledger order needs no cost.
    const before = origin
      .filter((fact) => compareLedgerOrder(fact, out) < 0)
      .map(resolve);
    if (outRow === null || before.some((row) => row === null)) return null;
    return costLeavingOrigin(
      outRow,
      new Map([[outRow.assetId, before as InvestmentOperation[]]]),
    );
  };

  /** The cost an entry inherits; null when what it depends on waits for a rate. */
  const inheritedCost = (
    fact: NormalizedFact<MyInvestorOperationFact>,
    input: CreateInvestmentOperationInput,
  ): number | null => {
    const transfer = fact.payload.transfer;
    if (transfer?.pairing === "paired") {
      const out = byKey.get(transfer.counterpartKey);
      if (out && out.payload.operation === "transfer_out") return costLeaving(out);
    }
    // No origin in MyInvestor: the amount that arrived, pending until #1882 asks —
    // in euros at the rate of its day, as its price was (ADR 0072).
    const { amount, currency, executedAt } = fact.payload;
    if (amount !== null && isPositiveDecimal(amount)) {
      const converted = createMoneyConverter(rates).convert(
        money(toMinor(amount), currency),
        BASE_CURRENCY,
        executedAt,
      );
      return converted.ok ? converted.value.amountMinor : null;
    }
    return multiplyToMinor(fact.payload.units, input.pricePerUnit);
  };

  function resolve(
    fact: NormalizedFact<MyInvestorOperationFact>,
  ): InvestmentOperation | null {
    const done = resolved.get(fact.key);
    if (done !== undefined) return done;
    if (resolving.has(fact.key)) {
      throw new Error(`MyInvestor traspasos form a cycle at ${fact.key}.`);
    }
    resolving.add(fact.key);
    const row = resolveRow(fact);
    resolving.delete(fact.key);
    resolved.set(fact.key, row);
    return row;
  }

  function resolveRow(
    fact: NormalizedFact<MyInvestorOperationFact>,
  ): InvestmentOperation | null {
    const input = baseInput(fact);
    if (input === null) return null;
    if (fact.payload.operation !== "transfer_in") return createInvestmentOperation(input);
    const cost = inheritedCost(fact, input);
    return cost === null
      ? null
      : createInvestmentOperation({ ...input, transferCostMinor: cost });
  }

  const waiting = waitingForRates(
    facts.filter((fact) => resolve(fact) === null),
    byKey,
    rowsByProduct,
  );
  const folded = new Map<string, InvestmentOperation[]>();
  for (const [key, list] of rowsByProduct) {
    folded.set(
      key,
      list
        .filter((fact) => !waiting.has(fact.key))
        .map((fact) => resolve(fact)!)
        .sort(compareInvestmentOperations),
    );
  }
  const missingRates = new Set(
    facts
      .filter((fact) => waiting.has(fact.key))
      .map((fact) => productKeyOf(fact.payload)),
  );
  return { missingRates, rows: folded };
}

/**
 * The keys of every fact that waits (#1899): those with no rate, the other half of
 * each traspaso one of them is part of (by its `counterpartKey` and by its
 * `transferId`), and everything after one of them in its holding's ledger. Repeated
 * until nothing more joins, since a half that waits can hold back its own holding.
 */
function waitingForRates(
  unconverted: readonly NormalizedFact<MyInvestorOperationFact>[],
  byKey: ReadonlyMap<string, NormalizedFact<MyInvestorOperationFact>>,
  rowsByProduct: ReadonlyMap<string, readonly NormalizedFact<MyInvestorOperationFact>[]>,
): Set<string> {
  const byTransferId = new Map<string, string[]>();
  for (const fact of byKey.values()) {
    const transferId = fact.payload.transfer?.transferId;
    if (transferId === undefined) continue;
    byTransferId.set(transferId, [...(byTransferId.get(transferId) ?? []), fact.key]);
  }
  const waiting = new Set<string>();
  const queue = unconverted.map((fact) => fact.key);
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (waiting.has(key)) continue;
    waiting.add(key);
    const fact = byKey.get(key);
    if (!fact) continue;
    const transfer = fact.payload.transfer;
    if (transfer) {
      queue.push(...(byTransferId.get(transfer.transferId) ?? []));
      if (transfer.pairing === "paired") queue.push(transfer.counterpartKey);
    }
    for (const later of rowsByProduct.get(productKeyOf(fact.payload)) ?? []) {
      if (compareLedgerOrder(later, fact) > 0) queue.push(later.key);
    }
  }
  return waiting;
}

/**
 * A folded row back as the input that writes it, into the holding it belongs to.
 * The periodic sync (#1884) writes through the same mapping.
 */
export function operationInput(
  row: InvestmentOperation,
  assetId: string,
): CreateInvestmentOperationInput {
  return {
    assetId,
    ...(row.capture === undefined ? {} : { capture: row.capture }),
    currency: row.currency,
    executedAt: row.executedAt,
    feesMinor: row.feesMinor,
    id: row.id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    source: "connected",
    ...(row.transferId === undefined ? {} : { transferId: row.transferId }),
    ...(row.transferCostMinor === undefined
      ? {}
      : { transferCostMinor: row.transferCostMinor }),
    ...(row.transferLegState === undefined
      ? {}
      : { transferLegState: row.transferLegState }),
    units: row.units,
  };
}

/**
 * Whether a row is the entry of a paired traspaso whose way out the book already
 * holds as the sale an earlier pass read it as (`unpaired_out`, #1882): that pass
 * saw the money leave and not arrive. `soldOutIds` are the ids of those sales,
 * `outIdOf` gives the id of the way out of a `transferId`.
 */
export function entryOfSoldOrigin(
  row: Pick<CreateInvestmentOperationInput, "kind" | "transferId" | "transferLegState">,
  outIdOf: (transferId: string) => string | undefined,
  soldOutIds: ReadonlySet<string>,
): boolean {
  if (row.kind !== "transfer_in" || row.transferLegState !== undefined) return false;
  if (row.transferId === undefined) return false;
  const outId = outIdOf(row.transferId);
  return outId !== undefined && soldOutIds.has(outId);
}

/**
 * That entry as it is written (ADR 0115 as amended 2026-11-04): with its cost
 * PENDING, valued at what arrived, never as half a traspaso next to a sale that
 * still realizes its gain. The proposal of #1882 offers that sale as its origin,
 * and «Sí, vienen de ahí» turns both into one traspaso, the user saying so.
 */
export function pendingEntryOfSoldOrigin(
  payload: CreateInvestmentOperationInput,
): CreateInvestmentOperationInput {
  return {
    ...payload,
    transferCostMinor: multiplyToMinor(payload.units, payload.pricePerUnit),
    transferLegState: "cost_pending",
  };
}
