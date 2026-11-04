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
 * 3. {@link checkMyInvestorUnits} — the units check: each linked holding's book
 *    against MyInvestor's units, exact. It reports; it never plans an adjustment
 *    (PRD #1876, invariant 6).
 */
import type {
  CreateInvestmentOperationInput,
  DecimalString,
  NormalizedBatch,
  NormalizedFact,
} from "@worthline/domain";
import { compareUnits, multiplyToMinor, subtractUnits } from "@worthline/domain";
import type { MyInvestorOperationFact } from "@worthline/pricing";
import {
  buildMyInvestorDiscovery,
  type MyInvestorDiscovery,
  type MyInvestorDiscoveryReads,
} from "./myinvestor-discovery";
import {
  foldMyInvestorOperations,
  myInvestorOperationId,
  operationInput,
} from "./myinvestor-first-start";

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
 */
export function refreshMyInvestorDiscovery(
  previous: MyInvestorDiscovery | null,
  reads: MyInvestorDiscoveryReads,
): MyInvestorDiscovery {
  const today = buildMyInvestorDiscovery(reads);
  const windowKeys = new Set(today.operations.map((fact) => fact.key));
  const kept = (previous?.operations ?? []).filter((fact) => !windowKeys.has(fact.key));
  return {
    ...today,
    operations: [...kept, ...today.operations].sort(byDayThenKey),
  };
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
}

/**
 * The batch of a pass. `windowKeys` are the keys of the orders this pass read
 * (null for «Resincronizar todo», which read the whole history): only those are
 * planned, so the dedup ledger is asked about a window, never the whole account.
 * The ledger still decides what is new.
 */
export function planMyInvestorSync(
  discovery: MyInvestorDiscovery,
  input: {
    sourceId: string;
    cursor: string;
    links: readonly MyInvestorLink[];
    windowKeys: ReadonlySet<string> | null;
  },
): MyInvestorSyncPlan {
  const productByKey = new Map(
    discovery.products.map((product) => [product.key, product]),
  );
  const folded = foldMyInvestorOperations(discovery, input.sourceId);
  const factKeyById = new Map(
    discovery.operations.map((fact) => [
      myInvestorOperationId(input.sourceId, fact.key),
      fact.key,
    ]),
  );

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
      if (input.windowKeys !== null && !input.windowKeys.has(factKey)) continue;
      facts.push({
        dateKey: row.executedAt.slice(0, 10),
        key: factKey,
        payload: operationInput(row, link.assetId),
      });
    }
  }

  return { cashBalances, facts: { cursor: input.cursor, facts }, witnesses };
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
