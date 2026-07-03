import { bootstrapHealthcheck, withStore } from "@web/store";
import {
  collectWarnings,
  groupPortfolio,
  listScopeOptions,
  lookThroughExposure,
  projectPortfolio,
  systemClock,
} from "@worthline/domain";
import type {
  ExposureLookthroughHolding,
  ExposureProfile,
  PortfolioGroupKey,
  PriceRefreshMeta,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  appendParam,
  buildCurrentUrlFor,
  parseFormError,
  parseGroupParam,
  parsePrivacyCookie,
  parseScopeParam,
  parseScopeCookie,
  resolveOkMessage,
  PRIVACY_COOKIE_NAME,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { refreshPricesAction } from "@web/inversiones/actions";
import { isDemoMode } from "@web/demo/write-guard";
import Shell from "@web/shell";
import { EXPOSURE_LENS_VIEW_PARAM, readViewParam } from "@web/view-state";
import BalanceBoard from "./balance-board";
import ExposureSection from "./exposure-section";
import PatrimonioGroupControls from "./group-controls";
import { PriceRefreshControl } from "./price-refresh-control";

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
    ] = await Promise.all([
      store.operations.readAllPriceCacheEntries(),
      store.assets.readInvestmentAssetsWithMeta(),
      store.snapshots.readCurveValuedHoldingsAtDate(systemClock().today()),
      store.readWarningOverrides(),
      store.readTrash(),
      store.exposureProfiles.readExposureProfiles(),
    ]);

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

    return {
      assets,
      exposureProfiles,
      hasPricedHoldings,
      investmentMeta,
      liabilities,
      overrides,
      priceMetaByAsset,
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
    liabilities,
    overrides,
    priceMetaByAsset,
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
      warnings={warnings.map((w) => ({
        code: w.code,
        entityId: w.entityId,
        message: w.message,
      }))}
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
        privacyMode={privacyMode}
        readOnly={isDemo}
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
    </Shell>
  );
}
