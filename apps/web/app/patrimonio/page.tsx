import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  collectWarnings,
  groupPortfolio,
  listScopeOptions,
  projectPortfolio,
} from "@worthline/domain";
import type { PortfolioGroupKey, PriceRefreshMeta } from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  appendParam,
  buildCurrentUrlFor,
  parseFormError,
  parseGroupParam,
  parseScopeParam,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import Shell from "@web/shell";
import BalanceBoard from "./balance-board";
import PatrimonioGroupControls from "./group-controls";

export const dynamic = "force-dynamic";

export default async function PatrimonioPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/patrimonio", resolvedSearchParams);
  const selectedGroup = parseGroupParam(resolvedSearchParams?.group);

  const jar = await cookies();
  const queryScopeId = parseScopeParam(resolvedSearchParams?.scope);
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScopeId = queryScopeId ?? cookieScopeId;
    const selectedScope =
      scopes.find((scope) => scope.id === selectedScopeId) ?? scopes[0];

    // Price-refresh metadata for the derived-value badge hover (#303): when + by
    // which source each cached unit price was last fetched, keyed by asset id. The
    // projection attaches it to investment rows only; non-investment entries are
    // ignored downstream.
    const priceMetaByAsset = new Map<string, PriceRefreshMeta>(
      store.operations
        .readAllPriceCacheEntries()
        .map((entry) => [
          entry.assetId,
          { fetchedAt: entry.fetchedAt, source: entry.source },
        ]),
    );

    return {
      assets: store.assets.readAssets(),
      liabilities: store.liabilities.readLiabilities(),
      overrides: store.readWarningOverrides(),
      priceMetaByAsset,
      scopes,
      selectedScope,
      trash: store.readTrash(),
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const {
    assets,
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
        trash={trash}
        warnings={warnings}
      />
    </Shell>
  );
}
