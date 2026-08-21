import OperationsEditor from "@web/_components/operations-editor";
import { buildHoldingBenchmarkComparison } from "@web/build-holding-benchmark";
import { isDemoMode } from "@web/demo/write-guard";
import HoldingBenchmarkComparisonCard from "@web/holding-benchmark-comparison-card";
import {
  holdingBoardHref,
  holdingDetailHref,
  holdingPublicIdIndex,
  resolveHoldingRoute,
} from "@web/holding-route";
import { parseFormError, resolveOkMessage } from "@web/intake";
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
import { recordTransferAction } from "@web/inversiones/transfer-action";
import { resolvePageShell } from "@web/page-shell";
import { acknowledgeWarningAction } from "@web/patrimonio/actions";
import { PriceRefreshControl } from "@web/patrimonio/price-refresh-control";
import { detailRefreshCaption } from "@web/price-refresh";
import { readBenchmarkPricesFromControlPlane } from "@web/read-benchmark-prices";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import type {
  CoinPosition,
  DebtBalanceAtDateInput,
  ValuationMethod,
} from "@worthline/domain";
import {
  buildHoldingReturnsView,
  collectWarnings,
  debtAccrualAtDate,
  debtBalanceAtDate,
  detectSingleAssetBackfillCandidate,
  detectValueOnlyOpening,
  getPriceFreshness,
  holdingIrr,
  holdingTrashImpact,
  holdingTwr,
  instrumentOfAsset,
  lastCapturedCurrency,
  monthlyCloseValuesFromSnapshotRows,
  netUnitsByAsset,
  simpleGain,
  storedBalanceGovernsDebtFigure,
  usableCachedPrice,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "@worthline/domain";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BinanceHoldingSection } from "./_surfaces/binance-holding-section";
import { tokenPositionsOnRung } from "./_surfaces/binance-holding-view";
import { CobrosSection } from "./_surfaces/cobros-section";
import { CoinCollectionSection } from "./_surfaces/coin-collection-section";
import { DangerZoneSection } from "./_surfaces/danger-zone-section";
import { DebtModelSection } from "./_surfaces/debt-model-section";
import { AssetEditForm, LiabilityEditForm } from "./_surfaces/holding-forms";
import { HousingValuationSection } from "./_surfaces/housing-valuation-section";
import { PriceBackfillSection } from "./_surfaces/price-backfill-section";
import { ReturnsPanel } from "./_surfaces/returns-panel";
import { SnapshotPriceCorrectionSection } from "./_surfaces/snapshot-price-correction-section";
import { StatementUploadSection } from "./_surfaces/statement-upload-section";
import { transferDestinationOptions } from "./_surfaces/transfer-form";
import TransferSection from "./_surfaces/transfer-section";

/** The forms that render their own error band, next to the field that produced it. */
const SECTIONS_WITH_OWN_ERROR_BAND = ["operation", "payout", "transfer"];

/**
 * Block (#1229): this route opts out of Instant Navigations validation.
 * Soft-click shell prefetching is not the goal here — see the route table on
 * issue #1229 for the why.
 */
export const instant = false;

type Params = Promise<{ id: string }>;

export default async function EditarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: publicId } = await params;
  const resolvedSearchParams = await searchParams;
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const { persistence, privacyMode, selectedScope, store, workspace } =
    await resolvePageShell({ searchParams: resolvedSearchParams });

  // Independent base reads — one wave instead of serial round-trips (#446).
  const [allAssets, liabilities, overrides, publicIds] = await Promise.all([
    store.assets.readAssets(),
    store.liabilities.readLiabilities(),
    store.readWarningOverrides(),
    store.agentView.readPublicIds(),
  ]);

  // The route names the holding by its public `wl_hld_…` id (#1318) — the same
  // id the agent view and the MCP take, so what the user (or the assistant
  // reading `screenContext`) has in the URL bar is directly actionable. The
  // internal storage id is resolved here and never leaves the server.
  const resolvedId = resolveHoldingRoute(publicId, holdingPublicIdIndex(publicIds));

  if (resolvedId === null) {
    notFound();
  }
  const id: string = resolvedId;

  const asset = allAssets.find((a) => a.id === id) ?? null;
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
    ? ((await store.connectedSources.listSources()).find((s) => s.assetId === id) ?? null)
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
  // The whole positions list is kept, not just this holding's: the traspaso picker
  // (#1480) prefills each candidate destination's VL from its last known price, and
  // that is the same wave — a query per candidate would be an N+1 for a prefill.
  const [investment, operations, priceCache, positions, twrSnapshotRows] = isDerived
    ? await Promise.all([
        store.assets.readInvestmentAssetById(id),
        store.operations.readOperations(id),
        store.operations.readPriceCache(id),
        store.snapshots.readPositions(),
        store.snapshots.readSnapshotHoldings({
          holdingId: id,
          kind: "asset",
          scopeId: "household",
        }),
      ])
    : [null, [], null, [], []];
  const position = positions.find((p) => p.assetId === id) ?? null;
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
  // The traspaso picker's candidates (#1480): the workspace's other ledger-keeping
  // holdings in the same currency, off the assets and positions already read.
  const transferDestinations =
    isDerived && asset
      ? transferDestinationOptions(allAssets, positions, {
          assetId: id,
          currency: asset.currency,
        })
      : [];
  const isSnapshotCorrectionEligible =
    isDerived && investment !== null && operations.length > 0;
  // #1329: the «alta por valor total» state — 1 participación holding the whole
  // declared value — but only while it has no symbol. With one, the quote already
  // governs the valuation and the warning would be an obituary, not a guard.
  const valueOnlyOpening =
    investment !== null && !investment.providerSymbol
      ? detectValueOnlyOpening(operations)
      : null;
  const twrMonthlyCloses = monthlyCloseValuesFromSnapshotRows(twrSnapshotRows);

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

  // Cobros (PRD #652 S1, #656, ADR 0054): a payout is a pure attribution record
  // on an asset holding — never a figure. Read this holding's one-off payouts +
  // declared schedules, plus the scope's declared monthly spending (for the
  // renta-pasiva coverage; omitted gracefully when the scope has no FIRE figure).
  const payouts = asset ? await store.payouts.readPayoutsForHolding(id) : [];
  const payoutSchedules = asset
    ? await store.payouts.readPayoutSchedulesForHolding(id)
    : [];
  const today = new Date().toISOString().slice(0, 10);
  const scopeFireConfig =
    asset && selectedScope
      ? (await store.readFireConfig(today))[selectedScope.id]
      : undefined;
  const payoutMonthlySpendingMinor = scopeFireConfig?.monthlySpendingMinor ?? null;

  // amortized / anchored: the debt-model data (PRD #109).
  const debtModel = liability ? await store.liabilities.readDebtModel(id) : null;
  // Plan + re-baselines are independent reads off the liability id — one wave.
  // Both are needed: a re-baseline alone can govern the curve with no plan row
  // (ADR 0056; the #678 review's imported-current-state case).
  const [amortizationPlan, balanceRebaselines] =
    liability && debtModel === "amortizable"
      ? await Promise.all([
          store.liabilities.readAmortizationPlan(id),
          store.liabilities.readBalanceRebaselines(id),
        ])
      : [null, []];
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
  // The curve inputs of an amortizable debt, assembled ONCE from the rows read
  // above. Both figures below come out of this same object, so the balance and
  // its accrual provably describe one curve — and the second figure costs no
  // extra I/O, where `store.liabilities.debtBalanceAtDate` would re-read every
  // row this page already holds (#1292).
  const debtCurveInput =
    liability &&
    debtModel === "amortizable" &&
    (amortizationPlan || balanceRebaselines.length > 0)
      ? ({
          balanceRebaselines,
          currentBalanceMinor: liability.currentBalance.amountMinor,
          debtModel,
          earlyRepayments: earlyRepayments.map((repayment) => ({
            amountMinor: repayment.amountMinor,
            mode: repayment.mode,
            repaymentDate: repayment.repaymentDate,
          })),
          revisions: rateRevisions.map((revision) => ({
            newAnnualInterestRate: revision.newAnnualInterestRate,
            revisionDate: revision.revisionDate,
          })),
          targetDate: today,
          ...(amortizationPlan
            ? {
                plan: {
                  annualInterestRate: amortizationPlan.annualInterestRate,
                  disbursementDate: amortizationPlan.disbursementDate,
                  firstPaymentDate: amortizationPlan.firstPaymentDate,
                  initialCapitalMinor: amortizationPlan.initialCapitalMinor,
                  termMonths: amortizationPlan.termMonths,
                },
              }
            : {}),
          ...(valuationCadence != null ? { cadence: valuationCadence } : {}),
        } satisfies DebtBalanceAtDateInput)
      : null;
  // The current MODELLED balance, shown beside "Recalibrar con saldo real"
  // (ADR 0056, PRD #670 S3, #678) so the drift against the bank's real figure
  // is visible at the moment of repair — meaningful as soon as a CURVE exists,
  // plan row or re-baseline alike (#1290: with the raw balance form gone for a
  // curved debt, this is the only balance the detail shows).
  const currentModelledBalanceMinor = debtCurveInput
    ? debtBalanceAtDate(debtCurveInput)
    : null;
  // …and what has accrued on it since the last cuota, so the surface can name
  // WHICH magnitude the user is comparing with the bank's screen (#1292).
  const currentDebtAccrual = debtCurveInput ? debtAccrualAtDate(debtCurveInput) : null;
  // Which door repairs this debt's balance (#1290): the raw
  // `current_balance_minor` form only when the engine still reads that field.
  const showRawBalanceForm = storedBalanceGovernsDebtFigure({
    debtModel,
    hasAmortizationPlan: amortizationPlan !== null,
    hasBalanceAnchors: balanceAnchors.length > 0,
    hasBalanceRebaselines: balanceRebaselines.length > 0,
  });

  const activeMembers = workspace.members.filter((m) => !m.disabledAt);
  const assets = allAssets.filter((a) => a.type !== "investment");
  const binanceSource = binanceSourceRow;

  if (!asset && !liability) {
    notFound();
  }

  const currentUrl = holdingDetailHref(publicId);
  const boardHref = holdingBoardHref(publicId);
  // Demo skips optimistic mutations — the write-guard rejects them (§10).
  const isDemo = await isDemoMode();

  // The holding's valuation method: an asset reads it off its instrument, a
  // liability off its debt model (#152). This single value dispatches the surface.
  const method: ValuationMethod = asset
    ? assetMethod!
    : valuationMethodOfLiability(debtModel);

  // Reads the same closed-position filter as the board and the health engine
  // (#1348): once the position is sold out, the ficha stops asking for a price
  // symbol it no longer needs. `operations` is empty for a non-derived holding,
  // which `netUnitsByAsset` leaves out of the map — absent means open.
  const warnings = asset
    ? collectWarnings([asset], overrides, {
        netUnitsByAssetId: netUnitsByAsset(new Map([[id, operations]])),
      })
    : [];
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  // What the Papelera would take with it (#1365). Reads the position this page
  // already derived — no extra I/O — so the figure in the confirmation is the same
  // one the ficha shows above it. Null for a sold-out position (and for every
  // holding with no operations ledger), which is what keeps the clean delete clean.
  const trashImpact = holdingTrashImpact(position);
  // The sale link in that notice returns HERE with the advanced block unfolded
  // (interaction-patterns §3: the state is read from the URL on load). A bare
  // fragment would scroll to a collapsed <details> and reveal nothing.
  const advancedOpen = resolvedSearchParams?.abrir === "operaciones";

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

  async function boundRecordTransferAction(formData: FormData) {
    "use server";
    await recordTransferAction(id, formData);
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
  // The cached row's price when it IS a price: a `failed` row carries "0" as the
  // marker for "no price known" (#1330), and showing that zero as this holding's
  // last price contradicts the cost-basis figure beside it.
  const usablePrice = priceCache ? usableCachedPrice(priceCache) : null;

  // Returns surface for a market investment (#551, ADR 0040): fold this holding's
  // operations + current market value through the return engine, framed by
  // instrument. Only a derived (operation-ledger) investment qualifies — a
  // coin/Binance holding mirrors positions, not operations, so it carries none.
  const isMarketInvestment =
    Boolean(asset) && method === "derived" && !isCoinCollection && !isBinanceHolding;
  // An unpriced position (a symbol whose first quote has not landed yet) enters the
  // engine at its cost basis — the valuation authority's own fallback — so the panel
  // never fabricates a −100% while the valuation beside it reads the cost (#1314).
  const returnsMarketValueMinor =
    position?.marketValue?.amountMinor ?? position?.costBasis.amountMinor ?? 0;
  const returnsView =
    isMarketInvestment && asset
      ? buildHoldingReturnsView({
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
    <>
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="formPage" aria-label="Editar holding">
        <div className="panelHeader">
          <h2>Editar {asset ? "activo" : "deuda"}</h2>
          <Link href={holdingBoardHref(publicId)}>← Volver</Link>
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

        {/* The page-level band carries only the errors NO section prints itself. The
            list is the seam: a section that grows its own band adds itself here, and
            the reader sees at a glance which forms speak for themselves. */}
        {formError && !SECTIONS_WITH_OWN_ERROR_BAND.includes(formError.formId ?? "") ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        <section className="editBasic" aria-labelledby="edit-basic-title">
          <h3 id="edit-basic-title">Lo básico</h3>
          {asset ? (
            <AssetEditForm
              asset={asset}
              boardHref={boardHref}
              currentUrl={currentUrl}
              investment={investment}
              isBinanceHolding={isBinanceHolding}
              isCoinCollection={isCoinCollection}
              members={activeMembers}
              method={method}
              privacyMode={privacyMode}
              scopeMemberId={ownershipScopeMemberId}
              updateInvestmentAction={boundUpdateInvestmentAction}
              valueOnlyOpening={valueOnlyOpening}
              values={formError?.formId === "edit" ? formError.values : {}}
            />
          ) : liability ? (
            <LiabilityEditForm
              assets={assets}
              boardHref={boardHref}
              currentUrl={currentUrl}
              liability={liability}
              members={activeMembers}
              scopeMemberId={ownershipScopeMemberId}
              showRawBalanceForm={showRawBalanceForm}
              values={formError?.formId === "edit" ? formError.values : {}}
            />
          ) : null}
        </section>

        <details suppressHydrationWarning className="editAdvanced" open={advancedOpen}>
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
                  ...(position?.currencyWarning
                    ? { currencyWarning: position.currencyWarning }
                    : {}),
                  ...(priceCache
                    ? {
                        // A `failed` row carries price "0" as the marker for "no
                        // price known" (#1330): show the failure, never the zero
                        // as if it were this holding's last price.
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
                  ...(position?.unrealizedPnl
                    ? { unrealizedPnl: position.unrealizedPnl }
                    : {}),
                }}
                currentUrl={currentUrl}
                // The currency this ledger last captured an apunte in (#1401), so a
                // dollar fund does not ask for it again on every purchase.
                defaultCurrency={lastCapturedCurrency(operations)}
                deleteAction={boundDeleteOperationAction}
                formError={formError}
                operations={operations}
                privacyMode={privacyMode}
                readOnly={isDemo}
                recordAction={boundRecordOperationAction}
                today={today}
              />
            ) : null}

            {/* derived: «Traspasar» — one screen, one submit for a fund-to-fund
                traspaso (#1480, PRD #1393). Offered whenever the holding HAS a ledger,
                not whenever it has units today: a traspaso is routinely recorded weeks
                later, and the one that emptied the holding is exactly the row that is
                still missing. The ledger travels so the preview can fold it at the
                date the user picks (#1438). */}
            {asset &&
            method === "derived" &&
            !isCoinCollection &&
            !isBinanceHolding &&
            operations.length > 0 ? (
              <TransferSection
                currentUrl={currentUrl}
                destinations={transferDestinations}
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
                recordAction={boundRecordTransferAction}
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
                {...(usablePrice !== null ? { defaultUnitPrice: usablePrice } : {})}
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
                currentUrl={currentUrl}
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
                currentDebtAccrual={currentDebtAccrual}
                currentModelledBalanceMinor={currentModelledBalanceMinor}
                debtModel={debtModel}
                earlyRepayments={earlyRepayments}
                currentUrl={currentUrl}
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

        {/* Danger zone — two-step delete, with the truth about what it withdraws */}
        {asset ? (
          <DangerZoneSection
            currentUrl={currentUrl}
            holdingId={id}
            kind="asset"
            privacyMode={privacyMode}
            trashImpact={trashImpact}
          />
        ) : (
          <DangerZoneSection
            currentUrl={currentUrl}
            holdingId={id}
            kind="liability"
            privacyMode={privacyMode}
          />
        )}
      </section>
    </>
  );
}
