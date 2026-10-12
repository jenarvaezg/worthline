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

import { OperationRecordForm } from "@web/_components/operation-record-form";
import { OperationsBookProvider } from "@web/_components/operations-book";
import { OperationsLedger } from "@web/_components/operations-ledger";
import {
  formatMeasurePct,
  formatRatioPct,
  signClass,
} from "@web/_components/returns-format";
import { transferCounterpartByOperationId } from "@web/_components/transfer-counterparts";
import { buildHoldingBenchmarkComparison } from "@web/build-holding-benchmark";
import HoldingBenchmarkComparisonCard from "@web/holding-benchmark-comparison-card";
import { priceFreshnessLabel } from "@web/intake";
import { refreshPricesAction } from "@web/inversiones/refresh-prices-action";
import { fichaTabUrl } from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import ExternalEntrySection from "@web/patrimonio/[id]/editar/_surfaces/external-entry-section";
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
import type { CurrencyCode, DecimalString } from "@worthline/domain";
import {
  costBasisGradeMark,
  declaredSecurityId,
  detectSingleAssetBackfillCandidate,
  detectValueOnlyOpening,
  exposureLookthroughKey,
  formatMoneyMinorPrivacy,
  formatPrice,
  formatUnits,
  getPriceFreshness,
  holdingReturns,
  holdingTrashImpact,
  INSTRUMENT_LABELS_ES,
  instrumentOfAsset,
  lastCapturedCurrency,
  maskMoneyString,
  monthlyCloseValuesByHolding,
  usableCachedPrice,
  VALUE_ONLY_PNL_NOTICE,
} from "@worthline/domain";
import type {
  AssetFamilyContext,
  FichaAction,
  FichaFigure,
  HoldingSurface,
} from "./family-contract";
import { holdingSurface } from "./family-contract";
import { bindInvestmentActions } from "./investment-actions";

/** The investment's own tabs; the page appends «Datos del activo». */
const TABS = ["operaciones", "rentabilidad", "cobros"] as const;

/** A unit price as the ficha prints it: the ledger's price voice, then the currency. */
function unitPrice(price: DecimalString, currency: CurrencyCode, privacyMode: boolean) {
  const formatted = formatPrice(price);
  const shown = privacyMode ? maskMoneyString(formatted) : formatted;
  return `${shown} ${currency === "EUR" ? "€" : currency}`;
}

export async function loadInvestmentSurface(
  ctx: AssetFamilyContext,
): Promise<HoldingSurface> {
  const {
    allAssets,
    archiveOriginAfterTransfer,
    asset,
    baseCurrency,
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
  const instrument = instrumentOfAsset(asset);

  // Exposure profile read for benchmark comparison (catalog #711 S3): keyed by
  // the security's identity from the global catalog now that workspace hand-entry
  // was retired (#1014 S5). Una clave por estado (#1743), nunca el valor crudo.
  const exposureProfileKey = investment
    ? exposureLookthroughKey({
        providerSymbol: investment.providerSymbol ?? null,
        securityId: declaredSecurityId(investment.securityId),
      })
    : null;
  const exposureProfile = exposureProfileKey
    ? ((await readExposureProfilesFromCatalog()).find(
        (profile) => profile.key === exposureProfileKey,
      ) ?? null)
    : null;

  const freshness = priceCache ? getPriceFreshness(priceCache, checkedAt) : null;
  // The cached row's price when it IS a price: a `failed` row carries "0" as the
  // marker for "no price known" (#1330), and offering that zero as the correction's
  // starting figure contradicts the cost-basis value beside it.
  const usablePrice = priceCache ? usableCachedPrice(priceCache) : null;

  // The holding's returns through the SAME fold the board's row runs, on the same
  // reads — cached price, manual quote, monthly closes, recorded payouts, base
  // currency — so «Ganancia total» here is that row's figure, not a neighbour of
  // it (#1826, #1422). The value and the price on the header come out of the same
  // call: an unpriced holding is valued at its cost, never a fabricated −100%
  // (#1314). The realized/unrealized split only adds lines for «Rentabilidad».
  const { valuation, view: returnsView } = holdingReturns({
    assetId: id,
    cachedPrice: priceCache?.price,
    currency: baseCurrency,
    instrument,
    manualPrice: investment?.manualPricePerUnit,
    operations,
    payouts: payoutsPanel.datedPayouts,
    split: {
      ...(position?.realizedPnl ? { realizedPnl: position.realizedPnl } : {}),
      ...(position?.unrealizedPnl ? { unrealizedPnl: position.unrealizedPnl } : {}),
    },
    valuationDate: today,
    ...(twrMonthlyCloses.length > 0 ? { monthlyCloses: twrMonthlyCloses } : {}),
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
  // Where each form returns: the tab its result shows on (#1826).
  const tabUrl = (tab: (typeof TABS)[number]) => fichaTabUrl(currentUrl, TABS, tab);

  // ── The state header ────────────────────────────────────────────────────────
  const money = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency: baseCurrency }, privacyMode);
  const gainRatio = returnsView?.totalReturnRatio ?? null;
  const irrRate = returnsView?.irr?.rate ?? null;
  const figures: FichaFigure[] = [
    {
      detail: (
        <>
          {/* Where the price comes from and how fresh it is, as the editor said it;
              the engine's own origin and date are #1828. */}
          {priceCache ? (
            <small className={`priceStatus ${freshness ?? "unknown"}`}>
              {priceFreshnessLabel(freshness)}
            </small>
          ) : null}
          {priceCache && priceCache.source !== "manual" ? (
            <small className="priceRefreshCaption">
              {detailRefreshCaption(priceCache.fetchedAt, priceCache.source)}
            </small>
          ) : null}
          {valuation.pricePerUnit === undefined ? (
            <small className="priceRefreshCaption">
              Sin precio: se valora a lo que costó.
            </small>
          ) : null}
          {/* On-demand provider refresh for just this holding (#406) — the narrow
              counterpart to the global /patrimonio trigger. Only with a symbol. */}
          {investment?.providerSymbol ? (
            <PriceRefreshControl
              action={refreshPricesAction}
              assetId={asset.id}
              currentUrl={currentUrl}
              label="Actualizar precio"
              pendingLabel="Actualizando…"
            />
          ) : null}
        </>
      ),
      key: "units",
      label: "Participaciones",
      value: (
        <>
          {formatUnits(position?.currentUnits ?? "0")}
          {valuation.pricePerUnit !== undefined
            ? ` × ${unitPrice(valuation.pricePerUnit, baseCurrency, privacyMode)}`
            : null}
        </>
      ),
    },
    {
      // The board row's figure, by the same rule: no ratio, no claim (#551).
      ...(returnsView && gainRatio !== null
        ? {
            tone: gainRatio >= 0 ? ("pos" as const) : ("neg" as const),
            value: `${money(returnsView.totalGain.amountMinor)} · ${formatRatioPct(gainRatio)}`,
          }
        : { value: "—" }),
      // A cost nobody declared is said beside the figure measured against it (#1505).
      ...(returnsView?.costBasisGrade === "value_only"
        ? {
            detail: (
              <small className="priceRefreshCaption">
                {costBasisGradeMark(returnsView.costBasisGrade)}
              </small>
            ),
          }
        : {}),
      key: "gain",
      label: "Ganancia total",
    },
    {
      ...(signClass(irrRate) ? { tone: signClass(irrRate) as "pos" | "neg" } : {}),
      key: "irr",
      label: (
        <>
          Rentabilidad anual{" "}
          <abbr title="Tasa interna de retorno: cuenta cuándo pusiste cada euro">
            TIR
          </abbr>
        </>
      ),
      value: formatMeasurePct(irrRate),
    },
  ];

  // ── The actions, each a form in the side panel ─────────────────────────────
  const actions: FichaAction[] = [
    {
      // The one door through which units change (ADR 0006).
      content: (
        <OperationRecordForm
          assetId={id}
          currentUrl={tabUrl("operaciones")}
          // The currency this ledger last captured an apunte in (#1401), so a
          // dollar fund does not ask for it again on every purchase.
          defaultCurrency={lastCapturedCurrency(operations)}
          formError={formError}
          heldUnits={position?.currentUnits ?? "0"}
          readOnly={isDemo}
          recordAction={action.recordOperation}
          today={today}
        />
      ),
      key: "operacion",
      label: "Registrar operación",
      tier: "primary",
    },
  ];
  if (hasManualLedger) {
    // «Traspasar» — one screen, one submit for a fund-to-fund traspaso (#1480,
    // PRD #1393). The ledger travels so the preview can fold it at the date the
    // user picks (#1438).
    actions.push({
      content: (
        <TransferSection
          archiveOrigin={archiveOriginAfterTransfer}
          currentUrl={tabUrl("operaciones")}
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
            // Lo que ES el origen: el destino que se cree hereda su instrumento, y de
            // él sale QUÉ identificador pide el panel de «crear destino» (#1772).
            ...(asset.instrument ? { instrument: asset.instrument } : {}),
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
      ),
      key: "traspaso",
      label: "Traspasar",
      tier: "secondary",
    });
  }
  actions.push({
    content: payoutsPanel.entry(tabUrl("cobros")),
    key: "cobro",
    label: "Añadir cobro",
    tier: "secondary",
  });
  if (hasManualLedger) {
    // «Traer de otra entidad» (#1518): the movilización that arrives at a holding
    // this book ALREADY keeps. Gated on the same manual ledger as «Traspasar» — a
    // connected holding's rows come from its provider — because the two are the
    // same movement seen from its two ends, one of which has no origin to name.
    actions.push({
      content: (
        <ExternalEntrySection
          currentUrl={tabUrl("operaciones")}
          formError={formError}
          holdingName={asset.name}
          readOnly={isDemo}
          recordAction={action.recordExternalEntry}
          today={today}
        />
      ),
      key: "entrada",
      label: "Traer de otra entidad",
      tier: "more",
    });
  }
  // Load operations from a broker statement (ADR 0018, #174/#176). Free here.
  actions.push({
    content: (
      <StatementUploadSection
        confirmAction={action.confirmStatement}
        currentUrl={tabUrl("operaciones")}
        previewAction={action.previewStatement}
      />
    ),
    key: "extracto",
    label: "Cargar movimientos",
    tier: "more",
  });
  if (isBackfillCandidate) {
    // The explicit historical-price backfill (#380, ADR 0033).
    actions.push({
      content: (
        <PriceBackfillSection
          confirmAction={action.confirmPriceBackfill}
          currentUrl={tabUrl("rentabilidad")}
          previewAction={action.previewPriceBackfill}
        />
      ),
      key: "historico",
      label: "Rellenar histórico de precios",
      tier: "more",
    });
  }
  if (investment !== null && operations.length > 0) {
    // Correct one daily snapshot's unit price (#926).
    actions.push({
      content: (
        <SnapshotPriceCorrectionSection
          confirmAction={action.confirmSnapshotPriceCorrection}
          currentUrl={tabUrl("rentabilidad")}
          previewAction={action.previewSnapshotPriceCorrection}
          today={today}
          {...(usablePrice !== null ? { defaultUnitPrice: usablePrice } : {})}
        />
      ),
      key: "correccion",
      label: "Corregir precio de un día",
      tier: "more",
    });
  }

  return holdingSurface("investment", {
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
    ficha: {
      actions,
      errorTargets: {
        externalEntry: { action: "entrada" },
        // The no-JS terminal of the record form; with JS its refusal comes back
        // as state and the panel never closed (#1311).
        operation: { action: "operacion" },
        payout: { tab: "cobros" },
        statement: { action: "extracto" },
        transfer: { action: "traspaso" },
      },
      figures,
      instrument: INSTRUMENT_LABELS_ES[instrument],
      tabs: [
        {
          content: (
            <>
              {/* The engine says the cost cannot be trusted (#1401): said next to
                  the operations it is about, in the voice of a refusal, because the
                  figures above are wrong until one of these rows is fixed. */}
              {position?.currencyWarning ? (
                <p className="errorBand" role="alert">
                  {position.currencyWarning}
                </p>
              ) : null}
              {/* The cost the position is measured against was never declared
                  (#1505). Said HERE because this is the only surface that can repair
                  it: borrar la apertura y registrarla con lo que de verdad costó. */}
              {position?.costBasisGrade === "value_only" ? (
                <p className="warningBand">{VALUE_ONLY_PNL_NOTICE}</p>
              ) : null}
              <OperationsLedger
                currentUrl={tabUrl("operaciones")}
                deleteAction={action.deleteOperation}
                privacyMode={privacyMode}
                readOnly={isDemo}
                // The traspaso rows' counterpart names (#1481): this ledger's halves
                // joined with the store's counterpart map and the live holdings'
                // names. A counterpart whose holding is not in `allAssets`
                // (Papelera) resolves as `unresolved` — the row claims nothing
                // rather than mislabelling it as external.
                transferCounterparts={transferCounterpartByOperationId(
                  operations,
                  counterparts,
                  new Map(allAssets.map((a) => [a.id, a.name])),
                )}
              />
            </>
          ),
          count: operations.length,
          key: "operaciones",
          label: "Operaciones",
        },
        {
          content: (
            <>
              {/* Three measures + realized/unrealized split + honest caveats
                  (#551, ADR 0040). */}
              {returnsView ? (
                <ReturnsPanel privacyMode={privacyMode} view={returnsView} />
              ) : (
                <p className="emptyLine">Sin rentabilidad que medir todavía.</p>
              )}
              {benchmarkResult && exposureProfile?.trackedIndex ? (
                <HoldingBenchmarkComparisonCard
                  result={benchmarkResult}
                  trackedIndex={exposureProfile.trackedIndex}
                />
              ) : null}
            </>
          ),
          key: "rentabilidad",
          label: "Rentabilidad",
        },
        {
          content: payoutsPanel.record(tabUrl("cobros")),
          count: payoutsPanel.count,
          key: "cobros",
          label: "Cobros",
        },
      ],
      value: money(valuation.valueMinor),
      // The record form and the ledger are in different places now and still one
      // list: the row being recorded shows in the tab before its action resolves.
      wrap: (ficha) => (
        <OperationsBookProvider operations={operations}>{ficha}</OperationsBookProvider>
      ),
    },
    // The Papelera's «Lo traspasé a…» exit returns HERE with the traspaso panel
    // open and the archive intent in the URL (#1549).
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
