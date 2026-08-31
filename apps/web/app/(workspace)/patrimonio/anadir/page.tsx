import FormRouteSkeleton from "@web/form-route-skeleton";
import { parseFormError, resolveOkMessage, resolveOkNotice } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import {
  altaRevealCss,
  DRAWER_EMPTY_PROPS,
  DRAWER_FIELD,
  DRAWERS,
  type DrawerId,
} from "@web/patrimonio/anadir/_families/alta-drawers";
import {
  AltaDrawerPane,
  type AltaPaneContext,
} from "@web/patrimonio/anadir/_families/alta-panes";
import { loadInvestmentLivePrice } from "@web/patrimonio/anadir/_families/investment-pane";
import { OwnershipInputs } from "@web/patrimonio/anadir/ownership-inputs";
import {
  firstNonEmptyParam,
  selectedInstrumentFromAddHoldingState,
} from "@web/patrimonio/anadir/search-state";
import { AddSuccessPanel } from "@web/patrimonio/anadir/success-panel";
import { createHoldingAction } from "@web/patrimonio/create-holding-action";
import { calculateNetWorth, formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { type CSSProperties, Suspense } from "react";

export default function AnadirHoldingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<FormRouteSkeleton label="Cargando añadir holding" />}>
      <AnadirHoldingContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function AnadirHoldingContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = await searchParams;
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  // The alta's non-blocking question, when the redirect carries one (#1561).
  const formNotice = resolveOkNotice(resolvedSearchParams);

  const { privacyMode, scopes, selectedScope, store, workspace } = await resolvePageShell(
    { searchParams: resolvedSearchParams },
  );

  // Holdings drive the first-run copy (no holdings yet → warm welcome, #600)
  // and the running net-worth total shown on the success screen's loop.
  const [assets, liabilities] = await Promise.all([
    store.assets.readAssets(),
    store.liabilities.readLiabilities(),
  ]);
  const netWorth = calculateNetWorth({
    assets,
    liabilities,
    scopeId: selectedScope?.id ?? scopes[0]?.id ?? "",
    workspace,
  });

  const activeMembers = workspace.members.filter((m) => !m.disabledAt);
  const currency = workspace.baseCurrency;
  const hasHoldings = assets.length > 0 || liabilities.length > 0;
  const hasPrimaryResidence = assets.some((asset) => asset.isPrimaryResidence);
  const netWorthMinor = netWorth.totalNetWorth.amountMinor;
  const resolvedParams = resolvedSearchParams ?? {};
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;
  const values = formError?.formId === "holding" ? formError.values : {};

  // The drawer (and the investment group) must survive a search/pick navigation,
  // so resolve them from BOTH the preserved error values AND the URL params (#597).
  const selectedDrawer = (values[DRAWER_FIELD] ??
    firstNonEmptyParam(resolvedParams[DRAWER_FIELD])) as DrawerId | undefined;
  const selectedInstrument = selectedInstrumentFromAddHoldingState(
    values,
    resolvedParams,
  );

  // Success-loop state (#600): a completed add returns to the wizard with `ok`
  // (the message) + `added` (the new holding's id). The success panel replaces
  // the form so the user can chain adds; the running net worth is the hook.
  const okKey = firstNonEmptyParam(resolvedParams["ok"]);
  const addedId = firstNonEmptyParam(resolvedParams["added"]);
  const isSuccess = Boolean(formOk);
  const firstRun = !hasHoldings;
  const netWorthLabel = formatMoneyMinorPrivacy(
    { amountMinor: netWorthMinor, currency },
    privacyMode,
  );
  // "Hoy" for the debt drawer's «alta por estado actual» baseline (ADR 0056, #677).
  const today = new Date().toISOString().slice(0, 10);

  // Everything the five panes read, resolved once (ADR 0095, applied to the alta):
  // the page assembles the context and places whatever each drawer's family
  // renders — it never asks which instrument this is.
  const paneContext: AltaPaneContext = {
    hasPrimaryResidence,
    livePrice: await loadInvestmentLivePrice({
      resolvedParams,
      selectedDrawer,
      selectedInstrument,
      values,
    }),
    resolvedParams,
    selectedInstrument,
    today,
    values,
  };

  return (
    <>
      {/* The disclosure is pure CSS (ADR 0009) and every rule is generated from
          the same drawer/group table the panes below read (#1700), so a renamed
          class can no longer break the visibility in silence. */}
      <style>{altaRevealCss()}</style>

      <section className="addHoldingPage" aria-label="Añadir al patrimonio">
        {isSuccess ? (
          <AddSuccessPanel
            addedId={addedId}
            isInvestment={
              okKey === "investment_added" || okKey === "investment_transfer_in_added"
            }
            message={formOk!}
            netWorthLabel={netWorthLabel}
            notice={formNotice}
          />
        ) : (
          <>
            <div className="panelHeader addHoldingHeader">
              <h2 id="add-holding-title">Añade algo a tu patrimonio</h2>
              <Link href="/patrimonio">← Volver</Link>
            </div>
            <div className="simpleIntro">
              <p className="addHoldingLead">
                {firstRun
                  ? "¡Bienvenido! Empieza por tu primera cosa —una cuenta, una inversión, tu casa— y verás tu patrimonio tomar forma. Solo el nombre y el importe; el resto vive después en la ficha."
                  : "Elige el cajón, apunta el nombre y el importe. El resto vive después en la ficha."}
              </p>
              <Link className="actionLink" href="/patrimonio/anadir/avanzado">
                Modo avanzado
              </Link>
            </div>

            {formError?.formId === "holding" ? (
              <p className="errorBand" role="alert">
                {formError.message}
              </p>
            ) : null}

            <form action={createHoldingAction} className="simpleAdd">
              <div
                className="simpleDrawerGrid"
                role="group"
                aria-label="Qué quieres añadir"
              >
                {DRAWERS.map((drawer) => (
                  <label
                    className="simpleDrawerCard"
                    key={drawer.id}
                    style={{ "--dot": drawer.dot } as CSSProperties}
                  >
                    <input
                      defaultChecked={selectedDrawer === drawer.id}
                      name={DRAWER_FIELD}
                      type="radio"
                      value={drawer.id}
                    />
                    <span className="addHoldingDot" aria-hidden="true" />
                    <span className="simpleDrawerCopy">
                      <strong>{drawer.label}</strong>
                      <small>{drawer.hint}</small>
                    </span>
                  </label>
                ))}
              </div>

              <section className="simpleAddPanes" aria-live="polite">
                <p {...DRAWER_EMPTY_PROPS}>
                  Elige arriba qué quieres apuntar y aquí aparecerá lo justo que hay que
                  rellenar.
                </p>
                {DRAWERS.map((drawer) => (
                  <AltaDrawerPane ctx={paneContext} drawer={drawer} key={drawer.id} />
                ))}
              </section>

              <OwnershipInputs
                allowCustomSplit={selectedDrawer === "inmueble"}
                members={activeMembers}
                scopeMemberId={ownershipScopeMemberId}
                values={values}
              />
            </form>
          </>
        )}
      </section>
    </>
  );
}
