/**
 * Shared statement-import preview seam (#766): parse uploaded text, resolve
 * portfolio buckets, and build position-impact rows. Used by the manual import
 * page and the assistant's statement-import proposal tool.
 */

import type { WorthlineStore } from "@web/store";
import type {
  Instrument,
  InvestmentOperation,
  InvestmentPriceProvider,
  ParsedStatement,
  ParsedStatementRow,
  StatementImportBucket,
  StatementPortfolioInvestment,
} from "@worthline/domain";
import {
  derivePosition,
  findStatementTypeConflict,
  isIsinShaped,
  isStatementBroker,
  latestOperationPrice,
  multiplyToMinor,
  parseStatement,
  planStatementMerge,
  resolveStatementImportBuckets,
  type StatementBroker,
} from "@worthline/domain";
import { type SymbolCandidate, searchSymbols } from "@worthline/pricing";

/** The result of looking up a creation row's provider symbol by ISIN. */
export type IsinLookupResult =
  | { status: "found"; name: string; symbol: string; provider: InvestmentPriceProvider }
  | { status: "not_found" }
  | { status: "error" };

/** Injected port (tests use a fake — found / not-found / error, never live Yahoo). */
export type IsinSymbolResolver = (
  isin: string,
  instrument?: Instrument,
) => Promise<IsinLookupResult>;

export function isIsinSymbolResolver(value: unknown): value is IsinSymbolResolver {
  return typeof value === "function";
}

function toLookupResult(candidates: SymbolCandidate[]): IsinLookupResult {
  const hit = candidates[0];
  if (!hit) return { status: "not_found" };
  return { name: hit.name, provider: hit.provider, status: "found", symbol: hit.symbol };
}

/** Live ISIN symbol lookup for creation prefills (#593). */
export async function defaultIsinSymbolResolver(
  isin: string,
  instrument?: Instrument,
): Promise<IsinLookupResult> {
  try {
    return toLookupResult(await searchSymbols(isin, instrument ?? "fund"));
  } catch {
    return { status: "error" };
  }
}

/** One fund's preview row — the serializable shape the client table renders. */
export type FundPreviewRow = {
  isin: string;
  executedCount: number;
  skippedCount: number;
  amountMinor: number;
  positionImpact: FundPositionImpact;
} & (
  | {
      bucket: "matched";
      assetId: string;
      existingName: string;
      toCreateCount: number;
      toDeleteCount: number;
      toOverwriteCount: number;
      openingKeptPositionImpact?: FundPositionImpact;
    }
  | {
      bucket: "new";
      lookup: IsinLookupResult;
      suggestedName: string;
      suggestedSymbol: string;
    }
);

export type PositionImpactFlag = "nearly_doubles" | "oversell" | "near_zero";

export interface FundPositionImpact {
  beforeUnits: string;
  beforeValueMinor: number;
  afterUnits: string;
  afterValueMinor: number;
  flags: PositionImpactFlag[];
}

export type StatementTextReadResult =
  | { ok: false; message: string }
  | { ok: true; value: ParsedStatement };

export function typeConflictMessage(identifier: string): string {
  return `El identificador ${identifier} aparece con dos tipos de activo distintos — revisa el archivo. No se ha cargado nada.`;
}

export function readStatementFromText(
  rawText: string,
  broker: StatementBroker,
): StatementTextReadResult {
  const parsed = parseStatement(rawText, broker);
  if (!parsed.ok) {
    return { message: parsed.errors[0], ok: false };
  }

  if (parsed.value.rows.length === 0) {
    return {
      message: "El archivo no contiene movimientos finalizados que cargar.",
      ok: false,
    };
  }

  return { ok: true, value: parsed.value };
}

export function parseStatementBroker(broker: unknown): StatementBroker | null {
  if (typeof broker !== "string") return null;
  const trimmed = broker.trim();
  return isStatementBroker(trimmed) ? trimmed : null;
}

function rowsAmountMinor(rows: readonly ParsedStatementRow[]): number {
  return rows.reduce((sum, row) => {
    const amountMinor = multiplyToMinor(row.units, row.pricePerUnit);
    return row.kind === "sell" ? sum - amountMinor : sum + amountMinor;
  }, 0);
}

function rowToPreviewOperation(
  assetId: string,
  row: ParsedStatementRow,
  id: string,
): InvestmentOperation {
  return {
    assetId,
    currency: row.currency,
    executedAt: row.dateKey,
    feesMinor: row.feesMinor,
    id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    source: "statement",
    units: row.units,
    ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
  };
}

function isNearlyDouble(beforeValueMinor: number, afterValueMinor: number): boolean {
  return (
    beforeValueMinor > 0 &&
    afterValueMinor * 10 >= beforeValueMinor * 19 &&
    afterValueMinor * 10 <= beforeValueMinor * 21
  );
}

function derivePositionImpact(
  bucket: StatementImportBucket,
  existingOperations: readonly InvestmentOperation[],
): FundPositionImpact {
  const assetId = bucket.bucket === "matched" ? bucket.assetId : bucket.isin;
  const currency = existingOperations[0]?.currency ?? bucket.rows[0]?.currency ?? "EUR";
  const beforeOperations = [...existingOperations];
  const afterOperations =
    bucket.bucket === "matched"
      ? [
          ...existingOperations.filter(
            (operation) =>
              !bucket.mergePlan.toDelete.some((deleted) => deleted.id === operation.id) &&
              !bucket.mergePlan.toOverwrite.some(
                (overwrite) => overwrite.operationId === operation.id,
              ),
          ),
          ...bucket.mergePlan.toOverwrite.map((overwrite) =>
            rowToPreviewOperation(assetId, overwrite.row, overwrite.operationId),
          ),
          ...bucket.mergePlan.toCreate.map((row, index) =>
            rowToPreviewOperation(assetId, row, `preview_create_${index}`),
          ),
        ]
      : bucket.rows.map((row, index) =>
          rowToPreviewOperation(assetId, row, `preview_create_${index}`),
        );
  const currentPricePerUnit =
    latestOperationPrice(afterOperations) ?? latestOperationPrice(beforeOperations);
  const options = currentPricePerUnit
    ? { assetId, currency, currentPricePerUnit }
    : { assetId, currency };
  const before = derivePosition(beforeOperations, options);
  const after = derivePosition(afterOperations, options);
  const beforeValueMinor =
    before.marketValue?.amountMinor ?? before.costBasis.amountMinor;
  const afterValueMinor = after.marketValue?.amountMinor ?? after.costBasis.amountMinor;
  const flags: PositionImpactFlag[] = [];

  if (isNearlyDouble(beforeValueMinor, afterValueMinor)) flags.push("nearly_doubles");
  if (after.warnings.length > 0) flags.push("oversell");
  if (beforeValueMinor > 0 && afterValueMinor === 0) flags.push("near_zero");

  return {
    afterUnits: after.currentUnits,
    afterValueMinor,
    beforeUnits: before.currentUnits,
    beforeValueMinor,
    flags,
  };
}

export interface StatementImportPreviewReadPort {
  readInvestmentAssetsWithMeta: () => Promise<
    Array<{ id: string; isin?: string; name: string; providerSymbol?: string }>
  >;
  readOperations: (assetId: string) => Promise<InvestmentOperation[]>;
}

export function statementImportPreviewReadPort(
  store: WorthlineStore,
): StatementImportPreviewReadPort {
  return {
    readInvestmentAssetsWithMeta: () => store.assets.readInvestmentAssetsWithMeta(),
    readOperations: (assetId) => store.operations.readOperations(assetId),
  };
}

export async function readPortfolioInvestments(
  store: StatementImportPreviewReadPort,
): Promise<StatementPortfolioInvestment[]> {
  const metas = await store.readInvestmentAssetsWithMeta();
  return Promise.all(
    metas
      .filter((meta) => meta.isin || meta.providerSymbol)
      .map(async (meta) => ({
        assetId: meta.id,
        isin: meta.isin ?? null,
        name: meta.name,
        operations: await store.readOperations(meta.id),
        providerSymbol: meta.providerSymbol ?? null,
      })),
  );
}

async function bucketToPreviewRow(
  bucket: StatementImportBucket,
  resolver: IsinSymbolResolver,
  existingOperations: readonly InvestmentOperation[] = [],
): Promise<FundPreviewRow> {
  const amountMinor = rowsAmountMinor(bucket.rows);
  const positionImpact = derivePositionImpact(bucket, existingOperations);

  if (bucket.bucket === "matched") {
    const openingKeptPositionImpact =
      bucket.mergePlan.toDelete.length > 0
        ? derivePositionImpact(
            {
              ...bucket,
              mergePlan: planStatementMerge(bucket.rows, [...existingOperations], {
                replaceOpening: false,
              }),
            },
            existingOperations,
          )
        : undefined;

    return {
      amountMinor,
      assetId: bucket.assetId,
      bucket: "matched",
      executedCount: bucket.rows.length,
      existingName: bucket.name,
      isin: bucket.isin,
      ...(openingKeptPositionImpact ? { openingKeptPositionImpact } : {}),
      positionImpact,
      skippedCount: bucket.skipped.length,
      toCreateCount: bucket.mergePlan.toCreate.length,
      toDeleteCount: bucket.mergePlan.toDelete.length,
      toOverwriteCount: bucket.mergePlan.toOverwrite.length,
    };
  }

  const lookup = await resolver(bucket.isin, bucket.instrument);
  return {
    amountMinor,
    bucket: "new",
    executedCount: bucket.rows.length,
    isin: bucket.isin,
    lookup,
    positionImpact,
    skippedCount: bucket.skipped.length,
    suggestedName: lookup.status === "found" ? lookup.name : (bucket.name ?? ""),
    suggestedSymbol:
      lookup.status === "found"
        ? lookup.symbol
        : isIsinShaped(bucket.isin)
          ? ""
          : bucket.isin,
  };
}

export interface BuildStatementImportPreviewOptions {
  replaceOpening?: (isin: string) => boolean;
}

export async function buildStatementImportPreview(
  store: StatementImportPreviewReadPort,
  statement: ParsedStatement,
  resolver: IsinSymbolResolver,
  options: BuildStatementImportPreviewOptions = {},
): Promise<
  | { ok: false; message: string }
  | { ok: true; buckets: StatementImportBucket[]; funds: FundPreviewRow[] }
> {
  const investments = await readPortfolioInvestments(store);
  const buckets = resolveStatementImportBuckets(
    statement,
    investments,
    options.replaceOpening
      ? { replaceOpening: (group) => options.replaceOpening!(group.isin) }
      : {},
  );
  const operationsByAssetId = new Map(
    investments.map((investment) => [investment.assetId, investment.operations]),
  );

  const conflict = findStatementTypeConflict(buckets);
  if (conflict) {
    return { message: typeConflictMessage(conflict), ok: false };
  }

  const funds = await Promise.all(
    buckets.map((bucket) =>
      bucketToPreviewRow(
        bucket,
        resolver,
        bucket.bucket === "matched"
          ? (operationsByAssetId.get(bucket.assetId) ?? [])
          : [],
      ),
    ),
  );

  return { buckets, funds, ok: true };
}
