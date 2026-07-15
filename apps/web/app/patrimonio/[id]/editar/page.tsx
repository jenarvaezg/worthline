import OperationsEditor from "@web/_components/operations-editor";
import { buildHoldingBenchmarkComparison } from "@web/build-holding-benchmark";
import { isDemoMode } from "@web/demo/write-guard";
import HoldingBenchmarkComparisonCard from "@web/holding-benchmark-comparison-card";
import {
  PRIVACY_COOKIE_NAME,
  parseFormError,
  parsePrivacyCookie,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import {
  confirmPriceBackfillAction,
  confirmSnapshotPriceCorrectionAction,
  confirmStatementAction,
  createPayoutAction,
  createPayoutScheduleAction,
  deleteOperationAction,
  deletePayoutAction,
  deletePayoutScheduleAction,
  type PriceBackfillPreviewState,
  previewPriceBackfillAction,
  previewSnapshotPriceCorrectionAction,
  previewStatementAction,
  recordOperationAction,
  refreshPricesAction,
  type SnapshotPriceCorrectionPreviewState,
  type StatementPreviewState,
  updateInvestmentAction,
  updatePayoutScheduleAction,
} from "@web/inversiones/actions";
import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
} from "@web/patrimonio/actions";
import { PriceRefreshControl } from "@web/patrimonio/price-refresh-control";
import { detailRefreshCaption } from "@web/price-refresh";
import { readBenchmarkPricesFromControlPlane } from "@web/read-benchmark-prices";
import Shell from "@web/shell";
import { bootstrapHealthcheck, withStore } from "@web/store";
import type { CoinPosition, ValuationMethod } from "@worthline/domain";
import {
  buildHoldingReturnsView,
  collectWarnings,
  detectSingleAssetBackfillCandidate,
  getPriceFreshness,
  holdingIrr,
  holdingTwr,
  instrumentOfAsset,
  listScopeOptions,
  monthlyCloseValuesFromSnapshotRows,
  simpleGain,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BinanceHoldingSection } from "./_surfaces/binance-holding-section";
import { tokenPositionsOnRung } from "./_surfaces/binance-holding-view";
import { CobrosSection } from "./_surfaces/cobros-section";
import { CoinCollectionSection } from "./_surfaces/coin-collection-section";
import { DebtModelSection } from "./_surfaces/debt-model-section";
import { AssetEditForm, LiabilityEditForm } from "./_surfaces/holding-forms";
import { HousingValuationSection } from "./_surfaces/housing-valuation-section";
import { PriceBackfillSection } from "./_surfaces/price-backfill-section";
import { ReturnsPanel } from "./_surfaces/returns-panel";
import { SnapshotPriceCorrectionSection } from "./_surfaces/snapshot-price-correction-section";
import { StatementUploadSection } from "./_surfaces/statement-upload-section";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export default async function EditarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const persistence = await bootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
  const privacyMode = parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);

  const storeData = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    // Independent base reads — one wave instead of serial round-trips (#446).
    const [assets, liabilities, overrides] = await Promise.all([
      store.assets.readAssets(),
      store.liabilities.readLiabilities(),
      store.readWarningOverrides(),
    ]);

    const asset = assets.find((a) => a.id === id) ?? null;
    const liability = liabilities.find((l) => l.id === id) ?? null;

    // The holding's valuation method drives which surface renders (#152, ADR 0014).
    const assetMethod = asset ? valuationMethodOfAsset(asset) : null;

    // appreciating (property): appreciation rate + market appraisals (PRD #108).
    const isAppreciating = assetMethod === "appreciating";
    // The three housing reads are independent — fetch them in one wave (#446).
    // (cadence: ADR 0031, #394; null → `step`.)
    const [anchors, appreciationRate, housingValuationCadence] = isAppreciating
      ? await Promise.all([
          store.assets.readValuationAnchors(id),
          store.assets.readAnnualAppreciationRate(id),
          store.assets.readValuationCadence(id),
        ])
      : [[], null, null];

    // A connected-source coin collection (Numista) is `derived` too, but its
    // sub-detail is its mirrored positions, not investment operations (ADR 0016).
    // Resolve the source from the asset id, then read its positions.
    const isCoinCollection = asset?.instrument === "coin_collection";
    const coinSource = isCoinCollection
      ? ((await store.connectedSources.listSources()).find((s) => s.assetId === id) ??
        null)
      : null;
    const coinPositions = coinSource
      ? (await store.connectedSources.readPositions(coinSource.id)).filter(
          (p): p is CoinPosition => p.kind === "coin",
        )
      : [];

    // A connected Binance crypto holding is `derived` too (instrument `crypto`),
    // but — like Numista — its sub-detail is mirrored token positions, not
    // investment operations (ADR 0021). A source now materializes ONE asset per
    // rung (market + term-locked, #248), so the term-locked asset's id does NOT
    // match `connected_sources.asset_id`. Resolve the source via the asset's OWN
    // `connected_source_id` back-link instead, then show only the positions on
    // THIS asset's rung — opening the market asset lists market tokens, opening the
    // term-locked asset lists the locked ones. Distinguishes a connected holding
    // from a MANUAL crypto investment (which has no source link).
    const assetSourceId =
      asset?.instrument === "crypto"
        ? await store.connectedSources.readSourceIdForAsset(id)
        : null;
    const binanceSourceRow = assetSourceId
      ? ((await store.connectedSources.listSources()).find(
          (s) => s.id === assetSourceId && s.adapter === "binance",
        ) ?? null)
      : null;
    const isBinanceHolding = binanceSourceRow !== null;
    const binancePositions =
      binanceSourceRow && asset
        ? tokenPositionsOnRung(
            await store.connectedSources.readPositions(binanceSourceRow.id),
            asset.liquidityTier,
          )
        : [];
    // The curve start (PRD #245 S5, #250): the earliest snapshot dateKey carrying
    // this asset's frozen row — how far back the reconstructed monthly history
    // reaches. Null until a backfill has run. Surfaced as "Datos desde DD/MM".
    const binanceSinceDateKey =
      binanceSourceRow && asset
        ? ((
            await store.snapshots.readSnapshotHoldings({ holdingId: id, kind: "asset" })
          ).reduce<string | null>(
            (min, row) => (min === null || row.dateKey < min ? row.dateKey : min),
            null,
          ) ?? null)
        : null;

    // derived (investment): the operations editor + its derived position (ADR 0006).
    // A coin collection / Binance holding is derived but routed to its own surface,
    // so skip these.
    const isDerived = assetMethod === "derived" && !isCoinCollection && !isBinanceHolding;
    // The four derived-investment reads are independent of one another — fetch
    // them in one wave instead of stacking serial round-trips to the store (#446).
    const [investment, operations, priceCache, position, twrSnapshotRows] = isDerived
      ? await Promise.all([
          store.assets.readInvestmentAssetById(id),
          store.operations.readOperations(id),
          store.operations.readPriceCache(id),
          store.snapshots
            .readPositions()
            .then((ps) => ps.find((p) => p.assetId === id) ?? null),
          store.snapshots.readSnapshotHoldings({
            holdingId: id,
            kind: "asset",
            scopeId: "household",
          }),
        ])
      : [null, [], null, null, []];
    // The coin collection's decoupled valuation freshness (PRD #166): its own
    // `numista`-source cache row, separate from the investment derived path above.
    const coinValuationCache = isCoinCollection
      ? await store.operations.readPriceCache(id)
      : null;

    // Historical-price backfill candidacy (#380, ADR 0033): a derived investment
    // with a provider symbol AND cost-basis history offers the explicit backfill
    // surface. Detected here server-side so the surface only renders for a real
    // candidate (the action re-checks before writing).
    const isBackfillCandidate =
      isDerived && investment !== null
        ? detectSingleAssetBackfillCandidate({
            assetId: id,
            operations,
            priceProvider: investment.priceProvider,
            ...(investment.providerSymbol
              ? { providerSymbol: investment.providerSymbol }
              : {}),
            snapshotRows: twrSnapshotRows,
          }) !== null
        : false;
    const isSnapshotCorrectionEligible =
      isDerived && investment !== null && operations.length > 0;
    const twrMonthlyCloses = monthlyCloseValuesFromSnapshotRows(twrSnapshotRows);

    // Exposure profile read for benchmark comparison (PRD #539): keyed by the
    // security's identity (`isin ?? providerSymbol`).
    const exposureProfileKey = investment
      ? (investment.isin ?? investment.providerSymbol ?? null)
      : null;
    const exposureProfile = exposureProfileKey
      ? await store.exposureProfiles.readExposureProfile(exposureProfileKey)
      : null;

    // Cobros (PRD #652 S1, #656, ADR 0054): a payout is a pure attribution record
    // on an asset holding — never a figure. Read this holding's one-off payouts +
    // declared schedules, plus the scope's declared monthly spending (for the
    // renta-pasiva coverage; omitted gracefully when the scope has no FIRE figure).
    const payouts = asset ? await store.payouts.readPayoutsForHolding(id) : [];
    const payoutSchedules = asset
      ? await store.payouts.readPayoutSchedulesForHolding(id)
      : [];
    const scopeFireConfig =
      asset && selectedScope
        ? (await store.readFireConfig())[selectedScope.id]
        : undefined;
    const payoutMonthlySpendingMinor = scopeFireConfig?.monthlySpendingMinor ?? null;

    // amortized / anchored: the debt-model data (PRD #109).
    const debtModel = liability ? await store.liabilities.readDebtModel(id) : null;
    const amortizationPlan =
      liability && debtModel === "amortizable"
        ? await store.liabilities.readAmortizationPlan(id)
        : null;
    // Revisions + early repayments both hang off the plan id and are independent
    // of each other — one wave once the plan is known (#446).
    const [rateRevisions, earlyRepayments] = amortizationPlan
      ? await Promise.all([
          store.liabilities.readInterestRateRevisions(amortizationPlan.id),
          store.liabilities.readEarlyRepayments(amortizationPlan.id),
        ])
      : [[], []];
    const balanceAnchors =
      liability && (debtModel === "revolving" || debtModel === "informal")
        ? await store.liabilities.readBalanceAnchors(id)
        : [];
    // Valuation cadence (ADR 0031, #393); null reads as the default `step`.
    const valuationCadence = liability
      ? await store.liabilities.readValuationCadence(id)
      : null;
    // The current MODELLED balance, shown beside "Recalibrar con saldo real"
    // (ADR 0056, PRD #670 S3, #678) so the drift against the bank's real figure
    // is visible at the moment of repair — only meaningful once a plan exists.
    const currentModelledBalanceMinor = amortizationPlan
      ? await store.liabilities.debtBalanceAtDate(
          id,
          new Date().toISOString().slice(0, 10),
        )
      : null;

    return {
      activeMembers: workspace.members.filter((m) => !m.disabledAt),
      amortizationPlan,
      currentModelledBalanceMinor,
      anchors,
      appreciationRate,
      asset,
      assetMethod,
      assets: assets.filter((a) => a.type !== "investment"),
      balanceAnchors,
      binancePositions,
      binanceSinceDateKey,
      binanceSource: binanceSourceRow,
      coinPositions,
      coinSource,
      coinValuationCache,
      debtModel,
      earlyRepayments,
      exposureProfile,
      housingValuationCadence,
      isBackfillCandidate,
      isSnapshotCorrectionEligible,
      isBinanceHolding,
      isCoinCollection,
      investment,
      liability,
      operations,
      overrides,
      payouts,
      payoutSchedules,
      payoutMonthlySpendingMinor,
      position,
      priceCache,
      rateRevisions,
      scopes,
      selectedScope,
      twrMonthlyCloses,
      valuationCadence,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const {
    activeMembers,
    amortizationPlan,
    anchors,
    appreciationRate,
    asset,
    assetMethod,
    assets,
    balanceAnchors,
    binancePositions,
    binanceSinceDateKey,
    binanceSource,
    coinPositions,
    coinSource,
    coinValuationCache,
    currentModelledBalanceMinor,
    debtModel,
    earlyRepayments,
    exposureProfile,
    housingValuationCadence,
    isBackfillCandidate,
    isSnapshotCorrectionEligible,
    isBinanceHolding,
    isCoinCollection,
    investment,
    liability,
    operations,
    overrides,
    payouts,
    payoutSchedules,
    payoutMonthlySpendingMinor,
    position,
    priceCache,
    rateRevisions,
    scopes,
    selectedScope,
    twrMonthlyCloses,
    valuationCadence,
  } = storeData;

  if (!asset && !liability) {
    notFound();
  }

  const today = new Date().toISOString().slice(0, 10);
  const currentUrl = `/patrimonio/${id}/editar`;
  // Demo skips optimistic mutations — the write-guard rejects them (§10).
  const isDemo = await isDemoMode();

  // The holding's valuation method: an asset reads it off its instrument, a
  // liability off its debt model (#152). This single value dispatches the surface.
  const method: ValuationMethod = asset
    ? assetMethod!
    : valuationMethodOfLiability(debtModel);

  const warnings = asset ? collectWarnings([asset], overrides) : [];
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  // Bind the holding id to the operations actions so the `derived` surface posts
  // back to this detail page (#153 collapsed the /inversiones management routes;
  // the shared investment actions now live on under app/inversiones/actions.ts
  // and the ficha is the single place operations are recorded).
  async function boundRecordOperationAction(formData: FormData) {
    "use server";
    await recordOperationAction(id, formData);
  }

  async function boundDeleteOperationAction(formData: FormData) {
    "use server";
    await deleteOperationAction(id, formData);
  }

  async function boundPreviewStatementAction(
    prev: StatementPreviewState,
    formData: FormData,
  ) {
    "use server";
    return previewStatementAction(id, prev, formData);
  }

  async function boundConfirmStatementAction(formData: FormData) {
    "use server";
    await confirmStatementAction(id, formData);
  }

  async function boundPreviewPriceBackfillAction(
    prev: PriceBackfillPreviewState,
    formData: FormData,
  ) {
    "use server";
    return previewPriceBackfillAction(id, prev, formData);
  }

  async function boundConfirmPriceBackfillAction(formData: FormData) {
    "use server";
    await confirmPriceBackfillAction(id, formData);
  }

  async function boundPreviewSnapshotPriceCorrectionAction(
    prev: SnapshotPriceCorrectionPreviewState,
    formData: FormData,
  ) {
    "use server";
    return previewSnapshotPriceCorrectionAction(id, prev, formData);
  }

  async function boundConfirmSnapshotPriceCorrectionAction(formData: FormData) {
    "use server";
    await confirmSnapshotPriceCorrectionAction(id, formData);
  }

  async function boundUpdateInvestmentAction(formData: FormData) {
    "use server";
    await updateInvestmentAction(id, formData);
  }

  async function boundCreatePayoutAction(formData: FormData) {
    "use server";
    await createPayoutAction(id, formData);
  }

  async function boundDeletePayoutAction(formData: FormData) {
    "use server";
    await deletePayoutAction(id, formData);
  }

  async function boundCreatePayoutScheduleAction(formData: FormData) {
    "use server";
    await createPayoutScheduleAction(id, formData);
  }

  async function boundUpdatePayoutScheduleAction(formData: FormData) {
    "use server";
    await updatePayoutScheduleAction(id, formData);
  }

  async function boundDeletePayoutScheduleAction(formData: FormData) {
    "use server";
    await deletePayoutScheduleAction(id, formData);
  }

  const freshness =
    method === "derived" && priceCache
      ? getPriceFreshness(priceCache, persistence.checkedAt)
      : null;

  // Returns surface for a market investment (#551, ADR 0040): fold this holding's
  // operations + current market value through the return engine, framed by
  // instrument. Only a derived (operation-ledger) investment qualifies — a
  // coin/Binance holding mirrors positions, not operations, so it carries none.
  const isMarketInvestment =
    Boolean(asset) && method === "derived" && !isCoinCollection && !isBinanceHolding;
  const returnsView =
    isMarketInvestment && asset
      ? buildHoldingReturnsView({
          instrument: instrumentOfAsset(asset),
          irr: holdingIrr({
            currency: asset.currency,
            marketValueMinor: position?.marketValue?.amountMinor ?? 0,
            operations,
            valuationDate: today,
          }),
          simpleGain: simpleGain({
            currency: asset.currency,
            marketValueMinor: position?.marketValue?.amountMinor ?? 0,
            operations,
            valuationDate: today,
          }),
          twr:
            twrMonthlyCloses.length > 0
              ? holdingTwr({ monthlyCloses: twrMonthlyCloses, operations })
              : null,
          ...(position?.realizedPnl ? { realizedPnl: position.realizedPnl } : {}),
          ...(position?.unrealizedPnl ? { unrealizedPnl: position.unrealizedPnl } : {}),
        })
      : null;

  const holdingBenchmarkResult =
    isMarketInvestment && exposureProfile?.trackedIndex
      ? await buildHoldingBenchmarkComparison({
          distributing: investment?.benchmarkDistributing ?? false,
          monthlyCloses: twrMonthlyCloses,
          operations,
          readBenchmarkPrices: readBenchmarkPricesFromControlPlane,
          trackedIndex: exposureProfile.trackedIndex,
        })
      : null;

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
    >
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="formPage" aria-label="Editar holding">
        <div className="panelHeader">
          <h2>Editar {asset ? "activo" : "deuda"}</h2>
          <Link href={`/patrimonio#${id}`}>← Volver</Link>
        </div>

        {/* Active warnings for this holding */}
        {warnings.length > 0 ? (
          <div className="warningBand" role="alert" aria-label="Avisos">
            {warnings.map((w) => (
              <div className="warningItem" key={`${w.entityId}-${w.code}`}>
                <span>⚠ {w.message}</span>
                {w.severity === "overrideable" ? (
                  <form action={acknowledgeWarningAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="code" type="hidden" value={w.code} />
                    <input name="entityId" type="hidden" value={id} />
                    <button className="btnSmall btnWarning" type="submit">
                      Es intencional
                    </button>
                  </form>
                ) : (
                  <span className="blockingNote">No se puede ignorar</span>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {formError &&
        formError.formId !== "operation" &&
        formError.formId !== "payout" ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        <section className="editBasic" aria-labelledby="edit-basic-title">
          <h3 id="edit-basic-title">Lo básico</h3>
          {asset ? (
            <AssetEditForm
              asset={asset}
              investment={investment}
              isBinanceHolding={isBinanceHolding}
              isCoinCollection={isCoinCollection}
              members={activeMembers}
              method={method}
              privacyMode={privacyMode}
              scopeMemberId={ownershipScopeMemberId}
              updateInvestmentAction={boundUpdateInvestmentAction}
              values={formError?.formId === "edit" ? formError.values : {}}
            />
          ) : liability ? (
            <LiabilityEditForm
              assets={assets}
              liability={liability}
              members={activeMembers}
              scopeMemberId={ownershipScopeMemberId}
              values={formError?.formId === "edit" ? formError.values : {}}
            />
          ) : null}
        </section>

        <details className="editAdvanced">
          <summary>Configuración avanzada</summary>
          <div className="editAdvancedBody">
            {/* ── Method-dispatched configuration surface (#152, ADR 0014) ───── */}

            {/* coin_collection: the Numista catalogue (variant B) — derived, but its
                sub-detail is mirrored positions, not operations (PRD #160, ADR 0016). */}
            {asset && isCoinCollection ? (
              <CoinCollectionSection
                currentUrl={currentUrl}
                lastSyncAt={coinSource?.lastSyncAt ?? null}
                positions={coinPositions}
                privacyMode={privacyMode}
                sourceId={coinSource?.id ?? null}
                valuationFreshness={coinValuationCache?.freshnessState ?? null}
                valuationStaleReason={coinValuationCache?.staleReason ?? null}
              />
            ) : null}

            {/* crypto + binance source: the read-only token list — derived, but its
                sub-detail is mirrored token positions, not operations (PRD #245, ADR 0021). */}
            {asset && isBinanceHolding ? (
              <BinanceHoldingSection
                currentUrl={currentUrl}
                lastSyncAt={binanceSource?.lastSyncAt ?? null}
                positions={binancePositions}
                privacyMode={privacyMode}
                sinceDateKey={binanceSinceDateKey}
                sourceId={binanceSource?.id ?? null}
              />
            ) : null}

            {/* derived + priced: on-demand provider refresh for just this holding
                (#406) — the narrow counterpart to the global /patrimonio trigger.
                Hidden when the holding has no price provider (manual/stored). */}
            {asset &&
            method === "derived" &&
            !isCoinCollection &&
            !isBinanceHolding &&
            investment?.providerSymbol ? (
              <PriceRefreshControl
                action={refreshPricesAction}
                assetId={asset.id}
                currentUrl={currentUrl}
                label="Actualizar precio"
                pendingLabel="Actualizando…"
              />
            ) : null}

            {/* derived: the returns surface — three measures + realized/unrealized
                split + honest caveats (#551, ADR 0040), above the operations ledger. */}
            {returnsView ? (
              <ReturnsPanel privacyMode={privacyMode} view={returnsView} />
            ) : null}

            {holdingBenchmarkResult && exposureProfile?.trackedIndex ? (
              <HoldingBenchmarkComparisonCard
                result={holdingBenchmarkResult}
                trackedIndex={exposureProfile.trackedIndex}
              />
            ) : null}

            {/* derived: the investment's operations editor (the single place units change) */}
            {asset && method === "derived" && !isCoinCollection && !isBinanceHolding ? (
              <OperationsEditor
                assetId={id}
                assetName={asset.name}
                context={{
                  ...(position ? { currentUnits: position.currentUnits } : {}),
                  ...(priceCache
                    ? {
                        unitPrice: priceCache.price,
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
                  ...(position?.unrealizedPnl
                    ? { unrealizedPnl: position.unrealizedPnl }
                    : {}),
                }}
                currentUrl={currentUrl}
                deleteAction={boundDeleteOperationAction}
                formError={formError}
                operations={operations}
                privacyMode={privacyMode}
                readOnly={isDemo}
                recordAction={boundRecordOperationAction}
                today={today}
              />
            ) : null}

            {/* derived: load operations from a broker statement (ADR 0018, #174/#176) */}
            {asset && method === "derived" && !isCoinCollection && !isBinanceHolding ? (
              <StatementUploadSection
                confirmAction={boundConfirmStatementAction}
                currentUrl={currentUrl}
                previewAction={boundPreviewStatementAction}
              />
            ) : null}

            {/* derived + candidate: the explicit historical-price backfill (#380, ADR 0033) */}
            {asset &&
            method === "derived" &&
            !isCoinCollection &&
            !isBinanceHolding &&
            isBackfillCandidate ? (
              <PriceBackfillSection
                confirmAction={boundConfirmPriceBackfillAction}
                currentUrl={currentUrl}
                previewAction={boundPreviewPriceBackfillAction}
              />
            ) : null}

            {/* derived + operations: correct one daily snapshot's unit price (#926) */}
            {asset &&
            method === "derived" &&
            !isCoinCollection &&
            !isBinanceHolding &&
            isSnapshotCorrectionEligible ? (
              <SnapshotPriceCorrectionSection
                confirmAction={boundConfirmSnapshotPriceCorrectionAction}
                currentUrl={currentUrl}
                previewAction={boundPreviewSnapshotPriceCorrectionAction}
                today={today}
                {...(priceCache?.price ? { defaultUnitPrice: priceCache.price } : {})}
              />
            ) : null}

            {/* Cobros: dividends / interest / rent this asset pays its owner — a pure
                attribution record, never a figure (PRD #652 S1, #656, ADR 0054).
                Shown for every asset (income-side); never for a liability. */}
            {asset ? (
              <CobrosSection
                createPayoutAction={boundCreatePayoutAction}
                createPayoutScheduleAction={boundCreatePayoutScheduleAction}
                currency={asset.currency}
                currentUrl={currentUrl}
                deletePayoutAction={boundDeletePayoutAction}
                deletePayoutScheduleAction={boundDeletePayoutScheduleAction}
                error={formError?.formId === "payout" ? formError.message : null}
                monthlySpendingMinor={payoutMonthlySpendingMinor}
                payouts={payouts}
                privacyMode={privacyMode}
                schedules={payoutSchedules}
                today={today}
                updatePayoutScheduleAction={boundUpdatePayoutScheduleAction}
              />
            ) : null}

            {/* appreciating: the housing valuation curve + appraisals */}
            {asset && method === "appreciating" ? (
              <HousingValuationSection
                anchors={anchors}
                appreciationRate={appreciationRate}
                assetId={asset.id}
                formError={formError}
                privacyMode={privacyMode}
                today={today}
                valuationCadence={housingValuationCadence}
              />
            ) : null}

            {/* amortized / anchored: the debt-model editor (the selector fans out within) */}
            {liability ? (
              <DebtModelSection
                amortizationPlan={amortizationPlan}
                balanceAnchors={balanceAnchors}
                currentModelledBalanceMinor={currentModelledBalanceMinor}
                debtModel={debtModel}
                earlyRepayments={earlyRepayments}
                formError={formError}
                liabilityId={id}
                privacyMode={privacyMode}
                rateRevisions={rateRevisions}
                today={today}
                valuationCadence={valuationCadence}
              />
            ) : null}
          </div>
        </details>

        {/* Danger zone — two-step delete */}
        <div className="dangerZone">
          <h3>Zona de peligro</h3>
          {asset ? (
            <form action={deleteAssetAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar activo</summary>
                <p>El activo se moverá a la Papelera y podrás recuperarlo.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          ) : (
            <form action={deleteLiabilityAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar deuda</summary>
                <p>La deuda se moverá a la Papelera y podrás recuperarla.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          )}
        </div>
      </section>
    </Shell>
  );
}
