/**
 * Patrimonio load module (issue #1119, arch review 2026-07-17; split #1195).
 *
 * Sibling of the home read model ({@link loadDashboard}): one input in, one
 * result out. The /patrimonio page used to assemble a parallel read model inline
 * (~165 lines before the return plus ~90 after) — projection context, curve-
 * valued holdings, per-holding + per-class returns, the exposure look-through,
 * price-refresh meta and the papelera. That assembly now lives here, testable
 * outside the page against the in-memory store, so the page only renders.
 *
 * Cache-only GET (#785, #788, #895): like the dashboard, this path performs NO
 * network and NO writes. It reads the cached prices and computes today's figures
 * live from the same curve-valued ledger snapshot capture uses.
 *
 * `loadPatrimonio` itself no longer reads the exposure-profile catalog or
 * derives the exposure look-through / per-class returns (#1195): those are the
 * only two analytical sub-sections streamed behind Suspense on /patrimonio, and
 * the catalog read is the one await that lets the synchronous board flush
 * first. It instead returns `exposureContext` — everything {@link
 * deriveExposureAndReturns} needs, computed once here and carried into the
 * streamed child so that derivation is never duplicated.
 */

import { resolveFxAggregation } from "@web/fx-context";
import { holdingPublicIdIndex, managedPortfolioPublicIdIndex } from "@web/holding-route";
import type { InvestmentAssetMeta, TrashView, WorthlineStore } from "@worthline/db";
import type {
  AssetClassResolution,
  AssetClassReturnsViewResult,
  AssetProjectionContext,
  CurrencyCode,
  DatedPayout,
  DomainWarning,
  ExposureLookthrough,
  ExposureLookthroughHolding,
  ExposureProfile,
  HoldingReturnsView,
  Instrument,
  ManualAsset,
  MonthlyCloseValue,
  PortfolioGroup,
  PortfolioGroupKey,
  PortfolioProjection,
  PriceRefreshMeta,
  ScopeOption,
  Workspace,
} from "@worthline/domain";
import {
  collectHoldingPayouts,
  collectWarnings,
  groupPortfolio,
  instrumentOfAsset,
  investmentReturnsById,
  lookThroughExposure,
  monthlyCloseValuesFromSnapshotRows,
  netUnitsByAsset,
  projectPortfolio,
  resolveAssetClassBreakdown,
  returnsByAssetClassView,
  usableCachedPrice,
} from "@worthline/domain";

export interface LoadPatrimonioInput {
  /** The open store to use for all reads. Caller owns lifecycle (#1025). */
  store: WorthlineStore;
  /** The resolved workspace (base currency, mode). */
  workspace: Workspace;
  /** The selected scope, or undefined when there is none — then everything empties. */
  selectedScope: ScopeOption | undefined;
  /** "Today" as YYYY-MM-DD — anchors curve valuation, returns and FX. */
  today: string;
  /** The grouping axis for the unified board (#154, S8). */
  selectedGroup: PortfolioGroupKey;
}

/**
 * Everything {@link deriveExposureAndReturns} needs that is otherwise only
 * computed inside `loadPatrimonio`. Carried across the Suspense boundary (#1195)
 * so the streamed analytics child derives the look-through + per-class returns
 * without re-reading assets, operations or monthly closes.
 */
export interface PatrimonioExposureContext {
  /** The scope-weighted projection, or null when there is no selected scope. */
  projection: PortfolioProjection | null;
  /** Curve-valued assets at `today` — the same rows the board/projection use. */
  assets: ManualAsset[];
  /** Investment metadata (isin/providerSymbol), keyed by asset id. */
  metaByAssetId: Map<string, InvestmentAssetMeta>;
  instrumentByAsset: Map<string, Instrument>;
  monthlyClosesByAsset: Map<string, MonthlyCloseValue[]>;
  payoutsByAsset: Map<string, DatedPayout[]>;
  cachedPriceByAsset: AssetProjectionContext["cachedPriceByAsset"];
  manualPriceByAsset: AssetProjectionContext["manualPriceByAsset"];
  operationsByAsset: AssetProjectionContext["operationsByAsset"];
  baseCurrency: CurrencyCode;
  today: string;
}

export interface LoadPatrimonioResult {
  /** The unified list grouped by the selected axis, split by pane in the board. */
  groups: PortfolioGroup[];
  /** Per-holding simple total gain, keyed by asset id (#551, ADR 0040). */
  returnsById: Map<string, HoldingReturnsView>;
  /** Asset ids with at least one recorded operation — the board's fold guard. */
  operatedAssetIds: Set<string>;
  /**
   * Public `wl_hld_…` id per internal holding id (#1318) — the board's rows are
   * links, and a holding is named in a URL only by its public id.
   */
  publicIdByHolding: Readonly<Record<string, string>>;
  /**
   * Public `wl_prt_…` id per internal portfolio id (#1548): the group header
   * links to the ficha and the fold param names portfolios in the URL — both
   * places where only a public id may appear.
   */
  publicIdByPortfolio: Readonly<Record<string, string>>;
  /** Modelling/data warnings surfaced on the board (minus overridden ones). */
  warnings: DomainWarning[];
  /** Soft-deleted holdings (#268) for the board's papelera. */
  trash: TrashView;
  /** Whether the manual "Actualizar precios" trigger has anything to refetch (#405). */
  hasPricedHoldings: boolean;
  /** Whether there is any holding at all — gates the "Puesta al día" entry. */
  hasHoldings: boolean;
  /** Everything the streamed analytics child needs (#1195). See {@link PatrimonioExposureContext}. */
  exposureContext: PatrimonioExposureContext;
}

/**
 * Assemble the /patrimonio read model. See the module doc for what it owns.
 */
export async function loadPatrimonio(
  input: LoadPatrimonioInput,
): Promise<LoadPatrimonioResult> {
  const { store, workspace, selectedScope, today, selectedGroup } = input;

  // The shared raw-reads context (operations, prices, ownership) built once and
  // reused: it both feeds the curve valuation below (dedup, #566) and drives the
  // per-holding returns without a second operation read (#551).
  const projectionContext = await store.snapshots.buildProjectionContext();

  // These reads are independent of one another, so fire them in one wave
  // instead of stacking serial round-trips to the (remote) store (#446). The
  // exposure-profile catalog is deliberately NOT read here (#1195): it is the
  // one await `deriveExposureAndReturns` needs, and reading it only in the
  // streamed analytics child is what lets this board flush first.
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
    returnSnapshotRows,
    payoutRecords,
    payoutSchedules,
    publicIds,
    managedPortfolios,
  ] = await Promise.all([
    store.operations.readAllPriceCacheEntries(),
    store.assets.readInvestmentAssetsWithMeta(),
    store.snapshots.readCurveValuedHoldingsAtDate(today, projectionContext),
    store.readWarningOverrides(),
    store.readTrash(),
    store.snapshots.readSnapshotHoldings({ kind: "asset", scopeId: "household" }),
    store.payouts.readPayouts(),
    store.payouts.readPayoutSchedules(),
    store.agentView.readPublicIds(),
    store.managedPortfolios.readManagedPortfolios(),
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
  // Investment metadata (isin/providerSymbol) by asset id — the join key the
  // streamed analytics child uses to resolve each holding's exposure profile
  // (#1195; was also used here for the per-class returns and look-through).
  const metaByAssetId = new Map(investmentMeta.map((row) => [row.id, row]));

  const returnsById = investmentReturnsById({
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
  // Only rows that ARE a price carry the badge: attributing a cost-basis figure
  // to "actualizado el X por Yahoo" would credit the provider for a number it
  // never supplied — the failed row's own attempt (#1330).
  const priceMetaByAsset = new Map<string, PriceRefreshMeta>(
    priceCacheEntries
      .filter((entry) => usableCachedPrice(entry) !== null)
      .map((entry) => [
        entry.assetId,
        { fetchedAt: entry.fetchedAt, source: entry.source },
      ]),
  );

  // Whether the manual "Actualizar precios" trigger (#405) has anything to do:
  // read from the SAME meta source the action filters on, so the control only
  // appears when a force-refresh would actually refetch a provider-priced holding.
  const hasPricedHoldings = investmentMeta.some((asset) => Boolean(asset.providerSymbol));

  // Assets with at least one recorded operation — the board's guard that
  // separates a fully-sold position (folds away) from a just-created one.
  const operatedAssetIds = new Set(
    [...projectionContext.operationsByAsset]
      .filter(([, rows]) => rows.length > 0)
      .map(([assetId]) => assetId),
  );

  // FX context for the projection (#1065). Hard-gated: hits ECB only when a
  // foreign currency is actually held, so an all-EUR board does no network. A
  // non-convertible holding is excluded from the rows/totals and surfaced as
  // "no incluido / parcial", matching the dashboard's net-worth exclusion.
  const fx = await resolveFxAggregation(
    [
      ...assets.map((asset) => asset.currentValue),
      ...liabilities.map((liability) => liability.currentBalance),
    ],
    today,
  );

  // A fully-sold position keeps its row as history but no longer needs a price
  // symbol, so it stops carrying the MISSING_PROVIDER_SYMBOL badge (#1348). The
  // ledger is already in hand from the shared projection context — no extra I/O.
  const warnings = collectWarnings(assets, overrides, {
    netUnitsByAssetId: netUnitsByAsset(projectionContext.operationsByAsset),
    operationsByAssetId: projectionContext.operationsByAsset,
  });

  const projection = selectedScope
    ? projectPortfolio({
        workspace,
        scope: selectedScope,
        assets,
        liabilities,
        priceMetaByAsset,
        ...(fx ? { fx } : {}),
      })
    : null;

  // The one unified list, grouped by the selected axis (#154, S8). The selected
  // group doubles as the filter; BalanceBoard splits each group across the two panes.
  //
  // Managed portfolios of the SELECTED scope only (#1548): a portfolio belongs
  // to one scope, and grouping by somebody else's would pull rows the board is
  // not showing. Members absent from the projection are simply not part of the
  // block — `groupPortfolio` builds it from whoever is present.
  const scopedPortfolios = selectedScope
    ? managedPortfolios.filter((portfolio) => portfolio.scopeId === selectedScope.id)
    : [];
  const groups = projection
    ? groupPortfolio(projection, selectedGroup, scopedPortfolios)
    : [];

  return {
    exposureContext: {
      assets,
      baseCurrency: workspace.baseCurrency,
      cachedPriceByAsset: projectionContext.cachedPriceByAsset,
      instrumentByAsset,
      manualPriceByAsset: projectionContext.manualPriceByAsset,
      metaByAssetId,
      monthlyClosesByAsset,
      operationsByAsset: projectionContext.operationsByAsset,
      payoutsByAsset,
      projection,
      today,
    },
    groups,
    hasHoldings: assets.length > 0 || liabilities.length > 0,
    hasPricedHoldings,
    operatedAssetIds,
    // The board turns a holding into a link, and a holding is named in a URL by
    // its public `wl_hld_…` id (#1318) — never by the internal storage id the
    // projection rows carry. Hand the board the translation, not the URLs, so
    // the domain stays out of routing.
    publicIdByPortfolio: Object.fromEntries(
      managedPortfolioPublicIdIndex(publicIds).publicByInternal,
    ),
    publicIdByHolding: Object.fromEntries(
      holdingPublicIdIndex(publicIds).publicByInternal,
    ),
    returnsById,
    trash,
    warnings,
  };
}

/**
 * Derive the two streamed /patrimonio analytics sub-sections (#1195): the
 * present-time exposure look-through (PRD #539 S3, ADR 0039) and the per-
 * asset-class decomposition of the portfolio returns (#552, ADR 0040 fast-
 * follow). Pure given `ctx` (from {@link loadPatrimonio}) and the exposure-
 * profile catalog — reproduces exactly the derivation that used to run inline
 * in `loadPatrimonio` before the board/analytics split.
 */
export function deriveExposureAndReturns(
  ctx: PatrimonioExposureContext,
  exposureProfiles: ExposureProfile[],
): {
  exposureFull: ExposureLookthrough;
  exposureEquity: ExposureLookthrough;
  returnsByClass: AssetClassReturnsViewResult | null;
} {
  const {
    assets,
    baseCurrency,
    cachedPriceByAsset,
    instrumentByAsset,
    manualPriceByAsset,
    metaByAssetId,
    monthlyClosesByAsset,
    operationsByAsset,
    payoutsByAsset,
    projection,
    today,
  } = ctx;

  // Both the per-class returns and the exposure look-through key by the same
  // catalog, by its key.
  const exposureProfileByKey = new Map<string, ExposureProfile>(
    exposureProfiles.map((profile) => [profile.key, profile]),
  );

  // Per-asset-class decomposition of the portfolio returns (#552, ADR 0040
  // fast-follow). Resolves each holding's asset class from the SAME exposure
  // profiles the look-through uses (`resolveAssetClassBreakdown`, ADR 0039), then
  // folds the market holdings through the return engine per class. Present-time
  // and unscoped, mirroring the per-holding board figures.
  const assetClassByAsset = new Map<string, AssetClassResolution>(
    assets.map((asset) => {
      const meta = metaByAssetId.get(asset.id);
      const key = meta?.isin ?? meta?.providerSymbol ?? null;
      const profile = key ? (exposureProfileByKey.get(key) ?? null) : null;
      return [asset.id, resolveAssetClassBreakdown(instrumentOfAsset(asset), profile)];
    }),
  );
  const returnsByClass = returnsByAssetClassView({
    assetClassByAsset,
    cachedPriceByAsset,
    currency: baseCurrency,
    instrumentByAsset,
    manualPriceByAsset,
    monthlyClosesByAsset,
    operationsByAsset,
    payoutsByAsset,
    valuationDate: today,
  });

  // Present-time exposure look-through (PRD #539 S3, ADR 0039): build the domain
  // input from the projection's ASSET rows (already scope-weighted; their sum is
  // the projection's gross assets, so grossAssets stays consistent) keyed to
  // hand-entered profiles via `isin ?? providerSymbol`, then CALL the S0 domain
  // aggregation — never re-implemented here. Twice: once full-portfolio, once
  // equity-restricted; the client lens toggles between the two pre-rendered
  // results (interaction-patterns §2). It is a lens, never a snapshot/figure.
  const exposureHoldings: ExposureLookthroughHolding[] = projection
    ? projection.sections[0].rows.map((row) => ({
        currency: baseCurrency,
        geography: null,
        id: row.id,
        instrument: row.instrument,
        isin: metaByAssetId.get(row.id)?.isin ?? null,
        providerSymbol: metaByAssetId.get(row.id)?.providerSymbol ?? null,
        valueMinor: row.valueMinor,
      }))
    : [];
  const exposureInput = {
    baseCurrency,
    grossAssets: projection?.totalGrossAssets ?? {
      amountMinor: 0,
      currency: baseCurrency,
    },
    holdings: exposureHoldings,
    profiles: exposureProfileByKey,
  };
  const exposureFull = lookThroughExposure(exposureInput);
  const exposureEquity = lookThroughExposure({
    ...exposureInput,
    assetClassFilter: "equity",
  });

  return { exposureEquity, exposureFull, returnsByClass };
}
