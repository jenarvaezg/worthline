"use server";

import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  type ExposureCatalogStubCandidate,
  ensureExposureCatalogStubs,
} from "@web/ensure-exposure-catalog-stubs";
import type { FormErrorContext } from "@web/intake";
import {
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  parseEntityId,
  parseRouteOperationCommand,
  parseUpdateInvestmentCommand,
  preserveFields,
  priceBackfillDoneRedirectUrl,
  pricesRefreshedRedirectUrl,
  snapshotPriceCorrectionDoneRedirectUrl,
  statementLoadedRedirectUrl,
  successRedirectUrl,
} from "@web/intake";
import {
  buildPayoutResult,
  buildPayoutScheduleResult,
  type PayoutFields,
  type PayoutScheduleFields,
  toggleExclusion,
} from "@web/patrimonio/[id]/editar/_surfaces/cobros-form";
import { type WorthlineStore } from "@web/store";
import {
  executeDeleteInvestmentOperationCommand,
  executeMergeStatementOperationsCommand,
  executeRecordInvestmentOperationCommand,
} from "@worthline/db";
import type {
  InvestmentPriceProvider,
  LiquidityTier,
  ParsedStatement,
  PriceBackfillCandidate,
  StatementMergePlan,
} from "@worthline/domain";
import {
  createInvestmentOperationSafe,
  defaultInvestmentPriceProvider,
  detectSingleAssetBackfillCandidate,
  isStatementBroker,
  parseStatement,
  planSnapshotPriceCorrection,
  planStatementMerge,
  resolvePerHoldingStatementIsinGuard,
  snapshotPriceCorrectionErrorMessage,
  systemClock,
} from "@worthline/domain";
import {
  fetchAndCachePrice,
  fetchPriceNow,
  type HistoricalPriceSource,
  type PriceProvider,
  refreshStalePrices,
  resolveHistoricalPriceSource,
} from "@worthline/pricing";
import { redirect } from "next/navigation";

// Field lists for error-preserve round-trips

const OPERATION_FORM_FIELDS = ["kind", "executedAt", "units", "pricePerUnit", "fees"];

const EDIT_INVESTMENT_FIELDS = [
  "name",
  "liquidityTier",
  "unitSymbol",
  "isin",
  "priceProvider",
  "providerSymbol",
  "manualPricePerUnit",
];

// #153 collapsed the /inversiones management routes; investments now live in
// the unified Patrimonio list and on each holding's ficha. These fallbacks only
// fire when a form omits currentUrl (the kept surfaces always set it), so they
// default to the surviving investment homes rather than the removed list.
function currentUrlOf(formData: FormData, fallback = "/patrimonio"): string {
  return (formData.get("currentUrl") as string) || fallback;
}

function isPriceProvider(value: unknown): value is PriceProvider {
  return typeof value === "object" && value !== null && "fetchPrice" in value;
}

function isHistoricalPriceSource(value: unknown): value is HistoricalPriceSource {
  return typeof value === "object" && value !== null && "fetchSeriesEur" in value;
}

async function validateInvestmentProviderSymbol(input: {
  assetId: string;
  currency: string;
  liquidityTier: LiquidityTier;
  nowIso: string;
  priceProvider?: InvestmentPriceProvider | undefined;
  providerSymbol?: string | undefined;
}): Promise<string | null> {
  if (!input.providerSymbol) return null;

  const priceProvider =
    input.priceProvider ?? defaultInvestmentPriceProvider(input.liquidityTier);

  // Finect NAVs can lag or disappear temporarily; per issue #106, Finect
  // validation is non-blocking at save time. CoinGecko (crypto, #151) is treated
  // the same — its symbols are validated on price refresh, not at save. This is
  // domain policy (which providers block on save), not the provider-resolution
  // routing the registry now owns via `fetchPriceNow`.
  if (priceProvider === "finect" || priceProvider === "coingecko") return null;

  // Route validation through the pricing seam (ADR 0026): a non-null price means
  // the symbol resolves. This gains the registry's Yahoo→Stooq fallback for free
  // (a transient Yahoo miss no longer rejects a symbol Stooq can still price) and
  // drops the bespoke provider switch + the throwaway cache-row read.
  const price = await fetchPriceNow(priceProvider, {
    assetId: input.assetId,
    currency: input.currency,
    nowIso: input.nowIso,
    symbol: input.providerSymbol,
  });

  if (price) return null;

  return `El símbolo no existe en ${providerLabel(priceProvider)}.`;
}

function providerLabel(provider: InvestmentPriceProvider): string {
  switch (provider) {
    case "stooq":
      return "Stooq";
    case "yahoo":
      return "Yahoo Finance";
    case "finect":
      return "Finect";
    case "coingecko":
      return "CoinGecko";
  }
}

export async function recordOperationAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const operationErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "operation",
      message,
      values: preserveFields(formData, OPERATION_FORM_FIELDS),
    });

  const today = _clock.today();
  const parsed = parseRouteOperationCommand(formData, routeAssetId, Date.now(), today);

  if (!parsed.ok) {
    redirect(operationErrorUrl(parsed.error));
  }

  const domainResult = createInvestmentOperationSafe(parsed.command);

  if (!domainResult.ok) {
    redirect(operationErrorUrl(mapDomainViolation(domainResult.violations[0])));
  }

  // One command persists the operation AND ripples its snapshots atomically
  // (ADR 0020; backdated operation → reconstruct history, PRD #107).
  await runActionWithStore(async (store) => {
    await executeRecordInvestmentOperationCommand(store, {
      operation: domainResult.value,
      today,
    });
  }, _store);

  redirect(successRedirectUrl(returnUrl, "saved"));
}

/**
 * The serializable result of a statement **preview** (ADR 0018, S3 / #176): the
 * counts the user confirms against, with nothing written. `idle` is the initial
 * useActionState value; `error` carries a Spanish message; `summary` carries the
 * merge-plan shape (new / overwritten) plus skipped pending/rejected rows.
 */
export type StatementPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "summary";
      created: number;
      overwritten: number;
      skipped: number;
      /** Ambiguous same-date rows set aside, neither created nor overwritten (S4). */
      anomalies: number;
      /** Rows detected as sells among those applied (S5). */
      sells: number;
    };

/** The Spanish error shown when the file's ISIN does not match the asset's (S4). */
function isinMismatchMessage(
  fileIsin: string | string[] | null,
  assetIsin: string,
): string {
  const fileLabel = Array.isArray(fileIsin) ? fileIsin.join(", ") : (fileIsin ?? "—");
  return `El ISIN del archivo (${fileLabel}) no coincide con el de esta inversión (${assetIsin}). No se ha cargado nada.`;
}

/** Count the sells among the rows a plan will actually write (created + overwritten). */
function countSells(plan: StatementMergePlan): number {
  return [...plan.toCreate, ...plan.toOverwrite.map(({ row }) => row)].filter(
    (row) => row.kind === "sell",
  ).length;
}

/**
 * Validate + parse the uploaded statement from the form, with no DB access — the
 * shared front half of preview and confirm. Returns the parsed statement or a
 * single Spanish error. The file is re-read here on BOTH steps, so confirm never
 * trusts the preview: the mounted file travels with each submission (ADR 0018,
 * mirroring the Import flow) and is re-validated server-side before any write.
 */
async function readStatementFromForm(
  formData: FormData,
): Promise<{ ok: false; message: string } | { ok: true; value: ParsedStatement }> {
  const broker = String(formData.get("broker") ?? "plantilla").trim();
  if (!isStatementBroker(broker)) {
    return { message: "Selecciona un formato compatible (la plantilla).", ok: false };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { message: "Selecciona un archivo .csv con movimientos.", ok: false };
  }

  const parsed = parseStatement(await file.text(), broker);
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

/**
 * Statement preview (ADR 0018, S3 / #176). Parse the uploaded CSV and build the
 * merge plan against this investment's current operations, then return the
 * counts WITHOUT writing anything — the human check before confirm. Reads the
 * store read-only; never redirects (it feeds useActionState).
 */
export async function previewStatementAction(
  routeAssetId: string,
  _prev: StatementPreviewState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<StatementPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const read = await readStatementFromForm(formData);
  if (!read.ok) {
    return { message: read.message, status: "error" };
  }

  const { rows, skipped } = read.value;

  return runActionWithStore(async (store) => {
    // ISIN guard (S4): block a wrong-file slip before showing any summary.
    const asset = await store.assets.readInvestmentAssetById(routeAssetId);
    const guard = resolvePerHoldingStatementIsinGuard(read.value, asset?.isin ?? null);
    if (guard.status === "mismatch") {
      return {
        message: isinMismatchMessage(guard.fileIsins, asset?.isin ?? ""),
        status: "error",
      };
    }

    const plan = planStatementMerge(
      rows,
      await store.operations.readOperations(routeAssetId),
    );
    return {
      anomalies: plan.anomalies.length,
      created: plan.toCreate.length,
      overwritten: plan.toOverwrite.length,
      sells: countSells(plan),
      skipped: skipped.length,
      status: "summary",
    };
  }, _store);
}

/**
 * Statement confirm (ADR 0018, S1 #174 + S2 #175 + S3 #176). Re-validate + parse
 * the uploaded CSV (never trusting the preview), then **merge by date** into the
 * investment's operations (file wins on date overlap, never deletes): a matching
 * date overwrites in place, a new date creates, an operation the file omits is
 * untouched. Apply in one transaction, then run ONE batched historical-snapshot
 * ripple across the union of created + overwritten dates — never per operation
 * (the #158 O(N×snapshots) cliff). The ISIN guard blocks a wrong-file slip and
 * backfills an empty asset (S4); sells load from the plantilla's Operación column.
 */
export async function confirmStatementAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const statementErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, { formId: "statement", message });

  const read = await readStatementFromForm(formData);
  if (!read.ok) {
    redirect(statementErrorUrl(read.message));
  }
  const { rows, skipped } = read.value;
  const today = _clock.today();
  const seed = Date.now();

  const applied = await runActionWithStore(async (store) => {
    // ISIN guard (S4): block a mismatch before any write; backfill an empty asset
    // so a later upload to the same holding is guarded too.
    const asset = await store.assets.readInvestmentAssetById(routeAssetId);
    const guard = resolvePerHoldingStatementIsinGuard(read.value, asset?.isin ?? null);
    if (guard.status === "mismatch") {
      return { error: isinMismatchMessage(guard.fileIsins, asset?.isin ?? "") } as const;
    }
    if (guard.status === "backfill") {
      await store.assets.backfillInvestmentIsin(routeAssetId, guard.isin);
    }

    // The catalog identity to register once the merge commits (#1097). A statement
    // is the path where an ISIN first attaches to a fund, so this is often the very
    // first identity the holding has. No instrument here: `readInvestmentAssetById`
    // is a market investment by construction and supplies its own provider.
    const catalog: ExposureCatalogStubCandidate = {
      displayName: asset?.name ?? null,
      isin: guard.status === "backfill" ? guard.isin : (asset?.isin ?? null),
      priceProvider: asset?.priceProvider ?? null,
      providerSymbol: asset?.providerSymbol ?? null,
    };

    // Merge by date (S2): plan against the asset's current operations so an
    // overlapping date overwrites in place instead of duplicating, and operations
    // the file does not mention survive untouched. Anomalous dates are set aside.
    const plan = planStatementMerge(
      rows,
      await store.operations.readOperations(routeAssetId),
    );

    // One command persists every create + overwrite AND runs ONE batched ripple
    // over the dates they touch, atomically (ADR 0020 / 0018).
    await executeMergeStatementOperationsCommand(store, {
      assetId: routeAssetId,
      creates: plan.toCreate.map((row, i) => ({
        assetId: routeAssetId,
        currency: row.currency,
        executedAt: row.dateKey,
        feesMinor: row.feesMinor,
        id: createStableId("op", `${routeAssetId}_${row.dateKey}`, seed + i),
        kind: row.kind,
        pricePerUnit: row.pricePerUnit,
        source: "statement",
        units: row.units,
        ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
      })),
      deletes: plan.toDelete.map((operation) => operation.id),
      overwrites: plan.toOverwrite.map(({ operationId, row }) => ({
        currency: row.currency,
        feesMinor: row.feesMinor,
        id: operationId,
        kind: row.kind,
        pricePerUnit: row.pricePerUnit,
        source: "statement",
        units: row.units,
        ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
      })),
      today,
    });

    return {
      anomalies: plan.anomalies.length,
      catalog,
      created: plan.toCreate.length,
      overwritten: plan.toOverwrite.length,
      sells: countSells(plan),
    } as const;
  }, _store);

  if ("error" in applied) {
    redirect(statementErrorUrl(applied.error));
  }

  // The merge committed — register the holding's (now possibly ISIN-bearing)
  // catalog row so it surfaces in /admin/catalogo. Best-effort (#1097).
  await ensureExposureCatalogStubs([applied.catalog]);

  redirect(
    statementLoadedRedirectUrl(returnUrl, {
      anomalies: applied.anomalies,
      created: applied.created,
      overwritten: applied.overwritten,
      sells: applied.sells,
      skipped: skipped.length,
    }),
  );
}

export async function updateInvestmentAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const editErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "edit",
      message,
      values: preserveFields(formData, EDIT_INVESTMENT_FIELDS),
    });

  const parsed = parseUpdateInvestmentCommand(formData, routeAssetId);

  if (!parsed.ok) {
    redirect(editErrorUrl(parsed.error));
  }

  const existing = await runActionWithStore(
    (store) => store.assets.readInvestmentAssetById(routeAssetId),
    _store,
  );
  const nextLiquidityTier =
    parsed.command.liquidityTier ?? existing?.liquidityTier ?? "market";
  const nextPriceProvider =
    parsed.command.priceProvider ?? defaultInvestmentPriceProvider(nextLiquidityTier);
  const nextProviderSymbol = parsed.command.providerSymbol;
  const priceConfigChanged = Boolean(
    existing &&
      (existing.priceProvider !== nextPriceProvider ||
        existing.providerSymbol !== nextProviderSymbol),
  );
  const validationError = await validateInvestmentProviderSymbol({
    assetId: routeAssetId,
    currency: existing?.currency ?? "EUR",
    liquidityTier: nextLiquidityTier,
    nowIso: _clock.now(),
    priceProvider: nextPriceProvider,
    providerSymbol: parsed.command.providerSymbol,
  });

  if (validationError) {
    redirect(editErrorUrl(validationError));
  }

  await runActionWithStore(async (store) => {
    await store.assets.updateInvestmentAsset(parsed.command);
    if (priceConfigChanged) {
      await store.operations.clearPriceCache(routeAssetId);
    }
  }, _store);
  redirect(successRedirectUrl(returnUrl, "saved"));
}

export async function deleteOperationAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const operationId = parseEntityId(formData, "operationId");
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);

  if (!operationId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Identificador de operación no encontrado.",
      }),
    );
  }

  // One command deletes the operation AND ripples snapshots ≥ its date,
  // atomically (ADR 0020; deleting a backdated operation, PRD #107).
  const deleted = await runActionWithStore(async (store) => {
    const result = await executeDeleteInvestmentOperationCommand(store, {
      operationId,
    });
    return result.ok ? result.value : null;
  }, _store);

  if (!deleted) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la operación — puede que ya se haya eliminado.",
      }),
    );
  }

  redirect(successRedirectUrl(returnUrl, "operation_deleted"));
}

// ── Historical-price backfill (#380, ADR 0033) ───────────────────────────────

/** The preview state for the "Rellenar histórico de precios" action. */
export type PriceBackfillPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  /** The investment is not a backfill candidate (no provider symbol or no cost-basis history). */
  | { status: "not_eligible" }
  | {
      status: "summary";
      /** New monthly snapshots the backfill would create. */
      create: number;
      /** Existing monthly snapshots it would update in place. */
      update: number;
      /** Month-start dates the source could not price — never invented. */
      gaps: string[];
      /** The source label that produced the prices (audit metadata). */
      source: string;
    };

/**
 * The single candidate-detection read, shared by preview and confirm. Reads the
 * investment metadata, its operation ledger, and its frozen snapshot rows, then
 * runs the pure `detectSingleAssetBackfillCandidate`. Returns the one candidate
 * for this asset, or null when it is not eligible (no provider symbol, no
 * operations, or no cost-basis history) — neither path then writes anything.
 */
async function readBackfillCandidate(
  store: WorthlineStore,
  assetId: string,
): Promise<PriceBackfillCandidate | null> {
  const investment = await store.assets.readInvestmentAssetById(assetId);
  if (!investment) return null;

  return detectSingleAssetBackfillCandidate({
    assetId,
    operations: await store.operations.readOperations(assetId),
    priceProvider: investment.priceProvider,
    ...(investment.providerSymbol ? { providerSymbol: investment.providerSymbol } : {}),
    snapshotRows: await store.snapshots.readSnapshotHoldings({
      holdingId: assetId,
      kind: "asset",
    }),
  });
}

/** Midnight-UTC ms for a YYYY-MM-DD date key — the source range bounds. */
function dateKeyToMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00.000Z`);
}

/**
 * Historical-price backfill preview (#380, ADR 0033). Detect candidacy, fetch the
 * source's EUR series over [first operation, today], and run the apply seam in
 * DRY-RUN mode — returning the create/update counts, the source, and the gaps
 * WITHOUT writing anything (the human check before confirm). Sharing the seam's
 * scope loop is deliberate: the surfaced counts can never diverge from what
 * confirm writes (in household mode the asset spans multiple scopes, so a
 * scope-agnostic plan count would undercount by the scope multiplier). Reads the
 * store read-only; never redirects (feeds useActionState). The source is injected
 * for tests.
 */
export async function previewPriceBackfillAction(
  routeAssetId: string,
  _prev: PriceBackfillPreviewState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<PriceBackfillPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const today = _clock.today();

  const candidate = await runActionWithStore(
    (store) => readBackfillCandidate(store, routeAssetId),
    _store,
  );
  if (!candidate) return { status: "not_eligible" };

  const _source =
    testArgFromActionArgs(_testArgs, isHistoricalPriceSource) ??
    resolveHistoricalPriceSource(candidate.priceProvider);

  const series = await _source.fetchSeriesEur(
    candidate.providerSymbol,
    dateKeyToMs(candidate.firstOperationDate),
    dateKeyToMs(today),
  );

  const result = await runActionWithStore(
    (store) =>
      store.command.backfillInvestmentPrices({
        assetId: routeAssetId,
        dryRun: true,
        pricesByDate: series.pricesByDate,
        source: series.source,
        today,
      }),
    _store,
  );

  return {
    create: result.created,
    gaps: result.gaps,
    source: result.source,
    status: "summary",
    update: result.updated,
  };
}

/**
 * Historical-price backfill confirm (#380, ADR 0033). Re-detect candidacy (never
 * trusting the preview), re-fetch the source's EUR series, and apply the backfill
 * through the atomic store seam — the ONLY path that rewrites historical
 * `unit_price`. It re-values only this asset's monthly rows (units × historical
 * price) and preserves every other frozen row (ADR 0008/0012); months without a
 * price stay gaps. Redirects with the create/update counts.
 */
export async function confirmPriceBackfillAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const today = _clock.today();

  const candidate = await runActionWithStore(
    (store) => readBackfillCandidate(store, routeAssetId),
    _store,
  );
  if (!candidate) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Esta inversión no admite relleno de histórico de precios.",
      }),
    );
  }

  const _source =
    testArgFromActionArgs(_testArgs, isHistoricalPriceSource) ??
    resolveHistoricalPriceSource(candidate.priceProvider);

  const series = await _source.fetchSeriesEur(
    candidate.providerSymbol,
    dateKeyToMs(candidate.firstOperationDate),
    dateKeyToMs(today),
  );

  const result = await runActionWithStore(
    (store) =>
      store.command.backfillInvestmentPrices({
        assetId: routeAssetId,
        pricesByDate: series.pricesByDate,
        source: series.source,
        today,
      }),
    _store,
  );

  redirect(priceBackfillDoneRedirectUrl(returnUrl, result.source));
}

// ── Single-date snapshot price correction (#926) ─────────────────────────────

/** Preview state for correcting one daily snapshot's unit price. */
export type SnapshotPriceCorrectionPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "not_eligible" }
  | {
      status: "summary";
      dateKey: string;
      unitPrice: string;
      units: string;
      valueMinor: number;
      create: number;
      update: number;
    };

async function readSnapshotPriceCorrectionContext(
  store: WorthlineStore,
  assetId: string,
): Promise<{
  operations: Awaited<ReturnType<WorthlineStore["operations"]["readOperations"]>>;
} | null> {
  const investment = await store.assets.readInvestmentAssetById(assetId);
  if (!investment) return null;

  const operations = await store.operations.readOperations(assetId);
  if (operations.length === 0) return null;

  return { operations };
}

function parseSnapshotPriceCorrectionForm(formData: FormData): {
  dateKey: string;
  unitPriceRaw: string;
} {
  return {
    dateKey: String(formData.get("dateKey") ?? "").trim(),
    unitPriceRaw: String(formData.get("unitPrice") ?? "").trim(),
  };
}

async function planCorrectionFromForm(
  store: WorthlineStore,
  assetId: string,
  formData: FormData,
  today: string,
) {
  const context = await readSnapshotPriceCorrectionContext(store, assetId);
  if (!context) return { kind: "not_eligible" as const };

  const { dateKey, unitPriceRaw } = parseSnapshotPriceCorrectionForm(formData);
  const existingSnapshotDates = new Set(
    (
      await store.snapshots.readSnapshotHoldings({
        holdingId: assetId,
        kind: "asset",
      })
    ).map((row) => row.dateKey),
  );

  const plan = planSnapshotPriceCorrection({
    dateKey,
    existingSnapshotDates,
    operations: context.operations,
    today,
    unitPriceRaw,
  });
  if (!plan.ok) {
    return {
      kind: "error" as const,
      message: snapshotPriceCorrectionErrorMessage(plan.reason),
    };
  }

  return { kind: "plan" as const, point: plan.point };
}

/**
 * Single-date snapshot price correction preview (#926). Validates the chosen date
 * and unit price, then runs the apply seam in dry-run mode — returning the
 * create/update counts and the valued row WITHOUT writing anything.
 */
export async function previewSnapshotPriceCorrectionAction(
  routeAssetId: string,
  _prev: SnapshotPriceCorrectionPreviewState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<SnapshotPriceCorrectionPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));

  const planned = await runActionWithStore(
    (store) => planCorrectionFromForm(store, routeAssetId, formData, _clock.today()),
    _store,
  );
  if (planned.kind === "not_eligible") return { status: "not_eligible" };
  if (planned.kind === "error") return { status: "error", message: planned.message };

  const result = await runActionWithStore(
    (store) =>
      store.command.correctInvestmentSnapshotUnitPrice({
        assetId: routeAssetId,
        dateKey: planned.point.dateKey,
        dryRun: true,
        unitPriceDecimal: planned.point.unitPriceDecimal,
      }),
    _store,
  );

  return {
    create: result.created,
    dateKey: planned.point.dateKey,
    status: "summary",
    unitPrice: planned.point.unitPriceDecimal,
    units: planned.point.units,
    update: result.updated,
    valueMinor: planned.point.valueMinor,
  };
}

/**
 * Single-date snapshot price correction confirm (#926). Re-validates the form
 * (never trusting the preview), applies the correction through the atomic store
 * seam, and redirects with the corrected date.
 */
export async function confirmSnapshotPriceCorrectionAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);

  const planned = await runActionWithStore(
    (store) => planCorrectionFromForm(store, routeAssetId, formData, _clock.today()),
    _store,
  );
  if (planned.kind === "not_eligible") {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Esta inversión no admite corrección de snapshot.",
      }),
    );
  }
  if (planned.kind === "error") {
    redirect(errorRedirectUrl(returnUrl, { message: planned.message }));
  }

  await runActionWithStore(
    (store) =>
      store.command.correctInvestmentSnapshotUnitPrice({
        assetId: routeAssetId,
        dateKey: planned.point.dateKey,
        unitPriceDecimal: planned.point.unitPriceDecimal,
      }),
    _store,
  );

  redirect(snapshotPriceCorrectionDoneRedirectUrl(returnUrl, planned.point.dateKey));
}

// ── Payout attribution (PRD #652 S1, #656, ADR 0054) ─────────────────────────

/**
 * A payout is a dated attribution record that a holding paid its owner an amount —
 * a pure fact, NEVER a figure: it touches no snapshot, no ripple, no net-worth
 * path, only the `store.payouts` methods. These five actions mirror the exposure
 * surface: `guardDemoWrite` first, an optional `_store` seam for tests, and a
 * redirect-with-message. Validation errors render at the "payout" section (its own
 * formId), not on the holding-edit form at the top of the page.
 */

/** Lift the one-off payout inputs off the FormData into the pure field map. */
function parsePayoutFieldsFromForm(formData: FormData): PayoutFields {
  const str = (name: string) => String(formData.get(name) ?? "");
  return { dateISO: str("dateISO"), amount: str("amount"), note: str("note") };
}

/** Lift the schedule inputs off the FormData into the pure field map. */
function parsePayoutScheduleFieldsFromForm(formData: FormData): PayoutScheduleFields {
  const str = (name: string) => String(formData.get(name) ?? "");
  return {
    label: str("label"),
    amount: str("amount"),
    cadence: str("cadence"),
    startISO: str("startISO"),
    endISO: str("endISO"),
  };
}

export async function createPayoutAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);

  const result = buildPayoutResult(parsePayoutFieldsFromForm(formData));
  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { formId: "payout", message: result.error }));
  }

  await runActionWithStore(
    (store) => store.payouts.createPayout({ holdingId: routeAssetId, ...result.payout }),
    _store,
  );
  redirect(successRedirectUrl(returnUrl, "payout_saved"));
}

export async function deletePayoutAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const payoutId = parseEntityId(formData, "payoutId");

  if (!payoutId) {
    redirect(errorRedirectUrl(returnUrl, { message: "Cobro no encontrado." }));
  }

  await runActionWithStore((store) => store.payouts.deletePayout(payoutId), _store);
  redirect(successRedirectUrl(returnUrl, "payout_deleted"));
}

export async function createPayoutScheduleAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);

  const result = buildPayoutScheduleResult(parsePayoutScheduleFieldsFromForm(formData));
  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { formId: "payout", message: result.error }));
  }

  await runActionWithStore(
    (store) =>
      store.payouts.createPayoutSchedule({ holdingId: routeAssetId, ...result.schedule }),
    _store,
  );
  redirect(successRedirectUrl(returnUrl, "payout_schedule_saved"));
}

/**
 * Update a schedule via the two ficha affordances (never a full re-entry):
 * "terminar hoy" posts an `endISO` (or `clearEnd=1` to reactivate a dead tail),
 * and "excluir mes" posts an `excludeDate` that is toggled against the schedule's
 * current exclusion list (read back so the toggle is honest, not a blind append).
 */
export async function updatePayoutScheduleAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const scheduleId = parseEntityId(formData, "scheduleId");

  if (!scheduleId) {
    redirect(errorRedirectUrl(returnUrl, { message: "Cobro recurrente no encontrado." }));
  }

  const excludeDate = String(formData.get("excludeDate") ?? "").trim();
  const endISO = String(formData.get("endISO") ?? "").trim();

  await runActionWithStore(async (store) => {
    if (excludeDate) {
      const schedule = (
        await store.payouts.readPayoutSchedulesForHolding(routeAssetId)
      ).find((candidate) => candidate.id === scheduleId);
      if (schedule) {
        await store.payouts.updatePayoutSchedule(scheduleId, {
          exclusions: toggleExclusion(schedule.exclusions, excludeDate),
        });
      }
      return;
    }
    if (formData.get("clearEnd") === "1") {
      await store.payouts.updatePayoutSchedule(scheduleId, { endISO: null });
      return;
    }
    if (endISO) {
      await store.payouts.updatePayoutSchedule(scheduleId, { endISO });
    }
  }, _store);

  redirect(successRedirectUrl(returnUrl, "payout_schedule_updated"));
}

export async function deletePayoutScheduleAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`));
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const scheduleId = parseEntityId(formData, "scheduleId");

  if (!scheduleId) {
    redirect(errorRedirectUrl(returnUrl, { message: "Cobro recurrente no encontrado." }));
  }

  await runActionWithStore(
    (store) => store.payouts.deletePayoutSchedule(scheduleId),
    _store,
  );
  redirect(successRedirectUrl(returnUrl, "payout_schedule_deleted"));
}

export async function refreshPricesAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _provider = testArgFromActionArgs(_testArgs, isPriceProvider);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData, "/patrimonio"));
  const returnUrl = currentUrlOf(formData, "/patrimonio");
  const nowIso = _clock.now();

  const allInvestmentAssets = await runActionWithStore(
    (store) => store.assets.readInvestmentAssetsWithMeta(),
    _store,
  );

  // #406: an `assetId` form field narrows the force-refresh to a single holding's
  // ficha; absent → the whole portfolio (the global /patrimonio trigger, #405).
  // Scoping `investmentAssets` here flows to both the injected-provider path and
  // the real `refreshStalePrices` path below.
  const scopeAssetId = String(formData.get("assetId") ?? "").trim();
  const investmentAssets = scopeAssetId
    ? allInvestmentAssets.filter((asset) => asset.id === scopeAssetId)
    : allInvestmentAssets;

  const refreshable = investmentAssets.filter((asset) => Boolean(asset.providerSymbol));

  const outcome = await (async () => {
    if (_provider) {
      const provider = _provider;
      const results = await Promise.all(
        refreshable.map(async (asset) => {
          const price = await fetchAndCachePrice(provider, {
            assetId: asset.id,
            symbol: asset.providerSymbol!,
            currency: asset.currency,
            nowIso,
          });
          await runActionWithStore(
            (store) => store.operations.upsertPrice(price),
            _store,
          );

          return { price, symbol: asset.providerSymbol! };
        }),
      );

      return {
        failures: results
          .filter((entry) => entry.price.freshnessState === "failed")
          .map((entry) => ({
            symbol: entry.symbol,
            reason: entry.price.staleReason ?? "",
          })),
        updated: results.filter((entry) => entry.price.freshnessState === "fresh").length,
      };
    }

    // Manual refresh refetches EVERY configured asset regardless of cache
    // staleness (#317 / ADR 0026). `force: true` is the honest replacement for
    // the old `forcedStaleCache` hack, which fabricated epoch-dated `stooq` rows
    // purely to defeat `selectStalePrices`. The cache row is still the persist
    // unit — refresh keeps owning cache policy.
    const result = await refreshStalePrices([], investmentAssets, nowIso, {
      force: true,
    });

    if (result.refreshed.length > 0) {
      await runActionWithStore(
        (store) => store.operations.upsertPrices(result.refreshed),
        _store,
      );
    }

    return {
      failures: result.failures,
      updated: result.updated,
    };
  })();

  redirect(pricesRefreshedRedirectUrl(returnUrl, outcome));
}

export { type FormErrorContext };
