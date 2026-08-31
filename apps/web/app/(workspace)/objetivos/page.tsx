import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { Suspense } from "react";
import { ContributionAllocation } from "./contribution-allocation";
import {
  ALLOCATION_MONTH_PARAM,
  parseAllocationMonthParam,
} from "./contribution-allocation-view";
import { ContributionAllowancePanel } from "./contribution-allowance-panel";
import { ContributionReconciliation } from "./contribution-reconciliation";
import { ExposureDriftSection } from "./exposure-drift-section";
import { parseExposureDriftGrowth, parseExposureDriftYear } from "./exposure-drift-view";
import { FireCockpit } from "./fire-cockpit";
import { GoalsSection } from "./goals-section";
import { loadObjetivos } from "./load-objetivos";
import ObjetivosSkeleton from "./objetivos-skeleton";
import { PassiveIncomePanel } from "./passive-income-panel";

export default function ObjetivosPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<ObjetivosSkeleton />}>
      <ObjetivosContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function ObjetivosContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const currentUrl = buildCurrentUrlFor("/objetivos", resolvedSearchParams);
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const { persistence, privacyMode, scopes, selectedScope, store, workspace } =
    await resolvePageShell({ searchParams: resolvedSearchParams });

  const today = new Date().toISOString().slice(0, 10);

  // The sibling read model owns every data assembly and every derivation (#1700,
  // the mould of `loadPatrimonio`); the page renders and owns the URL.
  const {
    achievement,
    ageSource,
    allocationDefaultMonth,
    allocationWindow,
    allowanceDestinationOptions,
    allowanceUsageById,
    assets,
    coastArrival,
    coastTickFraction,
    contributionOperations,
    contributionPlan,
    contributionProjection,
    debtServiceCoherence,
    derivedAllowances,
    exposureDriftTrajectories,
    fireLevelRail,
    fireProjection,
    fireResult,
    // El otro lado de la declaración del inmovilizado (#1473): la isla previsualiza el
    // check eligiendo lado, no recalculando capital y tasa en el cliente.
    fireResultImmobilizedFlipped,
    fireScopeConfig,
    goals: goalsView,
    holdingNameById,
    monthlyAllocations,
    passiveIncome,
    publicIdByAssetId,
    // ¿FIRE o jubilación ordinaria? (#1428.) Y la respuesta a «cuánto puedo gastar»,
    // calculada siempre: el perfil solo decide si es el titular.
    retirementProfile,
    savedDraft,
    savingsCoherence,
    savingsSuggestion,
    seededFromPlan,
    sustainableSpending,
    trashedHoldingIds,
    unitPrices,
  } = await loadObjetivos({
    persistence,
    scopes,
    selectedScope,
    store,
    today,
    workspace,
  });

  const currency = workspace.baseCurrency;

  // The three view params, clamped against the windows the read model served
  // (interaction-patterns §2): they select among pre-rendered results and never
  // change a figure, so they stay page-level state.
  const allocationInitialMonth = parseAllocationMonthParam(
    resolvedSearchParams[ALLOCATION_MONTH_PARAM],
    allocationWindow,
    allocationDefaultMonth,
  );
  const exposureDriftInitialGrowth = parseExposureDriftGrowth(
    typeof resolvedSearchParams.driftGrowth === "string"
      ? resolvedSearchParams.driftGrowth
      : undefined,
  );
  const exposureDriftInitialYear = exposureDriftTrajectories
    ? parseExposureDriftYear(
        typeof resolvedSearchParams.driftYear === "string"
          ? resolvedSearchParams.driftYear
          : undefined,
        exposureDriftTrajectories[exposureDriftInitialGrowth],
      )
    : 0;

  return (
    <div className="objetivosPage">
      <header className="objetivosHeader">
        <h2>Objetivos</h2>
        <p>Tu independencia financiera y tus metas con fecha</p>
      </header>

      {/* Un error sin formulario propio — el guard de la demo, un scope que ya no
          existe — no tiene dónde pintarse dentro de un panel, y sin esta banda la
          acción rebotaba en silencio: el usuario pulsaba Guardar y no pasaba nada
          visible (#1450). */}
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

      {/* ── Cockpit FIRE: los supuestos a la izquierda, sus consecuencias a la
          derecha (#1450). Editas aquí, ves ahí — antes eran dos pantallas, y
          ahora las cifras se mueven mientras se teclea. Todo lo que la isla
          recibe está calculado en el servidor: la primera pintura es la RSC
          auditable de #1426, y el cliente solo re-hace la aritmética de los
          supuestos cuando el usuario cambia uno. ── */}
      <FireCockpit
        achievement={achievement}
        ageSource={ageSource}
        coastArrival={coastArrival}
        coastTickFraction={coastTickFraction}
        config={fireScopeConfig}
        currency={currency}
        currentUrl={currentUrl}
        debtServiceCoherence={debtServiceCoherence}
        errorMessage={formError?.formId === "fire" ? formError.message : null}
        fireLevelRail={fireLevelRail}
        fireProjection={fireProjection}
        fireResult={fireResult}
        fireResultImmobilizedFlipped={fireResultImmobilizedFlipped}
        privacyMode={privacyMode}
        retirementProfile={retirementProfile}
        savedDraft={savedDraft}
        savingsCoherence={savingsCoherence}
        savingsSuggestion={savingsSuggestion}
        scopeId={selectedScope?.id ?? null}
        publicIdByAssetId={publicIdByAssetId}
        seededFromPlan={seededFromPlan}
        sustainableSpending={sustainableSpending}
      />

      {monthlyAllocations ? (
        <ContributionAllocation
          currency={currency}
          defaultMonthKey={allocationDefaultMonth}
          holdings={Object.fromEntries(
            assets.map((asset) => [asset.id, { name: asset.name, type: asset.type }]),
          )}
          initialMonthKey={allocationInitialMonth}
          months={monthlyAllocations}
          privacyMode={privacyMode}
        />
      ) : null}

      {exposureDriftTrajectories ? (
        <ExposureDriftSection
          currency={currency}
          initialGrowth={exposureDriftInitialGrowth}
          initialYear={exposureDriftInitialYear}
          privacyMode={privacyMode}
          trajectories={exposureDriftTrajectories}
        />
      ) : null}

      {selectedScope ? (
        <ContributionAllowancePanel
          allowances={derivedAllowances}
          currency={currency}
          currentUrl={currentUrl}
          destinationOptions={allowanceDestinationOptions}
          formError={formError}
          holdingNameById={holdingNameById}
          privacyMode={privacyMode}
          scopeId={selectedScope.id}
          trashedHoldingIds={trashedHoldingIds}
          usageById={allowanceUsageById}
        />
      ) : null}

      {contributionPlan && contributionProjection ? (
        <ContributionReconciliation
          assets={assets}
          currency={currency}
          currentUrl={currentUrl}
          operations={contributionOperations}
          plan={contributionPlan}
          projection={contributionProjection}
          suggestedPriceByHoldingId={unitPrices}
          {...(typeof resolvedSearchParams.reconcile === "string"
            ? { selectedOccurrenceId: resolvedSearchParams.reconcile }
            : {})}
        />
      ) : null}

      {/* ── Renta pasiva lens (#658) ──────────────────────────────── */}
      {passiveIncome ? (
        <PassiveIncomePanel
          currency={currency}
          debtServiceCoherence={debtServiceCoherence}
          lens={passiveIncome}
          privacyMode={privacyMode}
        />
      ) : null}

      {/* ── Goals (editable; S3) ──────────────────────────────────── */}
      <GoalsSection
        assets={assets}
        currency={currency}
        currentUrl={currentUrl}
        formError={formError}
        goals={goalsView}
        privacyMode={privacyMode}
        selectedScope={selectedScope}
      />
    </div>
  );
}
