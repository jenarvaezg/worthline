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
  MatchedStatementFund,
  ParsedStatement,
  ParsedStatementRow,
  StatementFundClaimant,
  StatementImportBucket,
  StatementMergePlan,
  StatementPortfolioInvestment,
} from "@worthline/domain";
import {
  derivePosition,
  findStatementTypeConflict,
  hasOversellPositionWarning,
  isIsinShaped,
  isProviderSymbolShaped,
  isStatementBroker,
  latestOperationPrice,
  multiplyToMinor,
  parseStatement,
  planStatementMerge,
  resolveStatementImportBuckets,
  type StatementBroker,
  type StoredSecurityId,
  storedIsinOrNull,
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

/**
 * One investment the identifier could belong to, with the merge **that**
 * investment would receive (#1366). Every figure the row shows — counts, position
 * impact, the opening-kept variant — is per claimant, because the merge deletes
 * and overwrites against one ledger: rendering the default's numbers next to
 * another holding's name would be a lie the user confirms.
 */
export interface FundMatchChoice {
  assetId: string;
  existingName: string;
  /** Fully sold today — shown so the user can tell the two brokers' copies apart. */
  closed: boolean;
  toCreateCount: number;
  toDeleteCount: number;
  toOverwriteCount: number;
  positionImpact: FundPositionImpact;
  openingKeptPositionImpact?: FundPositionImpact;
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
      /**
       * More than one investment claims the identifier: the row carries no
       * verdict, only {@link choices}. The flat fields above mirror `choices[0]`
       * — the best-ranked DEFAULT — so a resolved row reads exactly as before.
       */
      ambiguous: boolean;
      choices: FundMatchChoice[];
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

/**
 * The identifier belongs to more than one of your investments and the confirm did
 * not name which (#1366) — either it was never chosen, or the portfolio changed
 * under the preview. Nothing is written: the file cannot pick a holding whose
 * operations it may overwrite.
 */
export function unresolvedChoiceMessage(identifier: string): string {
  return `El identificador ${identifier} está en más de una de tus inversiones — vuelve a subir el archivo y elige a cuál pertenece. No se ha cargado nada.`;
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

/** What a group's rows do to one ledger — one claimant's, or a creation's. */
interface PositionImpactInput {
  assetId: string;
  rows: readonly ParsedStatementRow[];
  /** Absent for a creation: every row is simply added. */
  mergePlan?: StatementMergePlan;
}

function derivePositionImpact(
  { assetId, rows, mergePlan }: PositionImpactInput,
  existingOperations: readonly InvestmentOperation[],
): FundPositionImpact {
  const currency = existingOperations[0]?.currency ?? rows[0]?.currency ?? "EUR";
  const beforeOperations = [...existingOperations];
  const afterOperations = mergePlan
    ? [
        ...existingOperations.filter(
          (operation) =>
            !mergePlan.toDelete.some((deleted) => deleted.id === operation.id) &&
            !mergePlan.toOverwrite.some(
              (overwrite) => overwrite.operationId === operation.id,
            ),
        ),
        ...mergePlan.toOverwrite.map((overwrite) =>
          rowToPreviewOperation(assetId, overwrite.row, overwrite.operationId),
        ),
        ...mergePlan.toCreate.map((row, index) =>
          rowToPreviewOperation(assetId, row, `preview_create_${index}`),
        ),
      ]
    : rows.map((row, index) =>
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
  if (hasOversellPositionWarning(after.warnings)) flags.push("oversell");
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
    Array<{
      id: string;
      /** El par tipado (#1743); el extracto enruta por ISIN hasta #1748. */
      securityId?: StoredSecurityId;
      name: string;
      providerSymbol?: string;
    }>
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
      .filter((meta) => storedIsinOrNull(meta.securityId) || meta.providerSymbol)
      .map(async (meta) => ({
        assetId: meta.id,
        isin: storedIsinOrNull(meta.securityId),
        name: meta.name,
        operations: await store.readOperations(meta.id),
        providerSymbol: meta.providerSymbol ?? null,
      })),
  );
}

function claimantToChoice(
  bucket: MatchedStatementFund,
  claimant: StatementFundClaimant,
  existingOperations: readonly InvestmentOperation[],
): FundMatchChoice {
  const impactOf = (mergePlan: StatementMergePlan) =>
    derivePositionImpact(
      { assetId: claimant.assetId, mergePlan, rows: bucket.rows },
      existingOperations,
    );
  const openingKeptPositionImpact =
    claimant.mergePlan.toDelete.length > 0
      ? impactOf(
          planStatementMerge(bucket.rows, [...existingOperations], {
            replaceOpening: false,
          }),
        )
      : undefined;

  return {
    assetId: claimant.assetId,
    closed: claimant.closed,
    existingName: claimant.name,
    ...(openingKeptPositionImpact ? { openingKeptPositionImpact } : {}),
    positionImpact: impactOf(claimant.mergePlan),
    toCreateCount: claimant.mergePlan.toCreate.length,
    toDeleteCount: claimant.mergePlan.toDelete.length,
    toOverwriteCount: claimant.mergePlan.toOverwrite.length,
  };
}

async function bucketToPreviewRow(
  bucket: StatementImportBucket,
  resolver: IsinSymbolResolver,
  operationsByAssetId: ReadonlyMap<string, InvestmentOperation[]>,
): Promise<FundPreviewRow> {
  const amountMinor = rowsAmountMinor(bucket.rows);

  if (bucket.bucket === "matched") {
    const choices = bucket.claimants.map((claimant) =>
      claimantToChoice(bucket, claimant, operationsByAssetId.get(claimant.assetId) ?? []),
    );
    const best = choices[0]!;

    return {
      amountMinor,
      ambiguous: bucket.ambiguous === true,
      assetId: best.assetId,
      bucket: "matched",
      choices,
      executedCount: bucket.rows.length,
      existingName: best.existingName,
      isin: bucket.isin,
      ...(best.openingKeptPositionImpact
        ? { openingKeptPositionImpact: best.openingKeptPositionImpact }
        : {}),
      positionImpact: best.positionImpact,
      skippedCount: bucket.skipped.length,
      toCreateCount: best.toCreateCount,
      toDeleteCount: best.toDeleteCount,
      toOverwriteCount: best.toOverwriteCount,
    };
  }

  const lookup = await resolver(bucket.isin, bucket.instrument);
  return {
    amountMinor,
    bucket: "new",
    executedCount: bucket.rows.length,
    isin: bucket.isin,
    lookup,
    positionImpact: derivePositionImpact({ assetId: bucket.isin, rows: bucket.rows }, []),
    skippedCount: bucket.skipped.length,
    suggestedName: lookup.status === "found" ? lookup.name : (bucket.name ?? ""),
    suggestedSymbol:
      lookup.status === "found" ? lookup.symbol : identifierAsSymbol(bucket.isin),
  };
}

/**
 * The identifier itself as a provider-symbol suggestion, when the lookup found
 * nothing. An ISIN is not a symbol (no provider quotes by ISIN), and neither is
 * a fund NAME — the identifier a statement without ISINs groups by. Stamping a
 * name as the symbol condemned the holding to a daily impossible lookup that
 * kept rewriting a `failed` price row (#1330); no symbol values it at cost.
 */
function identifierAsSymbol(identifier: string): string {
  if (isIsinShaped(identifier)) return "";
  return isProviderSymbolShaped(identifier) ? identifier : "";
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
    buckets.map((bucket) => bucketToPreviewRow(bucket, resolver, operationsByAssetId)),
  );

  return { buckets, funds, ok: true };
}
