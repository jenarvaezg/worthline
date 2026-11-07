/**
 * «Poner al día», pure (#1884, PRD #1876 S9; ADR 0114 decision 5; #1869 P8):
 *
 * 1. {@link refreshMyInvestorDiscovery} — the stored read (#1880) with the window
 *    just read laid over it: today's products, cash and contributions, and the
 *    history with the window's orders replacing the ones it covers. It is kept
 *    after every good pass, so «Incluir con su histórico» never applies a stale read.
 * 2. {@link planMyInvestorSync} — the batch: the window's operations of the LINKED
 *    holdings, from the same fold the first start includes with (`foldMyInvestor
 *    Operations`), so a traspaso's inherited cost travels from its origin's whole
 *    history, not from the 30 days of the window; and today's balance of each
 *    linked cash account.
 *    {@link carryTransferCostsFromBook} then re-takes a new traspaso's inherited
 *    cost from its origin's BOOK: an answer the user gave there (#1882) is the cost
 *    the units carry, not the one the stored read can fold.
 *    An order in another currency is written in euros at the ECB rate the read kept
 *    for its day (#1899, ADR 0072). With no rate it waits — whole, with the other
 *    half of its traspaso — and the rest of the pass goes on. Until it lands it is
 *    planned on every pass, in the window or not, so a gap longer than the window's
 *    overlap can never leave it behind the cursor; the dedup ledger keeps it from
 *    landing twice.
 * 3. {@link checkMyInvestorUnits} — the units check: each linked holding's book
 *    against MyInvestor's units, exact. It reports; it never plans an adjustment
 *    (PRD #1876, invariant 6).
 */
import type {
  CreateInvestmentOperationInput,
  DecimalString,
  InvestmentOperation,
  ManagedPortfolioWitness,
  NormalizedBatch,
  NormalizedFact,
} from "@worthline/domain";
import {
  BASE_CURRENCY,
  compareInvestmentOperations,
  compareUnits,
  costLeavingOrigin,
  createInvestmentOperation,
  multiplyToMinor,
  subtractUnits,
} from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import {
  buildMyInvestorDiscovery,
  type MyInvestorDiscovery,
  type MyInvestorDiscoveryReads,
} from "./myinvestor-discovery";
import {
  entryOfSoldOrigin,
  foldMyInvestorOperations,
  myInvestorHeldBack,
  myInvestorOperationId,
  operationInput,
  pendingEntryOfSoldOrigin,
} from "./myinvestor-operations-fold";

type OperationFact = NormalizedFact<MyInvestorOperationFact>;

/** The order the stored history keeps: day, then key — the ledger's own order. */
function byDayThenKey(left: OperationFact, right: OperationFact): number {
  const byDay = left.payload.executedAt
    .slice(0, 10)
    .localeCompare(right.payload.executedAt.slice(0, 10));
  return byDay !== 0 ? byDay : left.key.localeCompare(right.key);
}

/**
 * Today's read over the stored one. The window replaces what it covers by key; what
 * lies before the window stays as it was read. With no stored read, the window is
 * the history — the caller then reads the whole of it (cursor null).
 *
 * The products are built over the WHOLE merged history, not the window: a product
 * sold before the window has no position and no order in it, and built from the
 * window alone it would drop off the fold — and with it the other half of an old
 * traspaso, which «Incluir» needs to link with its pair (#1393).
 */
export function refreshMyInvestorDiscovery(
  previous: MyInvestorDiscovery | null,
  reads: MyInvestorDiscoveryReads,
): MyInvestorDiscovery {
  const windowKeys = new Set(reads.operations.map((fact) => fact.key));
  const kept = (previous?.operations ?? []).filter((fact) => !windowKeys.has(fact.key));
  return buildMyInvestorDiscovery({
    ...reads,
    operations: [...kept, ...operationFactsOf(reads.operations)].sort(byDayThenKey),
  });
}

/** The operation facts of a read: positions and balances ride other paths. */
function operationFactsOf(
  facts: MyInvestorDiscoveryReads["operations"],
): OperationFact[] {
  return facts.flatMap((fact) =>
    fact.payload.kind === "operation"
      ? [{ dateKey: fact.dateKey, key: fact.key, payload: fact.payload }]
      : [],
  );
}

/** One linked holding of the source: which product it is (#1880). */
export interface MyInvestorLink {
  readonly assetId: string;
  readonly productKey: string;
}

/** What MyInvestor says a linked holding has today: the witness of P8. */
export interface MyInvestorUnitsWitness {
  readonly assetId: string;
  readonly productKey: string;
  readonly units: DecimalString;
}

export interface MyInvestorSyncPlan {
  /** The operations to reconcile; the cursor is where the next pass resumes. */
  readonly facts: NormalizedBatch<CreateInvestmentOperationInput>;
  readonly cashBalances: readonly { assetId: string; valueMinor: number }[];
  readonly witnesses: readonly MyInvestorUnitsWitness[];
  /**
   * The balance a linked robo-advisor's manager declares today (#1883), by a member
   * of its block: the portfolio that member lives in takes it as its witness.
   */
  readonly portfolioWitnesses: readonly {
    readonly assetId: string;
    readonly witness: ManagedPortfolioWitness;
  }[];
}

/**
 * The batch of a pass. `windowKeys` are the keys of the orders this pass read
 * (null for «Resincronizar todo», which read the whole history): only those are
 * planned, so the dedup ledger is asked about a window, never the whole account.
 * The ledger still decides what is new.
 *
 * The exception is what may have waited for an ECB rate (#1899): a row in the fold's
 * closure of the orders in another currency (`myInvestorHeldBack`: the traspasos
 * they are part of, chained, and what follows in each holding) is planned whatever
 * the window while `bookIds` — the ids the linked books already hold — lack it. An
 * account in euros only plans its window, as before.
 */
export function planMyInvestorSync(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    cursor: string;
    links: readonly MyInvestorLink[];
    windowKeys: ReadonlySet<string> | null;
    /** The ids of the operations the linked books hold; none when absent. */
    bookIds?: ReadonlySet<string>;
  },
): MyInvestorSyncPlan {
  const productByKey = new Map(
    discovery.products.map((product) => [product.key, product]),
  );
  const folded = foldMyInvestorOperations(discovery, input.sourceId).rows;
  const factKeyById = new Map(
    discovery.operations.map((fact) => [
      myInvestorOperationId(input.sourceId, fact.key),
      fact.key,
    ]),
  );
  // What may have waited for an ECB rate on an earlier pass: the fold's own closure,
  // seeded with every order in another currency, so a chain of traspasos is
  // replanned as whole as it waited (#1899).
  const mayHaveWaited = myInvestorHeldBack(
    discovery,
    (fact) => fact.payload.currency !== BASE_CURRENCY,
  );
  const bookIds = input.bookIds ?? new Set<string>();
  const planned = (factKey: string, rowId: string) =>
    input.windowKeys === null ||
    input.windowKeys.has(factKey) ||
    (mayHaveWaited.has(factKey) && !bookIds.has(rowId));

  const facts: NormalizedFact<CreateInvestmentOperationInput>[] = [];
  const cashBalances: { assetId: string; valueMinor: number }[] = [];
  const witnesses: MyInvestorUnitsWitness[] = [];

  for (const link of input.links) {
    const product = productByKey.get(link.productKey);
    if (product?.cash) {
      cashBalances.push({
        assetId: link.assetId,
        valueMinor: multiplyToMinor(product.cash.balance, "1"),
      });
      continue;
    }
    // A cash account's key has no `|`: an investment product's always does
    // (`myInvestorHoldingKey`). Anything else linked is not a product with units.
    if (product?.kind === "managed" || (!product && !link.productKey.includes("|"))) {
      continue;
    }
    witnesses.push({
      assetId: link.assetId,
      productKey: link.productKey,
      units: product?.units ?? "0",
    });
    for (const row of folded.get(link.productKey) ?? []) {
      const factKey = factKeyById.get(row.id);
      if (factKey === undefined) continue;
      if (!planned(factKey, row.id)) continue;
      facts.push({
        dateKey: row.executedAt.slice(0, 10),
        key: factKey,
        payload: operationInput(row, link.assetId),
      });
    }
  }

  // Each linked robo-advisor's declared balance, by any linked part of its block.
  const portfolioWitnesses = discovery.products.flatMap((product) => {
    if (product.kind !== "managed" || product.declared === null) return [];
    const member = input.links.find(
      (link) => productByKey.get(link.productKey)?.portfolioKey === product.key,
    );
    if (!member) return [];
    return [
      {
        assetId: member.assetId,
        witness: {
          declaredDate: discovery.readOn,
          declaredValue: {
            amountMinor: multiplyToMinor(product.declared.value, "1"),
            currency: product.declared.currency,
          },
        },
      },
    ];
  });

  return {
    cashBalances,
    facts: { cursor: input.cursor, facts },
    portfolioWitnesses,
    witnesses,
  };
}

/**
 * The inherited cost of each new PAIRED `transfer_in`, re-taken from the book of its
 * origin when the origin is a linked holding (#1882, ADR 0082): its rows already
 * applied — with any cost the user answered there — and the new ones of this batch,
 * folded by `costLeavingOrigin`, the same fold the traspaso audit careos every pair
 * against. The stored read only knows what MyInvestor said, so a cost answered on
 * the origin would otherwise not travel. An entry still pending, or whose origin is
 * not in the book, keeps the cost the fold gave it.
 */
export function carryTransferCostsFromBook(
  batch: readonly NormalizedFact<CreateInvestmentOperationInput>[],
  books: ReadonlyMap<string, readonly InvestmentOperation[]>,
): NormalizedFact<CreateInvestmentOperationInput>[] {
  const facts = pendWhereOriginWasSold(batch, books);
  const ledgers = new Map<string, InvestmentOperation[]>(
    [...books].map(([assetId, rows]) => [assetId, [...rows]]),
  );
  const outs = new Map<string, InvestmentOperation>();
  for (const rows of ledgers.values()) {
    for (const row of rows) {
      if (row.kind === "transfer_out" && row.transferId) outs.set(row.transferId, row);
    }
  }
  for (const { payload } of facts) {
    const ledger = ledgers.get(payload.assetId);
    if (!ledger || ledger.some((row) => row.id === payload.id)) continue;
    const row = createInvestmentOperation(payload);
    ledger.push(row);
    if (row.kind === "transfer_out" && row.transferId) outs.set(row.transferId, row);
  }

  // The entries are corrected in ledger order, and each correction goes back into
  // its holding's ledger before the next is folded: a chain inside the batch (A→B,
  // then B→C) carries the corrected cost to its end, as the audit would fold it.
  const corrected = new Map<string, number>();
  const entries = facts
    .map((fact) => fact.payload)
    .filter(
      (payload) =>
        payload.kind === "transfer_in" &&
        payload.transferId !== undefined &&
        payload.transferLegState === undefined,
    )
    .map((payload) => createInvestmentOperation(payload))
    .sort(compareInvestmentOperations);
  for (const entry of entries) {
    const out = outs.get(entry.transferId!);
    if (!out || !books.has(out.assetId)) continue;
    const cost = costLeavingOrigin(out, ledgers);
    corrected.set(entry.id, cost);
    const ledger = ledgers.get(entry.assetId);
    if (!ledger) continue;
    const at = ledger.findIndex((row) => row.id === entry.id);
    if (at !== -1) ledger[at] = { ...ledger[at]!, transferCostMinor: cost };
  }

  return facts.map((fact) => {
    const cost = corrected.get(fact.payload.id);
    return cost === undefined
      ? fact
      : { ...fact, payload: { ...fact.payload, transferCostMinor: cost } };
  });
}

/**
 * The ids of the sales `unpaired_out` the books hold (#1882): ways out an earlier
 * pass read as sales because it had not seen the money arrive.
 */
export function soldUnpairedOutIds(
  books: ReadonlyMap<string, readonly InvestmentOperation[]>,
): Set<string> {
  return new Set(
    [...books.values()].flatMap((rows) =>
      rows.flatMap((row) =>
        row.kind === "sell" && row.transferLegState === "unpaired_out" ? [row.id] : [],
      ),
    ),
  );
}

/**
 * A new paired `transfer_in` whose `transfer_out` an earlier pass already applied as
 * the sale it read as: the ledger will not write that out again, so the entry goes in
 * with its cost pending (`pendingEntryOfSoldOrigin`), never as half a traspaso.
 * The window that pairs them holds the way out too, so its id comes from the batch.
 */
function pendWhereOriginWasSold(
  facts: readonly NormalizedFact<CreateInvestmentOperationInput>[],
  books: ReadonlyMap<string, readonly InvestmentOperation[]>,
): NormalizedFact<CreateInvestmentOperationInput>[] {
  const outIds = new Map<string, string>();
  for (const { payload } of facts) {
    if (payload.kind === "transfer_out" && payload.transferId) {
      outIds.set(payload.transferId, payload.id);
    }
  }
  const sold = soldUnpairedOutIds(books);
  return facts.map((fact) =>
    entryOfSoldOrigin(fact.payload, (transferId) => outIds.get(transferId), sold)
      ? { ...fact, payload: pendingEntryOfSoldOrigin(fact.payload) }
      : fact,
  );
}

/** A linked holding whose book does not hold what MyInvestor says it holds. */
export interface MyInvestorUnitsMismatch {
  readonly assetId: string;
  readonly productKey: string;
  readonly bookUnits: DecimalString;
  readonly sourceUnits: DecimalString;
  /** MyInvestor's units minus the book's: positive when the book is short. */
  readonly difference: DecimalString;
}

/** The exact units check (P8): every witness against the book, nothing rounded. */
export function checkMyInvestorUnits(
  witnesses: readonly MyInvestorUnitsWitness[],
  bookUnits: ReadonlyMap<string, DecimalString>,
): MyInvestorUnitsMismatch[] {
  const mismatches: MyInvestorUnitsMismatch[] = [];
  for (const witness of witnesses) {
    const book = bookUnits.get(witness.assetId) ?? "0";
    if (compareUnits(book, witness.units) === 0) continue;
    mismatches.push({
      assetId: witness.assetId,
      bookUnits: book,
      difference: subtractUnits(witness.units, book),
      productKey: witness.productKey,
      sourceUnits: witness.units,
    });
  }
  return mismatches;
}
