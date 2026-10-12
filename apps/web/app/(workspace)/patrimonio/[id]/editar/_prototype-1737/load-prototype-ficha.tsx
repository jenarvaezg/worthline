/**
 * PROTOTIPO #1737 — desechable. La ficha de inversión troceada en piezas sueltas
 * (cifras de la cabecera, un formulario por acción, un cuerpo por pestaña) para
 * que las tres variantes de `ficha-prototype.tsx` las coloquen a su manera.
 *
 * Copia las lecturas de `_families/investment-family.tsx` en vez de tocarlo: el
 * prototipo vive en una rama desechable y la ficha real no debe saber que existe.
 * Todos los formularios reciben acciones de relleno (`prototype-stub-actions.ts`).
 */

import {
  readOperationFees,
  readOperationPrice,
} from "@web/_components/operation-capture-reading";
import { OperationRecordForm } from "@web/_components/operation-record-form";
import { OperationsBookProvider } from "@web/_components/operations-book";
import { OperationsLedger } from "@web/_components/operations-ledger";
import { formatMeasurePct, signClass } from "@web/_components/returns-format";
import { transferCounterpartByOperationId } from "@web/_components/transfer-counterparts";
import { formatIsoDayEs } from "@web/asistente/iso-day-es";
import { buildHoldingBenchmarkComparison } from "@web/build-holding-benchmark";
import HoldingBenchmarkComparisonCard from "@web/holding-benchmark-comparison-card";
import { priceFreshnessLabel } from "@web/intake";
import { refreshPricesAction } from "@web/inversiones/refresh-prices-action";
import { operationKindLabel, transferRowNote } from "@web/operation-kind-copy";
import type { AssetFamilyContext } from "@web/patrimonio/[id]/editar/_families/family-contract";
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
import {
  buildHoldingReturnsView,
  collectWarnings,
  compareInvestmentOperations,
  declaredSecurityId,
  detectSingleAssetBackfillCandidate,
  exposureLookthroughKey,
  formatMoneyMinorPrivacy,
  formatUnits,
  getPriceFreshness,
  holdingIrr,
  holdingTwr,
  INSTRUMENT_LABELS_ES,
  instrumentOfAsset,
  lastCapturedCurrency,
  monthlyCloseValuesByHolding,
  netUnitsByAsset,
  simpleGain,
  usableCachedPrice,
  type WarningOverride,
} from "@worthline/domain";
import type { ReactNode } from "react";
import type {
  ActionKey,
  LedgerRow,
  PrototypeExtras,
  PrototypeFigures,
  TabKey,
} from "./prototype-model";
import { prototypeNoopAction, prototypeNoopPreview } from "./prototype-stub-actions";

export interface PrototypeFichaParts {
  figures: PrototypeFigures;
  refresh: ReactNode;
  forms: Partial<Record<ActionKey, ReactNode>>;
  tabs: Record<TabKey, ReactNode>;
  operationCount: number;
  extras: PrototypeExtras;
}

// The real forms type their actions precisely; the stubs satisfy them only by cast.
// biome-ignore lint/suspicious/noExplicitAny: prototipo desechable
const noop = prototypeNoopAction as any;
// biome-ignore lint/suspicious/noExplicitAny: prototipo desechable
const noopPreview = prototypeNoopPreview as any;

export async function loadPrototypeFicha(
  ctx: AssetFamilyContext,
  chrome: {
    basics: ReactNode;
    availability: ReactNode;
    danger: ReactNode;
    overrides: WarningOverride[];
  },
): Promise<PrototypeFichaParts> {
  const {
    allAssets,
    asset,
    checkedAt,
    currentUrl,
    formError,
    id,
    privacyMode,
    store,
    today,
  } = ctx;

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
      store.operations.readTransferCounterparts(id),
    ]);
  const [payouts, schedules] = await Promise.all([
    store.payouts.readPayoutsForHolding(id),
    store.payouts.readPayoutSchedulesForHolding(id),
  ]);
  const counterpartMap = transferCounterpartByOperationId(
    operations,
    counterparts,
    new Map(allAssets.map((a) => [a.id, a.name])),
  );

  const position = positions.find((p) => p.assetId === id) ?? null;
  const twrMonthlyCloses = monthlyCloseValuesByHolding(twrSnapshotRows).get(id) ?? [];

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
  const usablePrice = priceCache ? usableCachedPrice(priceCache) : null;
  const priceCaption = priceCache
    ? detailRefreshCaption(
        priceCache.source === "manual" ? null : priceCache.fetchedAt,
        priceCache.source === "manual" ? null : priceCache.source,
      )
    : null;

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
    ...(position?.costBasisGrade ? { costBasisGrade: position.costBasisGrade } : {}),
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

  const isBackfillCandidate =
    investment !== null &&
    detectSingleAssetBackfillCandidate({
      assetId: id,
      operations,
      priceProvider: investment.priceProvider,
      ...(investment.providerSymbol ? { providerSymbol: investment.providerSymbol } : {}),
      snapshotRows: twrSnapshotRows,
    }) !== null;
  const hasManualLedger = operations.length > 0;

  // ── Cabecera ──────────────────────────────────────────────────────────────
  const instrument = instrumentOfAsset(asset);
  const marketValue = position?.marketValue ?? position?.costBasis ?? null;
  const gain =
    returnsView && returnsView.totalReturnRatio !== null
      ? {
          amount: `${returnsView.totalGain.amountMinor > 0 ? "+" : ""}${formatMoneyMinorPrivacy(returnsView.totalGain, privacyMode)}`,
          pct: formatMeasurePct(returnsView.totalReturnRatio),
          sign: signClass(returnsView.totalReturnRatio),
        }
      : null;
  const irrRate = returnsView?.irr?.rate ?? null;
  const figures: PrototypeFigures = {
    gain,
    instrument: instrument ? INSTRUMENT_LABELS_ES[instrument] : null,
    irr: returnsView?.irr
      ? { pct: formatMeasurePct(irrRate), sign: signClass(irrRate) }
      : null,
    name: asset.name,
    price:
      usablePrice !== null
        ? privacyMode
          ? `••• ${asset.currency}`
          : `${formatUnits(usablePrice)} ${asset.currency}`
        : null,
    priceCaption,
    priceFreshness: freshness,
    priceFreshnessLabel: priceFreshnessLabel(freshness),
    units: position ? formatUnits(position.currentUnits) : null,
    value: marketValue ? formatMoneyMinorPrivacy(marketValue, privacyMode) : null,
  };

  const refresh = investment?.providerSymbol ? (
    <PriceRefreshControl
      action={refreshPricesAction}
      assetId={asset.id}
      currentUrl={currentUrl}
      label="Actualizar precio"
      pendingLabel="Actualizando…"
    />
  ) : null;

  // ── El editor de operaciones, montado dos veces y recortado por CSS ─────────
  // (desde #1826 son dos piezas; el prototipo las monta juntas en cada sitio)
  const editor = (
    <OperationsBookProvider operations={operations}>
      <section aria-label="Operaciones de la inversión">
        <OperationRecordForm
          assetId={id}
          currentUrl={currentUrl}
          defaultCurrency={lastCapturedCurrency(operations)}
          formError={formError}
          heldUnits={position?.currentUnits ?? "0"}
          readOnly={false}
          recordAction={noop}
          today={today}
        />
        <OperationsLedger
          currentUrl={currentUrl}
          deleteAction={noop}
          privacyMode={privacyMode}
          readOnly={false}
          transferCounterparts={counterpartMap}
        />
      </section>
    </OperationsBookProvider>
  );

  const forms: Partial<Record<ActionKey, ReactNode>> = {
    cobro: ctx.payoutsPanel.section,
    extracto: (
      <StatementUploadSection
        confirmAction={noop}
        currentUrl={currentUrl}
        previewAction={noopPreview}
      />
    ),
    operacion: editor,
  };
  if (hasManualLedger) {
    forms.traspaso = (
      <TransferSection
        archiveOrigin={ctx.archiveOriginAfterTransfer}
        currentUrl={currentUrl}
        destinations={transferDestinationOptions(allAssets, positions, {
          assetId: id,
          currency: asset.currency,
        })}
        formError={formError}
        origin={{
          assetId: id,
          currency: asset.currency,
          operations,
          ...(asset.instrument ? { instrument: asset.instrument } : {}),
          ...(position?.currentPricePerUnit
            ? { pricePerUnit: position.currentPricePerUnit }
            : {}),
        }}
        originName={asset.name}
        privacyMode={privacyMode}
        readOnly={false}
        recordAction={noop}
        today={today}
      />
    );
    forms.entrada = (
      <ExternalEntrySection
        currentUrl={currentUrl}
        formError={formError}
        holdingName={asset.name}
        readOnly={false}
        recordAction={noop}
        today={today}
      />
    );
  }
  if (isBackfillCandidate) {
    forms.historico = (
      <PriceBackfillSection
        confirmAction={noop}
        currentUrl={currentUrl}
        previewAction={noopPreview}
      />
    );
  }
  if (investment !== null && operations.length > 0) {
    forms.correccion = (
      <SnapshotPriceCorrectionSection
        confirmAction={noop}
        currentUrl={currentUrl}
        previewAction={noopPreview}
        today={today}
        {...(usablePrice !== null ? { defaultUnitPrice: usablePrice } : {})}
      />
    );
  }

  const tabs: Record<TabKey, ReactNode> = {
    cobros: ctx.payoutsPanel.section,
    datos: (
      <>
        {chrome.basics}
        {chrome.availability}
        {chrome.danger}
      </>
    ),
    operaciones: editor,
    rentabilidad: (
      <>
        {returnsView ? (
          <ReturnsPanel privacyMode={privacyMode} view={returnsView} />
        ) : null}
        {benchmarkResult && exposureProfile?.trackedIndex ? (
          <HoldingBenchmarkComparisonCard
            result={benchmarkResult}
            trackedIndex={exposureProfile.trackedIndex}
          />
        ) : null}
        {returnsView ? null : (
          <p className="emptyLine">Sin rentabilidad que medir todavía.</p>
        )}
      </>
    ),
  };

  // ── B2: de dónde sale el precio, el libro compacto y los avisos repartidos ──
  const currencySuffix = (currency: string) => (currency === "EUR" ? "€" : currency);
  const latestOperation = [...operations].sort((a, b) =>
    compareInvestmentOperations(b, a),
  )[0];
  const showPrice = (price: string) =>
    privacyMode
      ? `••• ${currencySuffix(asset.currency)}`
      : `${formatUnits(price)} ${currencySuffix(asset.currency)}`;
  const priceLine =
    usablePrice !== null
      ? { origin: priceCaption ?? "cotización guardada", value: showPrice(usablePrice) }
      : position?.currentPricePerUnit
        ? {
            // Solo se afirma la última operación si de verdad es su precio. En la
            // ficha real el origen lo debe decir el motor que eligió el precio.
            origin:
              latestOperation &&
              Number(latestOperation.pricePerUnit) ===
                Number(position.currentPricePerUnit)
                ? `precio de la última operación · ${formatIsoDayEs(latestOperation.executedAt)}`
                : "último precio guardado",
            value: showPrice(position.currentPricePerUnit),
          }
        : { origin: "sin precio: se valora a lo que costó", value: null };

  const warnings = collectWarnings([asset], chrome.overrides, {
    netUnitsByAssetId: netUnitsByAsset(new Map([[id, operations]])),
    operationsByAssetId: new Map([[id, operations]]),
  });

  const ledger: LedgerRow[] = [...operations]
    .sort((a, b) => compareInvestmentOperations(b, a))
    .map((op) => {
      const fees = readOperationFees(op, privacyMode);
      const outflow = op.kind === "sell" || op.kind === "transfer_out";
      const grossMinor = Math.round(Number(op.units) * Number(op.pricePerUnit) * 100);
      const amountMinor = grossMinor + (outflow ? -op.feesMinor : op.feesMinor);
      return {
        amount: formatMoneyMinorPrivacy(
          { amountMinor, currency: op.currency },
          privacyMode,
        ),
        date: formatIsoDayEs(op.executedAt),
        fees: fees ? formatMoneyMinorPrivacy(fees.fees, privacyMode) : null,
        id: op.id,
        kind: operationKindLabel(op.kind),
        note: transferRowNote({
          counterpart: counterpartMap[op.id] ?? { kind: "unresolved" },
          kind: op.kind,
          privacyMode,
          ...(op.transferCostMinor !== undefined
            ? { transferCostMinor: op.transferCostMinor }
            : {}),
          ...(op.transferSeniorityAt !== undefined
            ? { transferSeniorityAt: op.transferSeniorityAt }
            : {}),
        }),
        price: `${readOperationPrice(op, privacyMode).price} ${currencySuffix(op.currency)}`,
        units: formatUnits(op.units),
      };
    });

  const extras: PrototypeExtras = {
    cobroCount: payouts.length + schedules.length,
    ledger,
    missingSymbol: warnings.some((w) => w.code === "MISSING_PROVIDER_SYMBOL"),
    otherWarnings: warnings
      .filter((w) => w.code !== "MISSING_PROVIDER_SYMBOL")
      .map((w) => ({
        code: w.code,
        message: w.message,
        overrideable: w.severity === "overrideable",
      })),
    priceLine,
  };

  return { extras, figures, forms, operationCount: operations.length, refresh, tabs };
}
