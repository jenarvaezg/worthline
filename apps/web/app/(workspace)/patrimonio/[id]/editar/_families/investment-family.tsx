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
import { currencyMark } from "@web/asistente/document-figures";
import { buildHoldingBenchmarkComparison } from "@web/build-holding-benchmark";
import HoldingBenchmarkComparisonCard from "@web/holding-benchmark-comparison-card";
import { COBRO_FORM_ID } from "@web/inversiones/cobro-form-ids";
import { refreshPricesAction } from "@web/inversiones/refresh-prices-action";
import { holdingWarnings } from "@web/patrimonio/[id]/editar/_chrome/holding-warnings";
import { FichaLink } from "@web/patrimonio/[id]/editar/_ficha/ficha-link";
import {
  FICHA_DATOS_TAB,
  fichaActionUrl,
  fichaTabUrl,
} from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import ExternalEntrySection from "@web/patrimonio/[id]/editar/_surfaces/external-entry-section";
import { PriceBackfillSection } from "@web/patrimonio/[id]/editar/_surfaces/price-backfill-section";
import { ReturnsPanel } from "@web/patrimonio/[id]/editar/_surfaces/returns-panel";
import { SnapshotPriceCorrectionSection } from "@web/patrimonio/[id]/editar/_surfaces/snapshot-price-correction-section";
import { StatementUploadSection } from "@web/patrimonio/[id]/editar/_surfaces/statement-upload-section";
import { transferDestinationOptions } from "@web/patrimonio/[id]/editar/_surfaces/transfer-form";
import TransferSection from "@web/patrimonio/[id]/editar/_surfaces/transfer-section";
import { acknowledgeWarningAction } from "@web/patrimonio/actions";
import { PriceRefreshControl } from "@web/patrimonio/price-refresh-control";
import { PendingSubmit } from "@web/pending-submit";
import { priceOriginCaption } from "@web/price-refresh";
import { readBenchmarkPricesFromControlPlane } from "@web/read-benchmark-prices";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import type { CurrencyCode, DecimalString, HoldingWarningCode } from "@worthline/domain";
import {
  costBasisGradeMark,
  declaredSecurityId,
  detectSingleAssetBackfillCandidate,
  detectValueOnlyOpening,
  exposureLookthroughKey,
  formatMoneyMinorPrivacy,
  formatPrice,
  formatUnits,
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

/**
 * Every tab the ficha ends up with, in order — the list each URL here is built
 * against, so a link into «Datos del activo» and a form's return read the same one.
 */
const FICHA_TABS = [...TABS, FICHA_DATOS_TAB] as const;

/**
 * The warning about the price itself: printed beside the price, not in the band
 * (#1828), because what it says — nothing quotes this automatically — is about the
 * figure right there.
 */
const SYMBOL_WARNING = "MISSING_PROVIDER_SYMBOL" satisfies HoldingWarningCode;

/** The ledger is where a sale or a traspaso past the units held gets fixed. */
const LEDGER_FIX = { label: "Ver operaciones", tab: "operaciones" } as const;

/** A unit price as the ficha prints it: the ledger's price voice, then the currency. */
function unitPrice(price: DecimalString, currency: CurrencyCode, privacyMode: boolean) {
  const formatted = formatPrice(price);
  const shown = privacyMode ? maskMoneyString(formatted) : formatted;
  return `${shown} ${currencyMark(currency)}`;
}

export async function loadInvestmentSurface(
  ctx: AssetFamilyContext,
): Promise<HoldingSurface> {
  const {
    allAssets,
    archiveOriginAfterTransfer,
    asset,
    baseCurrency,
    currentUrl,
    formError,
    id,
    isDemo,
    overrides,
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
  // Where the price comes from and of when rides the same call (#1828): the cache
  // row's provenance and the day the hand-set price was set go IN with the prices,
  // and the origin comes OUT with the valuation that picked one.
  const { valuation, view: returnsView } = holdingReturns({
    assetId: id,
    cachedPrice: priceCache?.price,
    currency: baseCurrency,
    instrument,
    manualPrice: investment?.manualPricePerUnit,
    ...(priceCache ? { cachedQuote: priceCache } : {}),
    ...(investment?.manualPricedAt ? { manualPricedAt: investment.manualPricedAt } : {}),
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
  const benchmarkCard =
    benchmarkResult && exposureProfile?.trackedIndex ? (
      <HoldingBenchmarkComparisonCard
        result={benchmarkResult}
        trackedIndex={exposureProfile.trackedIndex}
      />
    ) : null;

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
  const tabUrl = (tab: (typeof FICHA_TABS)[number]) =>
    fichaTabUrl(currentUrl, FICHA_TABS, tab);

  // ── The state header ────────────────────────────────────────────────────────
  const money = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency: baseCurrency }, privacyMode);
  const gainRatio = returnsView?.totalReturnRatio ?? null;
  const irrRate = returnsView?.irr?.rate ?? null;
  const irrTone = signClass(irrRate);
  // The holding's active warnings, read once: whether the one about the price is
  // active decides the notice beside it, and the page hands the same list to the
  // band, which leaves out what this ficha prints here (#1828, #1731 review).
  const warnings = holdingWarnings({ asset, id, operations, overrides });
  const missingSymbol = warnings.some((warning) => warning.code === SYMBOL_WARNING);
  const figures: FichaFigure[] = [
    {
      detail: (
        <>
          {/* Where the price comes from and of when (#1828) — worded from the
              origin the valuation handed back with the price, never inferred. */}
          <small className="priceRefreshCaption">
            {priceOriginCaption(valuation.priceOrigin)}
          </small>
          {missingSymbol ? (
            <div className="fichaPriceNotice">
              <span>⚠ Sin cotización automática.</span>
              <FichaLink
                field="providerSymbol"
                href={tabUrl(FICHA_DATOS_TAB)}
                tab={FICHA_DATOS_TAB}
              >
                Indicar símbolo
              </FichaLink>
              <span aria-hidden="true">·</span>
              {/* Today's «Es intencional», by the same override: this fund is
                  quoted by hand on purpose. Its result is the server's redirect,
                  so it shows an honest pending and cannot be sent twice (§4) —
                  and it comes back HERE, with its notice, not to the board. */}
              <form action={acknowledgeWarningAction}>
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <input name="returnTo" type="hidden" value={currentUrl} />
                <input name="code" type="hidden" value={SYMBOL_WARNING} />
                <input name="entityId" type="hidden" value={id} />
                <PendingSubmit disabled={isDemo} pendingLabel="Guardando…">
                  Cotiza a mano
                </PendingSubmit>
              </form>
            </div>
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
            ? ` a ${unitPrice(valuation.pricePerUnit, baseCurrency, privacyMode)}`
            : null}
        </>
      ),
    },
    {
      // The board row's figure, by its same rules: no ratio, no claim (#551), and a
      // gain of zero reads as the board's ▲, not as a loss.
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
      ...(irrTone ? { tone: irrTone } : {}),
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
      // A run of buys typed off one statement shares its day and its currency.
      again: "Añadir otra",
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
    again: "Añadir otro",
    content: payoutsPanel.entry(tabUrl("cobros")),
    key: "cobro",
    label: "Añadir cobro",
    // At hand once the holding has paid something; a fund that never has does not
    // need the button in view, so it waits in «Más» (#1829).
    tier: payoutsPanel.count > 0 ? "secondary" : "more",
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
        // The record's own controls print on the tab; an entry form's refusal
        // reopens «Añadir cobro» over it, on the form that produced it (#1731 review).
        [COBRO_FORM_ID.record]: { tab: "cobros" },
        [COBRO_FORM_ID.oneOff]: { action: "cobro", tab: "cobros" },
        [COBRO_FORM_ID.recurring]: { action: "cobro", tab: "cobros" },
        statement: { action: "extracto" },
        transfer: { action: "traspaso" },
      },
      figures,
      inlineWarnings: [SYMBOL_WARNING],
      instrument: INSTRUMENT_LABELS_ES[instrument],
      // What each tab lists, so the row a terminal adds is pointed at (#1829).
      rows: {
        ...payoutsPanel.rows,
        operaciones: operations.map((operation) => operation.id),
      },
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
          // «Tu dinero (TIR)» faced with «El fondo (TWR)», the index comparison on
          // the fund's side — the TWR is what it compares (#551, ADR 0040, #1830).
          content: returnsView ? (
            <ReturnsPanel
              benchmark={benchmarkCard}
              privacyMode={privacyMode}
              view={returnsView}
            />
          ) : (
            <>
              <p className="emptyLine">Sin rentabilidad que medir todavía.</p>
              {benchmarkCard}
            </>
          ),
          key: "rentabilidad",
          label: "Rentabilidad",
        },
        {
          content: payoutsPanel.record(
            tabUrl("cobros"),
            // With none yet, the record is one line and this is its door (#1830):
            // the «Añadir cobro» panel, opened over the tab.
            <FichaLink
              action="cobro"
              href={fichaActionUrl(currentUrl, FICHA_TABS, "cobros", "cobro")}
              tab="cobros"
            >
              Añadir un cobro
            </FichaLink>,
          ),
          count: payoutsPanel.count,
          key: "cobros",
          label: "Cobros",
        },
      ],
      value: money(valuation.valueMinor),
      warnings,
      warningFixes: { OVERSELL: LEDGER_FIX, OVER_TRANSFER: LEDGER_FIX },
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
