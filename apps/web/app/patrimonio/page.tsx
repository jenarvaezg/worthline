import { isDemoMode } from "@web/demo/write-guard";
import {
  appendParam,
  buildCurrentUrlFor,
  PRIVACY_COOKIE_NAME,
  parseFormError,
  parseGroupParam,
  parsePrivacyCookie,
  parseScopeCookie,
  parseScopeParam,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { refreshPricesAction } from "@web/inversiones/actions";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import Shell from "@web/shell";
import { bootstrapHealthcheck, withStore } from "@web/store";
import { EXPOSURE_LENS_VIEW_PARAM, readViewParam } from "@web/view-state";
import type {
  AssetClassResolution,
  DatedPayout,
  ExposureLookthroughHolding,
  ExposureProfile,
  Instrument,
  PortfolioGroupKey,
  PriceRefreshMeta,
} from "@worthline/domain";
import {
  collectHoldingPayouts,
  collectWarnings,
  groupPortfolio,
  instrumentOfAsset,
  investmentReturnsById,
  listScopeOptions,
  lookThroughExposure,
  monthlyCloseValuesFromSnapshotRows,
  projectPortfolio,
  resolveAssetClassBreakdown,
  returnsByAssetClassView,
  systemClock,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import BalanceBoard from "./balance-board";
import ExposureSection from "./exposure-section";
import PatrimonioGroupControls from "./group-controls";
import { PriceRefreshControl } from "./price-refresh-control";
import ReturnsByClassSection from "./returns-by-class-section";

export const dynamic = "force-dynamic";

export default async function PatrimonioPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = await bootstrapHealthcheck();
  // Demo skips optimistic mutations — the write-guard rejects them, so a faked
  // change would only flicker before reverting (interaction-patterns §10).
  const isDemo = await isDemoMode();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/patrimonio", resolvedSearchParams);
  const selectedGroup = parseGroupParam(resolvedSearchParams?.group);

  const jar = await cookies();
  const queryScopeId = parseScopeParam(resolvedSearchParams?.scope);
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
  const privacyMode = parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);

  const storeData = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScopeId = queryScopeId ?? cookieScopeId;
    const selectedScope =
      scopes.find((scope) => scope.id === selectedScopeId) ?? scopes[0];

    const today = systemClock().today();
    // The shared raw-reads context (operations, prices, ownership) built once and
    // reused: it both feeds the curve valuation below (dedup, #566) and drives the
    // per-holding returns without a second operation read (#551).
    const projectionContext = await store.snapshots.buildProjectionContext();

    // These reads are independent of one another, so fire them in one wave
    // instead of stacking serial round-trips to the (remote) store (#446).
    const [
      priceCacheEntries,
      investmentMeta,
      // Curve-valued today (housing appreciation, amortized debt balances) so
      // the board shows the same live figures the dashboard derives — a raw
      // readAssets/readLiabilities would freeze modelled balances at whatever
      // the user last typed (the curve's fallback input).
      { assets, liabilities },
      overrides,
      trash,
      exposureProfiles,
      returnSnapshotRows,
      payoutRecords,
      payoutSchedules,
    ] = await Promise.all([
      store.operations.readAllPriceCacheEntries(),
      store.assets.readInvestmentAssetsWithMeta(),
      store.snapshots.readCurveValuedHoldingsAtDate(today, projectionContext),
      store.readWarningOverrides(),
      store.readTrash(),
      readExposureProfilesFromCatalog(),
      store.snapshots.readSnapshotHoldings({ kind: "asset", scopeId: "household" }),
      store.payouts.readPayouts(),
      store.payouts.readPayoutSchedules(),
    ]);

    // Per-holding simple total gain, inline on the board (#551, ADR 0040). Folds
    // each operation-bearing investment through the return engine — market
    // instruments only; a stored/mirrored holding carries no operations, so it is
    // absent from the map and shows no returns (never a fabricated figure).
    const instrumentByAsset = new Map<string, Instrument>(
      assets.map((asset) => [asset.id, instrumentOfAsset(asset)]),
    );
    const snapshotRowsByAsset = new Map<string, typeof returnSnapshotRows>();
    for (const row of returnSnapshotRows) {
      if (!projectionContext.operationsByAsset.has(row.holdingId)) {
        continue;
      }
      const rows = snapshotRowsByAsset.get(row.holdingId);
      if (rows) {
        rows.push(row);
      } else {
        snapshotRowsByAsset.set(row.holdingId, [row]);
      }
    }
    const monthlyClosesByAsset = new Map(
      [...snapshotRowsByAsset].map(([assetId, rows]) => [
        assetId,
        monthlyCloseValuesFromSnapshotRows(rows),
      ]),
    );
    // Recorded payouts (one-offs + derived schedule occurrences up to today) fed
    // to the return engine so distributing holdings stop understating (#657, ADR
    // 0054). Keyed by holding id — the same key `operationsByAsset` uses.
    const payoutsByAsset = new Map<string, DatedPayout[]>(
      [...collectHoldingPayouts(payoutRecords, payoutSchedules, today)].map(
        ([assetId, rows]) => [
          assetId,
          rows.map((row) => ({ amountMinor: row.amountMinor, date: row.dateISO })),
        ],
      ),
    );
    const investmentReturns = investmentReturnsById({
      cachedPriceByAsset: projectionContext.cachedPriceByAsset,
      currency: workspace.baseCurrency,
      instrumentByAsset,
      manualPriceByAsset: projectionContext.manualPriceByAsset,
      monthlyClosesByAsset,
      operationsByAsset: projectionContext.operationsByAsset,
      payoutsByAsset,
      valuationDate: today,
    });

    // Per-asset-class decomposition of the portfolio returns (#552, ADR 0040
    // fast-follow). Resolves each holding's asset class from the SAME exposure
    // profiles the look-through uses (`resolveAssetClassBreakdown`, ADR 0039), then
    // folds the market holdings through the return engine per class. Present-time
    // and unscoped, mirroring the per-holding board figures above.
    const exposureProfileByKey = new Map<string, ExposureProfile>(
      exposureProfiles.map((profile) => [profile.key, profile]),
    );
    const metaById = new Map(investmentMeta.map((row) => [row.id, row]));
    const assetClassByAsset = new Map<string, AssetClassResolution>(
      assets.map((asset) => {
        const meta = metaById.get(asset.id);
        const key = meta?.isin ?? meta?.providerSymbol ?? null;
        const profile = key ? (exposureProfileByKey.get(key) ?? null) : null;
        return [asset.id, resolveAssetClassBreakdown(instrumentOfAsset(asset), profile)];
      }),
    );
    const returnsByClass = returnsByAssetClassView({
      assetClassByAsset,
      cachedPriceByAsset: projectionContext.cachedPriceByAsset,
      currency: workspace.baseCurrency,
      instrumentByAsset,
      manualPriceByAsset: projectionContext.manualPriceByAsset,
      monthlyClosesByAsset,
      operationsByAsset: projectionContext.operationsByAsset,
      payoutsByAsset,
      valuationDate: today,
    });

    // Price-refresh metadata for the derived-value badge hover (#303): when + by
    // which source each cached unit price was last fetched, keyed by asset id. The
    // projection attaches it to investment rows only; non-investment entries are
    // ignored downstream.
    const priceMetaByAsset = new Map<string, PriceRefreshMeta>(
      priceCacheEntries.map((entry) => [
        entry.assetId,
        { fetchedAt: entry.fetchedAt, source: entry.source },
      ]),
    );

    // Whether the manual "Actualizar precios" trigger (#405) has anything to do:
    // read from the SAME meta source the action filters on, so the control only
    // appears when a force-refresh would actually refetch a provider-priced holding.
    const hasPricedHoldings = investmentMeta.some((asset) =>
      Boolean(asset.providerSymbol),
    );

    // Assets with at least one recorded operation — the board's guard that
    // separates a fully-sold position (folds away) from a just-created one.
    const operatedAssetIds = new Set(
      [...projectionContext.operationsByAsset]
        .filter(([, rows]) => rows.length > 0)
        .map(([assetId]) => assetId),
    );

    return {
      assets,
      exposureProfiles,
      hasPricedHoldings,
      investmentMeta,
      investmentReturns,
      liabilities,
      operatedAssetIds,
      overrides,
      priceMetaByAsset,
      returnsByClass,
      scopes,
      selectedScope,
      trash,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const {
    assets,
    exposureProfiles,
    hasPricedHoldings,
    investmentMeta,
    investmentReturns,
    liabilities,
    operatedAssetIds,
    overrides,
    priceMetaByAsset,
    returnsByClass,
    scopes,
    selectedScope,
    trash,
    workspace,
  } = storeData;

  const warnings = collectWarnings(assets, overrides);

  const projection = selectedScope
    ? projectPortfolio({
        workspace,
        scope: selectedScope,
        assets,
        liabilities,
        priceMetaByAsset,
      })
    : null;

  // The one unified list, grouped by the selected axis (#154, S8). The selected
  // group doubles as the filter; BalanceBoard splits each group across the two panes.
  const groups = projection ? groupPortfolio(projection, selectedGroup) : [];

  // Present-time exposure look-through (PRD #539 S3, ADR 0039): build the domain
  // input from the projection's ASSET rows (already scope-weighted; their sum is
  // the projection's gross assets, so grossAssets stays consistent) keyed to
  // hand-entered profiles via `isin ?? providerSymbol`, then CALL the S0 domain
  // aggregation — never re-implemented here. Twice: once full-portfolio, once
  // equity-restricted; the client lens toggles between the two pre-rendered
  // results (interaction-patterns §2). It is a lens, never a snapshot/figure.
  const exposureLensRaw = resolvedSearchParams?.[EXPOSURE_LENS_VIEW_PARAM.key];
  const exposureLens = readViewParam(
    typeof exposureLensRaw === "string"
      ? `${EXPOSURE_LENS_VIEW_PARAM.key}=${exposureLensRaw}`
      : "",
    EXPOSURE_LENS_VIEW_PARAM,
  );
  const exposureProfileMap = new Map<string, ExposureProfile>(
    exposureProfiles.map((profile) => [profile.key, profile]),
  );
  const metaByAssetId = new Map(investmentMeta.map((row) => [row.id, row]));
  const exposureHoldings: ExposureLookthroughHolding[] = projection
    ? projection.sections[0].rows.map((row) => ({
        currency: workspace.baseCurrency,
        geography: null,
        id: row.id,
        instrument: row.instrument,
        isin: metaByAssetId.get(row.id)?.isin ?? null,
        providerSymbol: metaByAssetId.get(row.id)?.providerSymbol ?? null,
        valueMinor: row.valueMinor,
      }))
    : [];
  const exposureInput = {
    baseCurrency: workspace.baseCurrency,
    grossAssets: projection?.totalGrossAssets ?? {
      amountMinor: 0,
      currency: workspace.baseCurrency,
    },
    holdings: exposureHoldings,
    profiles: exposureProfileMap,
  };
  const exposureFull = lookThroughExposure(exposureInput);
  const exposureEquity = lookThroughExposure({
    ...exposureInput,
    assetClassFilter: "equity",
  });

  const isHousehold = workspace.mode === "household";

  /** A /patrimonio URL that selects a grouping axis, preserving scope + feedback. */
  const groupHrefFor = (group: PortfolioGroupKey): string =>
    appendParam(currentUrl, "group", group);

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
    >
      {formError && !formError.formId ? (
        <p className="errorBand" role="alert">
          {formError.message}
        </p>
      ) : null}

      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="patrimonioHeader" aria-label="Activos y deudas">
        <div className="panelHeader">
          <h2>Patrimonio</h2>
          <span>Activos y deudas</span>
        </div>
        <div className="patrimonioActions">
          <Link className="actionLink" href="/patrimonio/anadir">
            + Añadir holding
          </Link>
          <Link className="actionLink" href="/patrimonio/importar-extracto">
            Importar extracto
          </Link>
          {hasPricedHoldings ? (
            <PriceRefreshControl
              action={refreshPricesAction}
              currentUrl={currentUrl}
              label="Actualizar precios"
              pendingLabel="Actualizando…"
            />
          ) : null}
        </div>
        {assets.length > 0 || liabilities.length > 0 ? (
          <Link className="actionLink" href="/patrimonio/actualizar">
            Puesta al día →
          </Link>
        ) : null}
        <PatrimonioGroupControls hrefFor={groupHrefFor} selected={selectedGroup} />
      </section>

      <BalanceBoard
        currentUrl={currentUrl}
        groups={groups}
        isHousehold={isHousehold}
        nowIso={persistence.checkedAt}
        operatedAssetIds={operatedAssetIds}
        privacyMode={privacyMode}
        readOnly={isDemo}
        returnsById={investmentReturns}
        trash={trash}
        warnings={warnings}
      />

      <ExposureSection
        currentUrl={currentUrl}
        equity={exposureEquity}
        full={exposureFull}
        initialLens={exposureLens}
        privacyMode={privacyMode}
      />

      {returnsByClass ? (
        <ReturnsByClassSection privacyMode={privacyMode} returns={returnsByClass} />
      ) : null}
    </Shell>
  );
}
