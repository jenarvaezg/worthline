"use server";

/**
 * Portfolio-level statement import — "Importar extracto" (PRD #669 S2, #673,
 * ADR 0055). Upload → three-bucket preview (matched / new / ignored, per-fund
 * counts) → confirm applies the included selection all-or-nothing through the
 * S1 domain engine (`packages/domain/src/statement-import-plan.ts`) and the
 * `applyStatementImportAndRipple` seam.
 *
 * Mirrors the per-holding statement upload (#176, `inversiones/actions.ts`):
 * preview and confirm both re-read the uploaded file from FormData (the file
 * input stays mounted client-side across both submits — never trust the
 * preview); confirm re-derives the buckets from the store instead of the
 * client-reported ones.
 *
 * New-fund creation rows are prefilled by a live ISIN symbol lookup, injected
 * as a port (`IsinSymbolResolver`) so tests use a fake — found / not-found /
 * error — and never hit live Yahoo (mirrors the wizard's `searchSymbols`,
 * #593).
 */

import { type WorthlineStore } from "@web/store";
import { runActionWithStore } from "@web/action-store";
import {
  buildStatementImportPlan,
  defaultsFor,
  findStatementTypeConflict,
  isIsinShaped,
  isStatementBroker,
  latestOperationPrice,
  parseStatement,
  resolveStatementImportBuckets,
  systemClock,
  multiplyToMinor,
  derivePosition,
} from "@worthline/domain";
import type {
  Clock,
  Instrument,
  InvestmentPriceProvider,
  InvestmentOperation,
  OwnershipShare,
  ParsedStatement,
  ParsedStatementRow,
  StatementFundSelection,
  StatementImportBucket,
  StatementPortfolioInvestment,
} from "@worthline/domain";
import { searchSymbols, type SymbolCandidate } from "@worthline/pricing";
import { redirect } from "next/navigation";

import {
  createStableId,
  errorRedirectUrl,
  resolveOwnershipSplit,
  successRedirectUrl,
} from "@web/intake";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  isSpreadsheet,
  SpreadsheetReadError,
  spreadsheetToDelimitedText,
} from "./spreadsheet-text";

function currentUrlOf(formData: FormData): string {
  return (formData.get("currentUrl") as string) || "/patrimonio/importar-extracto";
}

const DIRECTION_AMBIGUITY_ACK_FIELD = "confirmNoSalesOrRedemptions";
const DIRECTION_AMBIGUITY_MESSAGE =
  "Este archivo no distingue compras de ventas. Exporta el archivo COMPLETO de órdenes (con la columna «Tipo de operación»).";

// ── ISIN symbol lookup port ──────────────────────────────────────────────────

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

function toLookupResult(candidates: SymbolCandidate[]): IsinLookupResult {
  const hit = candidates[0];
  if (!hit) return { status: "not_found" };
  return { name: hit.name, provider: hit.provider, status: "found", symbol: hit.symbol };
}

/**
 * The real resolver: the wizard's group-scoped search (#593), keyed on the
 * identifier and routed by the bucket's instrument — Yahoo for listed
 * instruments (the historical default), Finect for plans, CoinGecko for crypto.
 */
async function defaultIsinSymbolResolver(
  isin: string,
  instrument?: Instrument,
): Promise<IsinLookupResult> {
  try {
    return toLookupResult(await searchSymbols(isin, instrument ?? "fund"));
  } catch {
    return { status: "error" };
  }
}

// ── Preview ───────────────────────────────────────────────────────────────

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
      toOverwriteCount: number;
    }
  | {
      bucket: "new";
      lookup: IsinLookupResult;
      /**
       * Creation prefills (#695): the lookup wins; a plantilla row's own Nombre
       * backs the name up, and a non-ISIN identifier (Finect code, CoinGecko
       * id) IS the provider symbol, so it self-suggests.
       */
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

export type ImportStatementPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      funds: FundPreviewRow[];
      /**
       * False when the file shape can't distinguish buys from sells (MyInvestor's
       * reduced export) — the preview warns so sells aren't confirmed as buys.
       */
      directionResolved: boolean;
    };

async function readStatementFromForm(
  formData: FormData,
): Promise<{ ok: false; message: string } | { ok: true; value: ParsedStatement }> {
  const broker = String(formData.get("broker") ?? "").trim();
  if (!isStatementBroker(broker)) {
    return {
      message: "Selecciona un formato compatible (MyInvestor o la plantilla).",
      ok: false,
    };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      message: "Selecciona un archivo .csv o .xlsx con movimientos.",
      ok: false,
    };
  }

  // An .xlsx travels as bytes; its first sheet normalizes to the same
  // `;`-delimited text a CSV upload carries, so every validation and Spanish
  // error lives in the one parser (#695).
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = isSpreadsheet(bytes)
      ? spreadsheetToDelimitedText(bytes)
      : new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof SpreadsheetReadError) {
      return { message: error.message, ok: false };
    }
    throw error;
  }

  const parsed = parseStatement(text, broker);
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

/** Sum a fund group's executed rows into a minor-unit amount (units × price). */
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
    units: row.units,
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

/**
 * Read every current investment with a matching key — ISIN or provider symbol
 * (how the plantilla identifies plans and crypto, #695) — plus its operations,
 * for bucket resolution.
 */
async function readPortfolioInvestments(
  store: WorthlineStore,
): Promise<StatementPortfolioInvestment[]> {
  const metas = await store.assets.readInvestmentAssetsWithMeta();
  return Promise.all(
    metas
      .filter((meta) => meta.isin || meta.providerSymbol)
      .map(async (meta) => ({
        assetId: meta.id,
        isin: meta.isin ?? null,
        name: meta.name,
        operations: await store.operations.readOperations(meta.id),
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
    return {
      amountMinor,
      assetId: bucket.assetId,
      bucket: "matched",
      executedCount: bucket.rows.length,
      existingName: bucket.name,
      isin: bucket.isin,
      positionImpact,
      skippedCount: bucket.skipped.length,
      toCreateCount: bucket.mergePlan.toCreate.length,
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
    // A non-ISIN identifier (Finect code, CoinGecko id) IS the provider symbol.
    suggestedSymbol:
      lookup.status === "found"
        ? lookup.symbol
        : isIsinShaped(bucket.isin)
          ? ""
          : bucket.isin,
  };
}

/**
 * Preview (ADR 0055): parse the uploaded file, group by ISIN, resolve
 * matched/new buckets against the current portfolio, and prefill each new
 * fund's name/symbol via the injected resolver — WITHOUT writing anything.
 */
export async function previewImportStatementAction(
  _prev: ImportStatementPreviewState,
  formData: FormData,
  _store?: WorthlineStore,
  _resolver: IsinSymbolResolver = defaultIsinSymbolResolver,
): Promise<ImportStatementPreviewState> {
  await guardDemoWrite(currentUrlOf(formData));
  const read = await readStatementFromForm(formData);
  if (!read.ok) {
    return { message: read.message, status: "error" };
  }

  return runActionWithStore(async (store) => {
    const investments = await readPortfolioInvestments(store);
    const buckets = resolveStatementImportBuckets(read.value, investments);
    const operationsByAssetId = new Map(
      investments.map((investment) => [investment.assetId, investment.operations]),
    );

    const conflict = findStatementTypeConflict(buckets);
    if (conflict) {
      return { message: typeConflictMessage(conflict), status: "error" };
    }

    const funds = await Promise.all(
      buckets.map((bucket) =>
        bucketToPreviewRow(
          bucket,
          _resolver,
          bucket.bucket === "matched"
            ? (operationsByAssetId.get(bucket.assetId) ?? [])
            : [],
        ),
      ),
    );

    return { directionResolved: read.value.directionResolved, funds, status: "ready" };
  }, _store);
}

/** One identifier = one asset type; a mixed declaration aborts before any write. */
function typeConflictMessage(identifier: string): string {
  return `El identificador ${identifier} aparece con dos tipos de activo distintos — revisa el archivo. No se ha cargado nada.`;
}

// ── Confirm ───────────────────────────────────────────────────────────────

function isinFormKey(prefix: string, isin: string): string {
  return `${prefix}_${isin}`;
}

/** Build the confirmed per-ISIN selection from the posted checkboxes/fields. */
function selectionsFromForm(
  buckets: StatementImportBucket[],
  formData: FormData,
  ownership: OwnershipShare[],
  seed: number,
): StatementFundSelection[] {
  return buckets.map((bucket, index) => {
    const included = formData.get(isinFormKey("include", bucket.isin)) === "on";

    if (!included || bucket.bucket === "matched") {
      return included
        ? ({ action: "include", isin: bucket.isin } as const)
        : ({ action: "ignore", isin: bucket.isin } as const);
    }

    // The instrument comes from the re-derived bucket (the file's own rows),
    // never from the client (#695); MyInvestor rows carry none → fund, the
    // historical default. Its catalog defaults pick the provider and rung.
    const instrument = bucket.instrument ?? "fund";
    const defaults = defaultsFor(instrument);

    const name =
      String(formData.get(isinFormKey("name", bucket.isin)) ?? "").trim() || bucket.isin;
    const symbol = String(formData.get(isinFormKey("symbol", bucket.isin)) ?? "").trim();

    return {
      action: "include",
      creation: {
        assetId: createStableId("asset", name, seed + index),
        currency: "EUR",
        instrument,
        liquidityTier: defaults.rung,
        name,
        ownership,
        ...(symbol
          ? {
              priceProvider: defaults.priceProvider as InvestmentPriceProvider,
              providerSymbol: symbol,
            }
          : {}),
      },
      isin: bucket.isin,
    } as const;
  });
}

function rowToCreateInput(assetId: string, row: ParsedStatementRow, id: string) {
  return {
    assetId,
    currency: row.currency,
    executedAt: row.dateKey,
    feesMinor: row.feesMinor,
    id,
    kind: row.kind,
    pricePerUnit: row.pricePerUnit,
    units: row.units,
  };
}

/**
 * Confirm (ADR 0055): re-parse the file (never trusting the preview), re-derive
 * the buckets from the store's current investments, build the confirmed
 * selection from the posted checkboxes + hand-edited name/symbol fields, and
 * apply the whole selection atomically via `applyStatementImportAndRipple` —
 * all-or-nothing: an excluded fund is never touched.
 */
export async function confirmImportStatementAction(
  formData: FormData,
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
): Promise<never> {
  await guardDemoWrite(currentUrlOf(formData));
  const returnUrl = currentUrlOf(formData);
  const errorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, { formId: "statement", message });

  const read = await readStatementFromForm(formData);
  if (!read.ok) {
    redirect(errorUrl(read.message));
  }
  if (
    !read.value.directionResolved &&
    formData.get(DIRECTION_AMBIGUITY_ACK_FIELD) !== "on"
  ) {
    redirect(errorUrl(DIRECTION_AMBIGUITY_MESSAGE));
  }

  const today = _clock.today();
  const seed = Date.now();

  const outcome = await runActionWithStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) {
      return { error: "Workspace no inicializado." } as const;
    }

    const investments = await readPortfolioInvestments(store);
    const buckets = resolveStatementImportBuckets(read.value, investments);

    const conflict = findStatementTypeConflict(buckets);
    if (conflict) {
      return { error: typeConflictMessage(conflict) } as const;
    }

    const activeMembers = workspace.members.filter((member) => !member.disabledAt);
    // Wizard ownership default (#593): 100% to the connecting scope member —
    // here, absent an explicit scope, the workspace's first active member.
    const ownership = resolveOwnershipSplit({
      activeMembers,
      preset: "scope",
      shortfall: "complete-to-full-ownership",
    });

    const selections = selectionsFromForm(buckets, formData, ownership, seed);
    const plan = buildStatementImportPlan(buckets, selections);

    const funds = plan.included.map((fund, index) => {
      const opSeed = `${seed}_${index}`;

      if (fund.kind === "matched") {
        return {
          assetId: fund.assetId,
          creates: fund.mergePlan.toCreate.map((row, j) =>
            rowToCreateInput(
              fund.assetId,
              row,
              createStableId(
                "op",
                `${fund.assetId}_${row.dateKey}`,
                seed + index * 1000 + j,
              ),
            ),
          ),
          kind: "matched" as const,
          overwrites: fund.mergePlan.toOverwrite.map(({ operationId, row }) => ({
            currency: row.currency,
            feesMinor: row.feesMinor,
            id: operationId,
            kind: row.kind,
            pricePerUnit: row.pricePerUnit,
            units: row.units,
          })),
        };
      }

      return {
        asset: {
          currency: fund.creation.currency,
          id: fund.creation.assetId,
          // A plantilla identifier without ISIN shape (Finect code, CoinGecko
          // id) lives in providerSymbol, never in the isin column (#695).
          ...(isIsinShaped(fund.isin) ? { isin: fund.isin } : {}),
          name: fund.creation.name,
          ownership: fund.creation.ownership,
          ...(fund.creation.instrument ? { instrument: fund.creation.instrument } : {}),
          ...(fund.creation.liquidityTier
            ? { liquidityTier: fund.creation.liquidityTier }
            : {}),
          ...(fund.creation.priceProvider
            ? { priceProvider: fund.creation.priceProvider }
            : {}),
          ...(fund.creation.providerSymbol
            ? { providerSymbol: fund.creation.providerSymbol }
            : {}),
        },
        creates: fund.rows.map((row, j) =>
          rowToCreateInput(fund.creation.assetId, row, `create_${opSeed}_${j}`),
        ),
        kind: "new" as const,
      };
    });

    await store.applyStatementImportAndRipple({ funds, today });

    return {
      includedCount: plan.included.length,
      newCount: plan.included.filter((fund) => fund.kind === "new").length,
      ok: true as const,
    };
  }, _store);

  if ("error" in outcome) {
    redirect(errorUrl(outcome.error));
  }

  redirect(
    `${successRedirectUrl(returnUrl, "statement_import_loaded")}&funds=${outcome.includedCount}&created=${outcome.newCount}`,
  );
}
