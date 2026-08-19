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
  testFxRatesOverride,
  testStoreFromActionArgs,
} from "@web/action-store";
import { markFirstHoldingBestEffort } from "@web/activation-marks";
import { guardDemoWrite } from "@web/demo/write-guard";
import { ingestionBlockedMessage } from "@web/entitlements/ingestion-guard";
import { PAYWALL_STATEMENT_MESSAGE } from "@web/entitlements/paywall-copy";
import { formAction } from "@web/form-action";
import {
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  resolveOwnershipSplit,
  successRedirectUrl,
} from "@web/intake";
import {
  statementRowToCreateInput,
  statementRowToOverwrite,
} from "@web/statement-operation-input";
import { type WorthlineStore } from "@web/store";
import type { Instrument, InvestmentPriceProvider } from "@worthline/domain";
import {
  buildStatementImportPlan,
  defaultsFor,
  findStatementTypeConflict,
  findUnresolvedStatementChoice,
  isIsinShaped,
  isProviderSymbolShaped,
  isStatementBroker,
  type OwnershipShare,
  type ParsedStatement,
  type ParsedStatementRow,
  resolveStatementImportBuckets,
  type StatementFundSelection,
  type StatementImportBucket,
} from "@worthline/domain";
import {
  type ConvertCapturedOperationsOptions,
  convertStatementRows,
} from "@worthline/pricing";
import {
  buildStatementImportPreview,
  defaultIsinSymbolResolver,
  type FundPreviewRow,
  type IsinLookupResult,
  type IsinSymbolResolver,
  isIsinSymbolResolver,
  readPortfolioInvestments,
  statementImportPreviewReadPort,
  typeConflictMessage,
  unresolvedChoiceMessage,
} from "./statement-import-preview";
import { readStatementUpload, STATEMENT_GATE_FORMATS } from "./statement-upload-read";

export type {
  FundMatchChoice,
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

// ── Preview ───────────────────────────────────────────────────────────────

export type ImportStatementPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      funds: FundPreviewRow[];
      /**
       * What the reading could not settle (#1488): a direction nothing in the file
       * stated, an assumed currency, a row skipped. Shown before the confirm, because a
       * reading with a doubt is honest only when the doubt is on screen (ADR 0048).
       */
      warnings: string[];
    };

/**
 * Read the uploaded file into a parsed statement whose rows are all in EUROS (#1401).
 *
 * The conversion happens HERE, at the single door both the preview and the confirm go
 * through, and it happens to the ROWS rather than to the operations built from them:
 * the merge plan compares incoming rows against stored (euro) operations by units and
 * price, so converting first is what keeps that comparison meaningful — and what makes
 * the preview show the figures the confirm will write (#1438).
 *
 * Each row converts at the rate of its OWN execution date, and one unconvertible row
 * refuses the whole file — the same all-or-nothing this importer already applies to a
 * malformed row (ADR 0010).
 */
async function readStatementFromForm(
  formData: FormData,
  fxOptions: ConvertCapturedOperationsOptions = {},
): Promise<
  | { ok: false; message: string }
  | { ok: true; value: ParsedStatement; warnings: string[] }
> {
  const broker = String(formData.get("broker") ?? "plantilla").trim();
  if (!isStatementBroker(broker)) {
    return {
      message: `Selecciona un formato compatible: ${STATEMENT_GATE_FORMATS.join(" o ")}.`,
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

  // Which format the file IS lives in `readStatementUpload` (#1488): the declared one
  // first, the generic broker-transactions reader when the file is not that format at
  // all. This action only does the IO — the bytes and the FX rates.
  const read = readStatementUpload({
    broker,
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name,
  });
  if (!read.ok) {
    return { message: read.message, ok: false };
  }

  const converted = await convertStatementRows(read.statement.rows, fxOptions);
  if (!converted.ok) {
    return { message: mapDomainViolation(converted.violations[0]), ok: false };
  }

  return {
    ok: true,
    value: { ...read.statement, rows: converted.value },
    warnings: read.warnings,
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
  ..._testArgs: unknown[]
): Promise<ImportStatementPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _resolver =
    testArgFromActionArgs(_testArgs, isIsinSymbolResolver) ?? defaultIsinSymbolResolver;
  await guardDemoWrite(currentUrlOf(formData));

  // Importing a broker statement is premium ingestion (#1162): manual entry
  // stays free, but the machine only reads a statement for premium.
  const paywall = await ingestionBlockedMessage(PAYWALL_STATEMENT_MESSAGE);
  if (paywall) {
    return { message: paywall, status: "error" };
  }

  const read = await readStatementFromForm(formData, testFxRatesOverride(_testArgs));
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

    return { funds: preview.funds, status: "ready", warnings: read.warnings };
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

/**
 * The holding the user named for an identifier several investments claim (#1366),
 * or undefined.
 *
 * Read WHATEVER was posted, never gated on the re-derived bucket still being
 * ambiguous: if the chosen holding was trashed between preview and confirm, the
 * bucket comes back with one claimant, and dropping the choice there would apply
 * the import — deletes and overwrites included — to the holding the user did not
 * pick. A resolved preview renders no select, so nothing is posted for it.
 */
function chosenAssetId(
  formData: FormData,
  bucket: StatementImportBucket,
): string | undefined {
  if (bucket.bucket !== "matched") return undefined;
  const posted = String(formData.get(isinFormKey("assetId", bucket.isin)) ?? "").trim();
  return posted === "" ? undefined : posted;
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
      const assetId = chosenAssetId(formData, bucket);
      return included
        ? ({
            action: "include",
            isin: bucket.isin,
            ...(assetId ? { assetId } : {}),
          } as const)
        : ({ action: "ignore", isin: bucket.isin } as const);
    }

    // The instrument comes from the re-derived bucket (the file's own rows),
    // never from the client (#695); rows without a declared type default to fund.
    const instrument = bucket.instrument ?? "fund";
    const defaults = defaultsFor(instrument);

    const name =
      String(formData.get(isinFormKey("name", bucket.isin)) ?? "").trim() || bucket.isin;
    // Shape-checked here too, not only in the preview suggestion (#1330): a name
    // typed into the symbol box resolves with no provider, and every daily retry
    // rewrites the holding's `failed` price row.
    const typedSymbol = String(
      formData.get(isinFormKey("symbol", bucket.isin)) ?? "",
    ).trim();
    const symbol = isProviderSymbolShaped(typedSymbol) ? typedSymbol : "";

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
  const errorUrl = (message: string) =>
    errorRedirectUrl(currentUrlOf(formData), { formId: "statement", message });

  return formAction<undefined, { includedCount: number; newCount: number }>({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    // A statement import can be the workspace's first holding write (#1131).
    afterCommit: async () => {
      await markFirstHoldingBestEffort();
    },
    run: async (store, { formData, today }) => {
      // Premium ingestion gate (#1162), re-checked at confirm — never trust the
      // preview to have gated. Manual tracking stays free.
      const paywall = await ingestionBlockedMessage(PAYWALL_STATEMENT_MESSAGE);
      if (paywall) {
        return { ok: false, error: paywall };
      }

      const read = await readStatementFromForm(formData, testFxRatesOverride(_testArgs));
      if (!read.ok) {
        return { ok: false, error: read.message };
      }

      const seed = Date.now();

      const workspace = await store.workspace.readWorkspace();
      if (!workspace) {
        return { ok: false, error: "Workspace no inicializado." };
      }

      const investments = await readPortfolioInvestments(
        statementImportPreviewReadPort(store),
      );
      const buckets = resolveStatementImportBuckets(read.value, investments, {
        replaceOpening: (group) => shouldReplaceOpening(formData, group.isin),
      });

      const conflict = findStatementTypeConflict(buckets);
      if (conflict) {
        return { ok: false, error: typeConflictMessage(conflict) };
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

      // Last line of defence for #1366: the preview blocks an unchosen identifier
      // client-side, but the buckets are re-derived here against the live
      // portfolio — a holding created (or trashed) since the preview can turn a
      // resolved row ambiguous, or void the choice that was made.
      const unresolved = findUnresolvedStatementChoice(buckets, selections);
      if (unresolved) {
        return { ok: false, error: unresolvedChoiceMessage(unresolved) };
      }

      const plan = buildStatementImportPlan(buckets, selections);

      const funds = plan.included.map((fund, index) => {
        const opSeed = `${seed}_${index}`;

        if (fund.kind === "matched") {
          return {
            assetId: fund.assetId,
            creates: fund.mergePlan.toCreate.map((row, j) =>
              statementRowToCreateInput({
                assetId: fund.assetId,
                id: createStableId(
                  "op",
                  `${fund.assetId}_${row.dateKey}`,
                  seed + index * 1000 + j,
                ),
                row,
                source: "statement",
              }),
            ),
            deletes: fund.mergePlan.toDelete.map((operation) => operation.id),
            kind: "matched" as const,
            overwrites: fund.mergePlan.toOverwrite.map(({ operationId, row }) =>
              statementRowToOverwrite({ operationId, row, source: "statement" }),
            ),
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
            statementRowToCreateInput({
              assetId: fund.creation.assetId,
              id: `create_${opSeed}_${j}`,
              row,
              source: "statement",
            }),
          ),
          kind: "new" as const,
        };
      });

      await store.command.applyStatementImport({ funds, today });

      return {
        ok: true,
        value: {
          includedCount: plan.included.length,
          newCount: plan.included.filter((fund) => fund.kind === "new").length,
        },
      };
    },
    onError: ({ error }) => errorUrl(error),
    onSuccess: ({ value }) =>
      `${successRedirectUrl(currentUrlOf(formData), "statement_import_loaded")}&funds=${value?.includedCount}&created=${value?.newCount}`,
  })(formData, ..._testArgs);
}
