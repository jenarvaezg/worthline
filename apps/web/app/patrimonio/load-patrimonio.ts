/**
 * Patrimonio load module (issue #1119, arch review 2026-07-17).
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
 */

import { resolveFxAggregation } from "@web/fx-context";
import type { TrashView, WorthlineStore } from "@worthline/db";
import type {
  AssetClassResolution,
  AssetClassReturnsViewResult,
  DatedPayout,
  DomainWarning,
  ExposureLookthrough,
  ExposureLookthroughHolding,
  ExposureProfile,
  HoldingReturnsView,
  Instrument,
  PortfolioGroup,
  PortfolioGroupKey,
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
  projectPortfolio,
  resolveAssetClassBreakdown,
  returnsByAssetClassView,
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
  /**
   * The global exposure-profile catalog reader (PRD #711 S3). Injected so the
   * read model stays testable without the control plane; the page passes
   * `readExposureProfilesFromCatalog`. Absent → the look-through classifies
   * nothing (empty profiles), never throws.
   */
  readExposureProfiles?: () => Promise<ExposureProfile[]>;
}

export interface LoadPatrimonioResult {
  /** The unified list grouped by the selected axis, split by pane in the board. */
  groups: PortfolioGroup[];
  /** Per-holding simple total gain, keyed by asset id (#551, ADR 0040). */
  returnsById: Map<string, HoldingReturnsView>;
  /** Per-asset-class decomposition of the portfolio returns (#552). Null when none. */
  returnsByClass: AssetClassReturnsViewResult | null;
  /** Present-time exposure look-through, full portfolio (PRD #539 S3, ADR 0039). */
  exposureFull: ExposureLookthrough;
  /** The same look-through restricted to equity — the client lens toggles to it. */
  exposureEquity: ExposureLookthrough;
  /** Asset ids with at least one recorded operation — the board's fold guard. */
  operatedAssetIds: Set<string>;
  /** Modelling/data warnings surfaced on the board (minus overridden ones). */
  warnings: DomainWarning[];
  /** Soft-deleted holdings (#268) for the board's papelera. */
  trash: TrashView;
  /** Whether the manual "Actualizar precios" trigger has anything to refetch (#405). */
  hasPricedHoldings: boolean;
  /** Whether there is any holding at all — gates the "Puesta al día" entry. */
  hasHoldings: boolean;
}

/**
 * Assemble the /patrimonio read model. See the module doc for what it owns.
 */
export async function loadPatrimonio(
  input: LoadPatrimonioInput,
): Promise<LoadPatrimonioResult> {
  const { store, workspace, selectedScope, today, selectedGroup } = input;
  const readExposureProfiles = input.readExposureProfiles ?? (async () => []);

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
    readExposureProfiles(),
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
  // Both the per-class returns and the exposure look-through key by the same two
  // maps — profiles by their catalog key, and investment meta by asset id. Built
  // once here and shared by both consumers below.
  const exposureProfileByKey = new Map<string, ExposureProfile>(
    exposureProfiles.map((profile) => [profile.key, profile]),
  );
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

  // Per-asset-class decomposition of the portfolio returns (#552, ADR 0040
  // fast-follow). Resolves each holding's asset class from the SAME exposure
  // profiles the look-through uses (`resolveAssetClassBreakdown`, ADR 0039), then
  // folds the market holdings through the return engine per class. Present-time
  // and unscoped, mirroring the per-holding board figures above.
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

  const warnings = collectWarnings(assets, overrides);

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
  const groups = projection ? groupPortfolio(projection, selectedGroup) : [];

  // Present-time exposure look-through (PRD #539 S3, ADR 0039): build the domain
  // input from the projection's ASSET rows (already scope-weighted; their sum is
  // the projection's gross assets, so grossAssets stays consistent) keyed to
  // hand-entered profiles via `isin ?? providerSymbol`, then CALL the S0 domain
  // aggregation — never re-implemented here. Twice: once full-portfolio, once
  // equity-restricted; the client lens toggles between the two pre-rendered
  // results (interaction-patterns §2). It is a lens, never a snapshot/figure.
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
    profiles: exposureProfileByKey,
  };
  const exposureFull = lookThroughExposure(exposureInput);
  const exposureEquity = lookThroughExposure({
    ...exposureInput,
    assetClassFilter: "equity",
  });

  return {
    exposureEquity,
    exposureFull,
    groups,
    hasHoldings: assets.length > 0 || liabilities.length > 0,
    hasPricedHoldings,
    operatedAssetIds,
    returnsByClass,
    returnsById,
    trash,
    warnings,
  };
}
