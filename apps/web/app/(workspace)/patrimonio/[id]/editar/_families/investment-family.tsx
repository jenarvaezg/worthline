/**
 * The market-investment ficha: the holding whose units live in an operations
 * ledger (ADR 0006) — a fund, an ETF, a stock, a pension plan, a hand-kept
 * crypto position.
 *
 * This is the only family with a ledger, and every surface here is downstream of
 * it: the returns panel folds it (#551, ADR 0040), the benchmark card compares it
 * (#711), the traspaso records a pair of halves into it (#1480, PRD #1393), the
 * broker statement loads rows into it (ADR 0018), and the two price repairs
 * (backfill #380, snapshot correction #926) fix what the ledger's valuation got
 * wrong. Its own bound server actions live here too — the ficha is the single
 * place an operation is recorded (#153, and one module per surface since #1606).
 */

import OperationsEditor from "@web/_components/operations-editor";
import { transferCounterpartByOperationId } from "@web/_components/transfer-counterparts";
import { buildHoldingBenchmarkComparison } from "@web/build-holding-benchmark";
import HoldingBenchmarkComparisonCard from "@web/holding-benchmark-comparison-card";
import { refreshPricesAction } from "@web/inversiones/refresh-prices-action";
import { PriceBackfillSection } from "@web/patrimonio/[id]/editar/_surfaces/price-backfill-section";
import { ReturnsPanel } from "@web/patrimonio/[id]/editar/_surfaces/returns-panel";
import { SnapshotPriceCorrectionSection } from "@web/patrimonio/[id]/editar/_surfaces/snapshot-price-correction-section";
import { StatementUploadSection } from "@web/patrimonio/[id]/editar/_surfaces/statement-upload-section";
import { transferDestinationOptions } from "@web/patrimonio/[id]/editar/_surfaces/transfer-form";
import TransferSection from "@web/patrimonio/[id]/editar/_surfaces/transfer-section";
import { PriceRefreshControl } from "@web/patrimonio/price-refresh-control";
import { detailRefreshCaption } from "@web/price-refresh";
import { readBenchmarkPricesFromControlPlane } from "@web/read-benchmark-prices";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import {
  buildHoldingReturnsView,
  detectSingleAssetBackfillCandidate,
  detectValueOnlyOpening,
  getPriceFreshness,
  holdingIrr,
  holdingTrashImpact,
  holdingTwr,
  instrumentOfAsset,
  lastCapturedCurrency,
  monthlyCloseValuesByHolding,
  simpleGain,
  usableCachedPrice,
} from "@worthline/domain";
import type { AssetFamilyContext, HoldingSurface } from "./family-contract";
import { holdingSurface } from "./family-contract";
import { bindInvestmentActions } from "./investment-actions";

export async function loadInvestmentSurface(
  ctx: AssetFamilyContext,
): Promise<HoldingSurface> {
  const {
    allAssets,
    archiveOriginAfterTransfer,
    asset,
    checkedAt,
    currentUrl,
    formError,
    id,
    isDemo,
    payoutsPanel,
    privacyMode,
    store,
    today,
  } = ctx;

  // Six independent reads, one wave instead of serial round-trips (#446). The
  // whole positions list is kept, not just this holding's: the traspaso picker
  // (#1480) prefills each candidate destination's VL from its last known price,
  // and that is the same wave — a query per candidate would be an N+1 for a
  // prefill.
  const [investment, operations, priceCache, positions, twrSnapshotRows, counterparts] =
    await Promise.all([
      store.assets.readInvestmentAssetById(id),
      store.operations.readOperations(id),
      store.operations.readPriceCache(id),
      store.snapshots.readPositions(),
      store.snapshots.readSnapshotHoldings({
        holdingId: id,
        kind: "asset",
        scopeId: "household",
      }),
      // Where each traspaso half's other half lives (#1481), so the operations
      // table prints the pair as one move («a Fondo Azul») instead of a loose
      // sale or buy.
      store.operations.readTransferCounterparts(id),
    ]);

  const position = positions.find((p) => p.assetId === id) ?? null;
  const twrMonthlyCloses = monthlyCloseValuesByHolding(twrSnapshotRows).get(id) ?? [];

  // Exposure profile read for benchmark comparison (catalog #711 S3): keyed by
  // the security's identity (`isin ?? providerSymbol`) from the global catalog
  // now that workspace hand-entry was retired (#1014 S5).
  const exposureProfileKey = investment
    ? (investment.isin ?? investment.providerSymbol ?? null)
    : null;
  const exposureProfile = exposureProfileKey
    ? ((await readExposureProfilesFromCatalog()).find(
        (profile) => profile.key === exposureProfileKey,
      ) ?? null)
    : null;

  const freshness = priceCache ? getPriceFreshness(priceCache, checkedAt) : null;
  // The cached row's price when it IS a price: a `failed` row carries "0" as the
  // marker for "no price known" (#1330), and showing that zero as this holding's
  // last price contradicts the cost-basis figure beside it.
  const usablePrice = priceCache ? usableCachedPrice(priceCache) : null;

  // An unpriced position (a symbol whose first quote has not landed yet) enters
  // the engine at its cost basis — the valuation authority's own fallback — so
  // the panel never fabricates a −100% while the valuation beside it reads the
  // cost (#1314).
  const returnsMarketValueMinor =
    position?.marketValue?.amountMinor ?? position?.costBasis.amountMinor ?? 0;
  const returnsView = buildHoldingReturnsView({
    instrument: instrumentOfAsset(asset),
    irr: holdingIrr({
      currency: asset.currency,
      marketValueMinor: returnsMarketValueMinor,
      operations,
      valuationDate: today,
    }),
    simpleGain: simpleGain({
      currency: asset.currency,
      marketValueMinor: returnsMarketValueMinor,
      operations,
      valuationDate: today,
    }),
    twr:
      twrMonthlyCloses.length > 0
        ? holdingTwr({ monthlyCloses: twrMonthlyCloses, operations })
        : null,
    ...(position?.realizedPnl ? { realizedPnl: position.realizedPnl } : {}),
    ...(position?.unrealizedPnl ? { unrealizedPnl: position.unrealizedPnl } : {}),
  });

  const benchmarkResult = exposureProfile?.trackedIndex
    ? await buildHoldingBenchmarkComparison({
        distributing: investment?.benchmarkDistributing ?? false,
        monthlyCloses: twrMonthlyCloses,
        operations,
        readBenchmarkPrices: readBenchmarkPricesFromControlPlane,
        trackedIndex: exposureProfile.trackedIndex,
      })
    : null;

  // Historical-price backfill candidacy (#380, ADR 0033): a derived investment
  // with a provider symbol AND cost-basis history offers the explicit backfill
  // surface. Detected server-side so it only renders for a real candidate (the
  // action re-checks before writing).
  const isBackfillCandidate =
    investment !== null &&
    detectSingleAssetBackfillCandidate({
      assetId: id,
      operations,
      priceProvider: investment.priceProvider,
      ...(investment.providerSymbol ? { providerSymbol: investment.providerSymbol } : {}),
      snapshotRows: twrSnapshotRows,
    }) !== null;

  // Whether this ficha's ledger takes apuntes written BY HAND. It gates the
  // Traspasar surface and, with it, the Papelera exit that writes an apunte: on a
  // source-owned ledger, «lo vendí» would record a sale the ficha refuses to show
  // and the next sync would undo. Offered whenever the holding HAS a ledger, not
  // whenever it has units today: a traspaso is routinely recorded weeks later,
  // and the one that emptied the holding is exactly the row still missing.
  const hasManualLedger = operations.length > 0;

  const action = bindInvestmentActions(id);

  return holdingSurface("investment", {
    body: (
      <>
        {/* priced: on-demand provider refresh for just this holding (#406) — the
            narrow counterpart to the global /patrimonio trigger. Hidden when the
            holding has no price provider (manual). */}
        {investment?.providerSymbol ? (
          <PriceRefreshControl
            action={refreshPricesAction}
            assetId={asset.id}
            currentUrl={currentUrl}
            label="Actualizar precio"
            pendingLabel="Actualizando…"
          />
        ) : null}

        {/* Three measures + realized/unrealized split + honest caveats (#551,
            ADR 0040), above the operations ledger. */}
        {returnsView ? (
          <ReturnsPanel privacyMode={privacyMode} view={returnsView} />
        ) : null}

        {benchmarkResult && exposureProfile?.trackedIndex ? (
          <HoldingBenchmarkComparisonCard
            result={benchmarkResult}
            trackedIndex={exposureProfile.trackedIndex}
          />
        ) : null}

        {/* The operations editor — the single place units change. */}
        <OperationsEditor
          assetId={id}
          assetName={asset.name}
          context={{
            ...(position ? { currentUnits: position.currentUnits } : {}),
            ...(position?.currencyWarning
              ? { currencyWarning: position.currencyWarning }
              : {}),
            ...(priceCache
              ? {
                  // A `failed` row carries price "0" as the marker for "no price
                  // known" (#1330): show the failure, never the zero as if it
                  // were this holding's last price.
                  ...(usablePrice !== null ? { unitPrice: usablePrice } : {}),
                  priceFreshness: freshness,
                  // Visible caption (#303): when + by which source the cached
                  // unit price was last refreshed (absolute es-ES date). Null for
                  // a manual quote (its `source` is `manual`, so no provider date).
                  priceRefreshCaption: detailRefreshCaption(
                    priceCache.source === "manual" ? null : priceCache.fetchedAt,
                    priceCache.source === "manual" ? null : priceCache.source,
                  ),
                }
              : {}),
            ...(position?.marketValue ? { marketValue: position.marketValue } : {}),
            ...(position?.unrealizedPnl ? { unrealizedPnl: position.unrealizedPnl } : {}),
          }}
          currentUrl={currentUrl}
          // The currency this ledger last captured an apunte in (#1401), so a
          // dollar fund does not ask for it again on every purchase.
          defaultCurrency={lastCapturedCurrency(operations)}
          deleteAction={action.deleteOperation}
          formError={formError}
          operations={operations}
          privacyMode={privacyMode}
          readOnly={isDemo}
          recordAction={action.recordOperation}
          today={today}
          // The traspaso rows' counterpart names (#1481): join this ledger's
          // halves with the store's counterpart map and the live holdings' names.
          // A counterpart whose holding is not in `allAssets` (Papelera) resolves
          // as `unresolved` — the row claims nothing rather than mislabelling it
          // as external.
          transferCounterparts={transferCounterpartByOperationId(
            operations,
            counterparts,
            new Map(allAssets.map((a) => [a.id, a.name])),
          )}
        />

        {/* «Traspasar» — one screen, one submit for a fund-to-fund traspaso
            (#1480, PRD #1393). The ledger travels so the preview can fold it at
            the date the user picks (#1438). */}
        {hasManualLedger ? (
          <TransferSection
            archiveOrigin={archiveOriginAfterTransfer}
            currentUrl={currentUrl}
            // The traspaso picker's candidates (#1480): the workspace's other
            // ledger-keeping holdings in the same currency, off the assets and
            // positions already read.
            destinations={transferDestinationOptions(allAssets, positions, {
              assetId: id,
              currency: asset.currency,
            })}
            formError={formError}
            origin={{
              assetId: id,
              currency: asset.currency,
              operations,
              ...(position?.currentPricePerUnit
                ? { pricePerUnit: position.currentPricePerUnit }
                : {}),
            }}
            originName={asset.name}
            privacyMode={privacyMode}
            readOnly={isDemo}
            recordAction={action.recordTransfer}
            today={today}
          />
        ) : null}

        {/* Load operations from a broker statement (ADR 0018, #174/#176). */}
        <StatementUploadSection
          confirmAction={action.confirmStatement}
          currentUrl={currentUrl}
          previewAction={action.previewStatement}
        />

        {/* The explicit historical-price backfill (#380, ADR 0033). */}
        {isBackfillCandidate ? (
          <PriceBackfillSection
            confirmAction={action.confirmPriceBackfill}
            currentUrl={currentUrl}
            previewAction={action.previewPriceBackfill}
          />
        ) : null}

        {/* Correct one daily snapshot's unit price (#926). */}
        {investment !== null && operations.length > 0 ? (
          <SnapshotPriceCorrectionSection
            confirmAction={action.confirmSnapshotPriceCorrection}
            currentUrl={currentUrl}
            previewAction={action.previewSnapshotPriceCorrection}
            today={today}
            {...(usablePrice !== null ? { defaultUnitPrice: usablePrice } : {})}
          />
        ) : null}

        {payoutsPanel}
      </>
    ),
    basics: {
      investment,
      // #1329: the «alta por valor total» state — 1 participación holding the
      // whole declared value — but only while it has no symbol. With one, the
      // quote already governs the valuation and the warning would be an obituary.
      valueOnlyOpening:
        investment !== null && !investment.providerSymbol
          ? detectValueOnlyOpening(operations)
          : null,
    },
    // The Papelera's «Lo traspasé a…» exit returns HERE with the advanced block
    // unfolded and the archive intent in the URL (#1549).
    manualLedger: hasManualLedger
      ? { transferHref: `${currentUrl}?abrir=traspaso&archivar=1#traspaso` }
      : null,
    operations,
    // What the Papelera would take with it (#1365). Reads the position this
    // family already derived — no extra I/O — so the figure in the confirmation
    // is the same one the ficha shows above it.
    trashImpact: holdingTrashImpact(position),
  });
}
