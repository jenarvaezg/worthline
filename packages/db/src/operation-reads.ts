/**
 * Shared operation-domain reads — investment operations, their captured-apunte
 * columns, the investment metadata map, and the usable price cache. Split out of
 * `store-context.ts` (#1701): that module owns only the connection/transaction/
 * audit substrate, and a reader keyed on `InvestmentOperation` belongs in a file
 * that says so, not in the one every slice imports for its `db` handle.
 */
import type {
  CostBasisGrade,
  DateKey,
  DecimalString,
  InvestmentOperation,
  OperationCapture,
} from "@worthline/domain";
import { asDateKey, usableCachedPrice } from "@worthline/domain";
import { asc } from "drizzle-orm";

import { assetOperations, assetPriceCache, investmentAssets } from "./schema";
import type { StoreDb } from "./store-context";

export interface InvestmentMeta {
  manualPricePerUnit?: DecimalString;
  /** The provider-symbol lookup key (ADR 0055), for the warnings projection. */
  providerSymbol?: string;
  /** The ISIN (ADR 0055), for the missing-identity signal (#1489). */
  isin?: string;
}

/**
 * The captured apunte carried by a row, or undefined (#1401). All four columns are
 * written together, so ONE missing piece means the row cannot describe a conversion
 * and the capture is reported as absent rather than half-built — a partially filled
 * capture would claim an audit trail it does not have. A pre-#1401 row has all four
 * NULL, which reads as the euro operation it was recorded as.
 */
function toOperationCapture(
  row: typeof assetOperations.$inferSelect,
): OperationCapture | undefined {
  const eurPerUnit = Number(row.captureEurPerUnit);

  if (
    row.captureCurrency === null ||
    row.capturePricePerUnit === null ||
    row.captureFeesMinor === null ||
    row.captureEurPerUnit === null ||
    // A rate has to be a positive number: `Number("")` is a finite 0, and a zero rate
    // would read as "one dollar is worth nothing".
    !Number.isFinite(eurPerUnit) ||
    eurPerUnit <= 0
  ) {
    return undefined;
  }

  return {
    currency: row.captureCurrency,
    eurPerUnit,
    feesMinor: row.captureFeesMinor,
    pricePerUnit: row.capturePricePerUnit,
  };
}

/**
 * The four capture columns for a write, or four NULLs (#1401). A set of four or
 * nothing: a half-written capture would claim an audit trail it cannot back. Shared
 * by the single-operation insert and the whole-document import so an export →
 * import round-trip cannot quietly drop the original apunte.
 *
 * The rate goes in as its own decimal string, which round-trips the double exactly.
 */
export function operationCaptureColumns(capture: OperationCapture | undefined): {
  captureCurrency: string | null;
  captureEurPerUnit: string | null;
  captureFeesMinor: number | null;
  capturePricePerUnit: string | null;
} {
  return {
    captureCurrency: capture?.currency ?? null,
    captureEurPerUnit: capture === undefined ? null : String(capture.eurPerUnit),
    captureFeesMinor: capture?.feesMinor ?? null,
    capturePricePerUnit: capture?.pricePerUnit ?? null,
  };
}

/**
 * The three traspaso columns for a write (#1393, #1518), or three NULLs. All
 * independent of each other, unlike the capture set: `transfer_id` rides both
 * halves of the pair, `transfer_cost_minor` only the incoming one, and
 * `transfer_seniority_at` only an EXTERNAL incoming one whose owner declared it. So
 * "id without cost" is the normal shape of a `transfer_out`, and "cost without
 * seniority" the normal shape of every traspaso written before #1518 — neither is a
 * half-written record.
 */
export function operationTransferColumns(operation: {
  transferId?: string;
  transferCostMinor?: number;
  transferSeniorityAt?: string;
}): {
  transferId: string | null;
  transferCostMinor: number | null;
  transferSeniorityAt: DateKey | null;
} {
  return {
    transferCostMinor: operation.transferCostMinor ?? null,
    transferId: operation.transferId ?? null,
    transferSeniorityAt:
      operation.transferSeniorityAt === undefined
        ? null
        : asDateKey(operation.transferSeniorityAt),
  };
}

/**
 * The cost-grade column for a write (#1505), or NULL. Its own helper next to the
 * capture and traspaso ones so every insert path — the single operation, the whole
 * imported document — goes through the same line: an export → import round-trip that
 * dropped this would silently re-affirm a plusvalía nobody declared.
 */
export function operationCostBasisColumns(operation: {
  costBasisGrade?: CostBasisGrade;
}): { costBasisGrade: CostBasisGrade | null } {
  return { costBasisGrade: operation.costBasisGrade ?? null };
}

export function toOperation(
  row: typeof assetOperations.$inferSelect,
): InvestmentOperation {
  const capture = toOperationCapture(row);

  return {
    assetId: row.assetId,
    ...(capture === undefined ? {} : { capture }),
    ...(row.costBasisGrade === null ? {} : { costBasisGrade: row.costBasisGrade }),
    currency: row.currency,
    executedAt: row.executedAt,
    feesMinor: row.feesMinor,
    id: row.id,
    kind: row.kind,
    ...(row.occurredAt === null ? {} : { occurredAt: row.occurredAt }),
    pricePerUnit: row.pricePerUnit,
    source: row.source,
    ...(row.transferCostMinor === null
      ? {}
      : { transferCostMinor: row.transferCostMinor }),
    ...(row.transferId === null ? {} : { transferId: row.transferId }),
    ...(row.transferSeniorityAt === null
      ? {}
      : { transferSeniorityAt: row.transferSeniorityAt }),
    units: row.units,
  };
}

export async function readAllOperations(
  db: StoreDb,
): Promise<Map<string, InvestmentOperation[]>> {
  const rows = await db
    .select()
    .from(assetOperations)
    .orderBy(
      asc(assetOperations.executedAt),
      asc(assetOperations.occurredAt),
      asc(assetOperations.id),
    )
    .all();

  return rows.reduce((byAsset, row) => {
    const operation = toOperation(row);
    const existing = byAsset.get(row.assetId);

    if (existing) {
      existing.push(operation);
    } else {
      byAsset.set(row.assetId, [operation]);
    }

    return byAsset;
  }, new Map<string, InvestmentOperation[]>());
}

export async function readInvestmentMeta(
  db: StoreDb,
): Promise<Map<string, InvestmentMeta>> {
  const rows = await db
    .select({
      assetId: investmentAssets.assetId,
      isin: investmentAssets.isin,
      manualPricePerUnit: investmentAssets.manualPricePerUnit,
      providerSymbol: investmentAssets.providerSymbol,
    })
    .from(investmentAssets)
    .all();

  return rows.reduce((byAsset, row) => {
    byAsset.set(row.assetId, {
      ...(row.manualPricePerUnit ? { manualPricePerUnit: row.manualPricePerUnit } : {}),
      ...(row.providerSymbol ? { providerSymbol: row.providerSymbol } : {}),
      ...(row.isin ? { isin: row.isin } : {}),
    });

    return byAsset;
  }, new Map<string, InvestmentMeta>());
}

/**
 * Cached prices usable for VALUATION, keyed by asset id.
 *
 * Rows that only record a failure are left out — `usableCachedPrice` owns that
 * rule — so the valuation falls back to cost basis instead of multiplying units
 * by the marker zero (#1330). The rows themselves stay in the table: the
 * freshness and salud de datos surfaces read them through
 * `readAllPriceCacheEntries` and need both the state and its `stale_reason`.
 */
export async function readAllPriceCache(
  db: StoreDb,
): Promise<Map<string, { price: string }>> {
  const rows = await db.select().from(assetPriceCache).all();

  return rows.reduce((map, row) => {
    const price = usableCachedPrice(row);
    if (price !== null) map.set(row.assetId, { price });
    return map;
  }, new Map<string, { price: string }>());
}
