"use server";

/**
 * Historical-price backfill (#380, ADR 0033).
 *
 * Preview runs the apply seam in dry-run and returns counts, source and gaps;
 * confirm re-detects candidacy and applies. Its own module since #1606.
 */

import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { errorRedirectUrl, priceBackfillDoneRedirectUrl } from "@web/intake";
import { currentUrlOf } from "@web/inversiones/return-url";
import type { WorthlineStore } from "@web/store";
import type { PriceBackfillCandidate } from "@worthline/domain";
import { detectSingleAssetBackfillCandidate, systemClock } from "@worthline/domain";
import {
  type HistoricalPriceSource,
  resolveHistoricalPriceSource,
} from "@worthline/pricing";
import { redirect } from "next/navigation";

function isHistoricalPriceSource(value: unknown): value is HistoricalPriceSource {
  return typeof value === "object" && value !== null && "fetchSeriesEur" in value;
}

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
  await guardDemoWrite(currentUrlOf(formData));
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
  await guardDemoWrite(currentUrlOf(formData));
  const returnUrl = currentUrlOf(formData);
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
