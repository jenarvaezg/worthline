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
 * EUR. With no rate for its day — or a currency worthline cannot capture — the order
 * is left out and named in `missingRates`, never written at an invented rate; so is
 * an entry whose inherited cost would be folded from such an order.
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
  createFxRateSnapshot,
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

/** The fold of a discovery: its rows, and what it could not write in euros yet. */
export interface MyInvestorFold {
  readonly rows: FoldedRows;
  /**
   * By product key, the earliest day of an operation left out of `rows` because no
   * ECB rate covers it (#1899): the first start blocks the product, the sync waits.
   */
  readonly missingRates: ReadonlyMap<string, string>;
}

/** No rate at all: what a discovery with only euro operations needs. */
export const NO_MYINVESTOR_RATES: FxRateSnapshot = createFxRateSnapshot({});

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
  rates: FxRateSnapshot = NO_MYINVESTOR_RATES,
): MyInvestorFold {
  const facts = discovery.operations;
  const byKey = new Map(facts.map((fact) => [fact.key, fact]));
  const resolved = new Map<string, InvestmentOperation | null>();
  /** The day whose rate is missing, by the key of each fact left out (#1899). */
  const missingOn = new Map<string, string>();
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

  /** The cost of a fold step, or the day whose missing rate stands in its way. */
  type Cost = { readonly minor: number } | { readonly missingOn: string };

  /** The earliest day among the facts left out, or null when none is. */
  const gapOf = (
    pairs: readonly (readonly [NormalizedFact<MyInvestorOperationFact>, unknown])[],
  ): string | null =>
    pairs
      .flatMap(([fact, row]) => (row === null ? [missingOn.get(fact.key)!] : []))
      .sort()
      .at(0) ?? null;

  /**
   * The cost a `transfer_out` takes out of its origin: `costLeavingOrigin`, the one
   * fold the sync, the inherited-cost answer and the traspaso audit use (ADR 0115).
   */
  const costLeaving = (out: NormalizedFact<MyInvestorOperationFact>): Cost => {
    const outRow = resolve(out);
    const origin = rowsByProduct.get(productKeyOf(out.payload)) ?? [];
    // Only the rows BEFORE the leg that leaves are resolved: a later entry into the
    // origin (capital that comes back) has a cost of its own that may depend on this
    // one, and resolving it here would chase its tail. The ledger order needs no cost.
    const before = origin
      .filter((fact) => compareLedgerOrder(fact, out) < 0)
      .map((fact) => [fact, resolve(fact)] as const);
    const gap = gapOf([[out, outRow], ...before]);
    if (gap !== null || outRow === null) return { missingOn: gap! };
    return {
      minor: costLeavingOrigin(
        outRow,
        new Map([[outRow.assetId, before.map(([, row]) => row!)]]),
      ),
    };
  };

  const inheritedCost = (
    fact: NormalizedFact<MyInvestorOperationFact>,
    input: CreateInvestmentOperationInput,
  ): Cost => {
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
      return converted.ok
        ? { minor: converted.value.amountMinor }
        : { missingOn: executedAt.slice(0, 10) };
    }
    return { minor: multiplyToMinor(fact.payload.units, input.pricePerUnit) };
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
    const leftOut = (day: string) => {
      missingOn.set(fact.key, day);
      return null;
    };
    const input = baseInput(fact);
    if (input === null) return leftOut(fact.payload.executedAt.slice(0, 10));
    if (fact.payload.operation !== "transfer_in") return createInvestmentOperation(input);
    const cost = inheritedCost(fact, input);
    if ("missingOn" in cost) return leftOut(cost.missingOn);
    return createInvestmentOperation({ ...input, transferCostMinor: cost.minor });
  }

  const folded = new Map<string, InvestmentOperation[]>();
  const missingRates = new Map<string, string>();
  for (const [key, list] of rowsByProduct) {
    const rows: InvestmentOperation[] = [];
    for (const fact of list) {
      const row = resolve(fact);
      if (row !== null) {
        rows.push(row);
        continue;
      }
      const day = missingOn.get(fact.key)!;
      const earliest = missingRates.get(key);
      if (earliest === undefined || day < earliest) missingRates.set(key, day);
    }
    folded.set(key, rows.sort(compareInvestmentOperations));
  }
  return { missingRates, rows: folded };
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
