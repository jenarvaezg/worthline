import { ONBOARDING_RERUN_PARAM } from "@web/asistente/screen-context";
import { isDemoMode } from "@web/demo/write-guard";
import {
  appendParam,
  buildCurrentUrlFor,
  parseFormError,
  parseGroupParam,
  resolveOkMessage,
  resolveOkNotice,
} from "@web/intake";
import { refreshPricesAction } from "@web/inversiones/refresh-prices-action";
import { resolvePageShell } from "@web/page-shell";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import {
  EXPOSURE_LENS_VIEW_PARAM,
  type ExposureLens,
  readViewParam,
} from "@web/view-state";
import type { PortfolioGroupKey } from "@worthline/domain";
import { systemClock } from "@worthline/domain";
import Link from "next/link";
import { Suspense } from "react";
import BalanceBoard from "./balance-board";
import { BOARD_FOLD_PARAM, readOpenPortfolios } from "./board-fold";
import ExposureSection from "./exposure-section";
import PatrimonioGroupControls from "./group-controls";
import {
  deriveExposureAndReturns,
  loadPatrimonio,
  type PatrimonioExposureContext,
} from "./load-patrimonio";
import PatrimonioAnalyticsSkeleton from "./patrimonio-analytics-skeleton";
import PatrimonioSkeleton from "./patrimonio-skeleton";
import { PriceRefreshControl } from "./price-refresh-control";
import ReturnsByClassSection from "./returns-by-class-section";

export default function PatrimonioPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<PatrimonioSkeleton />}>
      <PatrimonioContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function PatrimonioContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = await searchParams;
  // Demo skips optimistic mutations — the write-guard rejects them, so a faked
  // change would only flicker before reverting (interaction-patterns §10).
  const isDemo = await isDemoMode();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  // A write can confirm AND ask (#1561): the question rides its own aviso band.
  const formNotice = resolveOkNotice(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/patrimonio", resolvedSearchParams);
  const selectedGroup = parseGroupParam(resolvedSearchParams?.group);
  // Which managed portfolios come unfolded (#1548). Read on the server so a
  // shared link paints open instead of flashing collapsed after hydration.
  const openPortfolios = readOpenPortfolios(
    new URLSearchParams(
      typeof resolvedSearchParams?.[BOARD_FOLD_PARAM] === "string"
        ? `${BOARD_FOLD_PARAM}=${resolvedSearchParams[BOARD_FOLD_PARAM]}`
        : "",
    ),
  );

  const { persistence, privacyMode, selectedScope, store, workspace } =
    await resolvePageShell({ searchParams: resolvedSearchParams });

  // The sibling read model owns every data assembly (#1119); the page renders.
  // This is the synchronous half (#1195): the CRUD board + header + status
  // bands render with the document, so the mutation flows below it never wait
  // on the exposure-profile catalog read (see `PatrimonioAnalytics`).
  const {
    exposureContext,
    groups,
    hasHoldings,
    hasPricedHoldings,
    operatedAssetIds,
    publicIdByHolding,
    publicIdByPortfolio,
    returnsById,
    trash,
    warnings,
  } = await loadPatrimonio({
    store,
    workspace,
    selectedScope,
    today: systemClock().today(),
    selectedGroup,
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
      {formNotice ? (
        <p className="warningBand" role="note">
          {formNotice}
        </p>
      ) : null}

      <section className="patrimonioHeader" aria-label="Activos y deudas">
        <div className="panelHeader">
          <h2>Patrimonio</h2>
          <span>Activos y deudas</span>
        </div>
        <div className="patrimonioActions">
          <Link className="actionLink" href="/patrimonio/carteras">
            Carteras gestionadas
          </Link>
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
        initialOpenPortfolios={openPortfolios}
        isHousehold={isHousehold}
        nowIso={persistence.checkedAt}
        operatedAssetIds={operatedAssetIds}
        privacyMode={privacyMode}
        publicIdByHolding={publicIdByHolding}
        publicIdByPortfolio={publicIdByPortfolio}
        readOnly={isDemo}
        returnsById={returnsById}
        trash={trash}
        trashOpen={resolvedSearchParams?.abrir === "papelera"}
        warnings={warnings}
      />

      <Suspense fallback={<PatrimonioAnalyticsSkeleton />}>
        <PatrimonioAnalytics
          currentUrl={currentUrl}
          exposureContext={exposureContext}
          initialLens={exposureLens}
          privacyMode={privacyMode}
        />
      </Suspense>
    </>
  );
}

/**
 * The two streamed /patrimonio analytics sub-sections (#1195): Exposición and
 * Rentabilidad por clase. Reads the global exposure-profile catalog — the one
 * I/O this page performs that the CRUD board above does not need — so this
 * await is what lets the synchronous board flush to the client first; the
 * derivation itself is shared with the read model's test via
 * `deriveExposureAndReturns`.
 */
async function PatrimonioAnalytics({
  currentUrl,
  exposureContext,
  initialLens,
  privacyMode,
}: {
  currentUrl: string;
  exposureContext: PatrimonioExposureContext;
  initialLens: ExposureLens;
  privacyMode: boolean;
}) {
  const profiles = await readExposureProfilesFromCatalog();
  const { exposureFull, exposureEquity, returnsByClass } = deriveExposureAndReturns(
    exposureContext,
    profiles,
  );

  return (
    <>
      <ExposureSection
        currentUrl={currentUrl}
        equity={exposureEquity}
        full={exposureFull}
        initialLens={initialLens}
        privacyMode={privacyMode}
      />

      {returnsByClass ? (
        <ReturnsByClassSection privacyMode={privacyMode} returns={returnsByClass} />
      ) : null}
    </>
  );
}
