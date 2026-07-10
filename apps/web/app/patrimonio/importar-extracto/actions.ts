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

import {
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  createStableId,
  errorRedirectUrl,
  resolveOwnershipSplit,
  successRedirectUrl,
} from "@web/intake";
import { type WorthlineStore } from "@web/store";
import type { Instrument, InvestmentPriceProvider } from "@worthline/domain";
import {
  buildStatementImportPlan,
  type Clock,
  defaultsFor,
  findStatementTypeConflict,
  isIsinShaped,
  isStatementBroker,
  type OwnershipShare,
  type ParsedStatement,
  type ParsedStatementRow,
  resolveStatementImportBuckets,
  type StatementFundSelection,
  type StatementImportBucket,
  systemClock,
} from "@worthline/domain";
import { redirect } from "next/navigation";
import {
  isSpreadsheet,
  SpreadsheetReadError,
  spreadsheetToDelimitedText,
} from "./spreadsheet-text";
import {
  buildStatementImportPreview,
  defaultIsinSymbolResolver,
  type FundPreviewRow,
  type IsinLookupResult,
  type IsinSymbolResolver,
  readPortfolioInvestments,
  readStatementFromText,
  statementImportPreviewReadPort,
  typeConflictMessage,
} from "./statement-import-preview";

export type {
  FundPositionImpact,
  FundPreviewRow,
  IsinLookupResult,
  IsinSymbolResolver,
  PositionImpactFlag,
} from "./statement-import-preview";

function currentUrlOf(formData: FormData): string {
  return (formData.get("currentUrl") as string) || "/patrimonio/importar-extracto";
}

// ── ISIN symbol lookup port ──────────────────────────────────────────────────

function isClock(value: unknown): value is Clock {
  return (
    typeof value === "object" && value !== null && "now" in value && "today" in value
  );
}

function isIsinSymbolResolver(value: unknown): value is IsinSymbolResolver {
  return typeof value === "function";
}

// ── Preview ───────────────────────────────────────────────────────────────

export type ImportStatementPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      funds: FundPreviewRow[];
    };

async function readStatementFromForm(
  formData: FormData,
): Promise<{ ok: false; message: string } | { ok: true; value: ParsedStatement }> {
  const broker = String(formData.get("broker") ?? "plantilla").trim();
  if (!isStatementBroker(broker)) {
    return {
      message: "Selecciona un formato compatible (la plantilla).",
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

  const parsed = readStatementFromText(text, broker);
  if (!parsed.ok) {
    return { message: parsed.message, ok: false };
  }

  return { ok: true, value: parsed.value };
}

/**
 * Preview (ADR 0055): parse the uploaded file, group by ISIN, resolve
 * matched/new buckets against the current portfolio, and prefill each new
 * fund's name/symbol via the injected resolver — WITHOUT writing anything.
 */
export async function previewImportStatementAction(
  _prev: ImportStatementPreviewState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<ImportStatementPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _resolver =
    testArgFromActionArgs(_testArgs, isIsinSymbolResolver) ?? defaultIsinSymbolResolver;
  await guardDemoWrite(currentUrlOf(formData));
  const read = await readStatementFromForm(formData);
  if (!read.ok) {
    return { message: read.message, status: "error" };
  }

  return runActionWithStore(async (store) => {
    const preview = await buildStatementImportPreview(
      statementImportPreviewReadPort(store),
      read.value,
      _resolver,
    );
    if (!preview.ok) {
      return { message: preview.message, status: "error" };
    }

    return { funds: preview.funds, status: "ready" };
  }, _store);
}

// ── Confirm ───────────────────────────────────────────────────────────────

function isinFormKey(prefix: string, isin: string): string {
  return `${prefix}_${isin}`;
}

function shouldReplaceOpening(formData: FormData, isin: string): boolean {
  const seen = formData.get(isinFormKey("replaceOpeningSeen", isin)) === "on";
  return !seen || formData.get(isinFormKey("replaceOpening", isin)) === "on";
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
    // never from the client (#695); rows without a declared type default to fund.
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
    source: "statement" as const,
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
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData));
  const returnUrl = currentUrlOf(formData);
  const errorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, { formId: "statement", message });

  const read = await readStatementFromForm(formData);
  if (!read.ok) {
    redirect(errorUrl(read.message));
  }
  const today = _clock.today();
  const seed = Date.now();

  const outcome = await runActionWithStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) {
      return { error: "Workspace no inicializado." } as const;
    }

    const investments = await readPortfolioInvestments(
      statementImportPreviewReadPort(store),
    );
    const buckets = resolveStatementImportBuckets(read.value, investments, {
      replaceOpening: (group) => shouldReplaceOpening(formData, group.isin),
    });

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
          deletes: fund.mergePlan.toDelete.map((operation) => operation.id),
          kind: "matched" as const,
          overwrites: fund.mergePlan.toOverwrite.map(({ operationId, row }) => ({
            currency: row.currency,
            feesMinor: row.feesMinor,
            id: operationId,
            kind: row.kind,
            pricePerUnit: row.pricePerUnit,
            source: "statement" as const,
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
