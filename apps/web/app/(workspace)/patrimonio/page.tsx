import { ONBOARDING_RERUN_PARAM } from "@web/asistente/screen-context";
import { isDemoMode } from "@web/demo/write-guard";
import {
  appendParam,
  buildCurrentUrlFor,
  parseFormError,
  parseGroupParam,
  resolveOkMessage,
} from "@web/intake";
import { refreshPricesAction } from "@web/inversiones/actions";
import { resolvePageShell } from "@web/page-shell";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import { EXPOSURE_LENS_VIEW_PARAM, readViewParam } from "@web/view-state";
import type { PortfolioGroupKey } from "@worthline/domain";
import { systemClock } from "@worthline/domain";
import Link from "next/link";
import BalanceBoard from "./balance-board";
import ExposureSection from "./exposure-section";
import PatrimonioGroupControls from "./group-controls";
import { loadPatrimonio } from "./load-patrimonio";
import { PriceRefreshControl } from "./price-refresh-control";
import ReturnsByClassSection from "./returns-by-class-section";

export const dynamic = "force-dynamic";

export default async function PatrimonioPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  // Demo skips optimistic mutations — the write-guard rejects them, so a faked
  // change would only flicker before reverting (interaction-patterns §10).
  const isDemo = await isDemoMode();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/patrimonio", resolvedSearchParams);
  const selectedGroup = parseGroupParam(resolvedSearchParams?.group);

  const { persistence, privacyMode, selectedScope, store, workspace } =
    await resolvePageShell({ searchParams: resolvedSearchParams });

  // The sibling read model owns every data assembly (#1119); the page renders.
  const {
    exposureEquity,
    exposureFull,
    groups,
    hasHoldings,
    hasPricedHoldings,
    operatedAssetIds,
    returnsByClass,
    returnsById,
    trash,
    warnings,
  } = await loadPatrimonio({
    store,
    workspace,
    selectedScope,
    today: systemClock().today(),
    selectedGroup,
    readExposureProfiles: readExposureProfilesFromCatalog,
  });

  // The exposure lens is a pure view toggle over the two pre-rendered results
  // (interaction-patterns §2) — never a figure, so it stays a page-level param.
  const exposureLensRaw = resolvedSearchParams?.[EXPOSURE_LENS_VIEW_PARAM.key];
  const exposureLens = readViewParam(
    typeof exposureLensRaw === "string"
      ? `${EXPOSURE_LENS_VIEW_PARAM.key}=${exposureLensRaw}`
      : "",
    EXPOSURE_LENS_VIEW_PARAM,
  );

  const isHousehold = workspace.mode === "household";

  /** A /patrimonio URL that selects a grouping axis, preserving scope + feedback. */
  const groupHrefFor = (group: PortfolioGroupKey): string =>
    appendParam(currentUrl, "group", group);

  return (
    <>
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
          {hasHoldings ? (
            // Re-run the onboarding assistant over the existing portfolio (#1170):
            // «repasar mi cartera con un extracto». Premium ingestion is gated
            // downstream at the chat route (#1162); this is just the entry point.
            <Link
              className="actionLink"
              href={appendParam(currentUrl, ONBOARDING_RERUN_PARAM, "1")}
            >
              Repasar con el asistente
            </Link>
          ) : null}
          {hasPricedHoldings ? (
            <PriceRefreshControl
              action={refreshPricesAction}
              currentUrl={currentUrl}
              label="Actualizar precios"
              pendingLabel="Actualizando…"
            />
          ) : null}
        </div>
        {hasHoldings ? (
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
        returnsById={returnsById}
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
    </>
  );
}
