import { ChipChoice } from "@web/chip-choice";
import {
  readDebtModelByLiabilityId,
  readMonthlyDebtServiceByLiabilityId,
} from "@web/debt-service-reads";
import { holdingPublicIdIndex } from "@web/holding-route";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { PendingSubmit } from "@web/pending-submit";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import type {
  HoldingReturnsView,
  PassiveIncomeLens,
  SpendingDebtServiceCoherence,
} from "@worthline/domain";
import {
  collectHoldingPayouts,
  computeContributionAllowanceUsage,
  computeMonthlyContributionAllocation,
  formatMoneyMinorPrivacy,
  instrumentOfAsset,
  investmentReturnsById,
  monthlyCloseValuesByHolding,
  prepareObjetivosState,
  projectContributionReconciliation,
  resolveScopeMemberIds,
  scopeAgeSource,
  scopePassiveIncome,
  spendingDebtServiceCoverageNote,
  suggestMonthlySavingsCapacity,
  unitPriceMajorByHoldingId,
} from "@worthline/domain";
import Link from "next/link";
import { Suspense } from "react";
import { buildExposureDriftTrajectories } from "./build-exposure-drift";
import { ContributionAllocation } from "./contribution-allocation";
import {
  ALLOCATION_MONTH_PARAM,
  allocationMonthKeys,
  parseAllocationMonthParam,
} from "./contribution-allocation-view";
import { ContributionAllowancePanel } from "./contribution-allowance-panel";
import {
  contributionAllowanceDestinationOptions,
  contributionAllowanceOperations,
  trashAssetToHolding,
  withDerivedAllowanceDestinations,
} from "./contribution-allowance-view";
import { ContributionReconciliation } from "./contribution-reconciliation";
import { ExposureDriftSection } from "./exposure-drift-section";
import { parseExposureDriftGrowth, parseExposureDriftYear } from "./exposure-drift-view";
import { FireCockpit } from "./fire-cockpit";
import { fireConfigFieldValues } from "./fire-config-form-view";
import { formatDay } from "./format-day";
import { createGoalAction, deleteGoalAction, updateGoalAction } from "./goal-actions";
import ObjetivosSkeleton from "./objetivos-skeleton";

/**
 * Passive-income lens (#658): the selected scope's trailing-12m payouts against
 * declared spending — "how much of my spending do my holdings already pay?".
 * Server-rendered; honest about window and coverage (no annualization, coverage
 * only when spending is known).
 */
function PassiveIncomePanel({
  lens,
  currency,
  debtServiceCoherence,
  privacyMode,
}: {
  lens: PassiveIncomeLens;
  currency: string;
  /**
   * El careo del gasto declarado contra las cuotas vigentes (#1520). La cobertura
   * compara con un gasto cuyo significado depende de si incluye la hipoteca, así que
   * la tarjeta lo dice — incluido cuando el usuario no lo ha declarado.
   */
  debtServiceCoherence: SpendingDebtServiceCoherence | null;
  privacyMode: boolean;
}) {
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  const debtServiceNote =
    debtServiceCoherence === null
      ? null
      : spendingDebtServiceCoverageNote(debtServiceCoherence, currency, privacyMode);
  const coveragePct =
    lens.coverageRatio != null
      ? `${(lens.coverageRatio * 100).toFixed(1).replace(".", ",")} %`
      : null;

  return (
    <section className="firePanel objetivosPasivaPanel" aria-label="Renta pasiva">
      <div className="panelHeader">
        <h3>Renta pasiva</h3>
        <span>cuánto de tu gasto ya pagan tus activos</span>
      </div>

      {lens.hasPayouts ? (
        <>
          <div className="objetivosPasivaTop">
            <div className="objetivosPasivaFigure">
              {/* Neto como titular (#1463): es de lo que se vive. El bruto no
                  desaparece — baja a la sub-línea, solo cuando difieran. */}
              <span className="objetivosPasivaCap">
                {lens.expensesMinor > 0
                  ? "Cobros netos · últimos 12 meses"
                  : "Cobros · últimos 12 meses"}
              </span>
              <strong className="objetivosPasivaBig">{fmt(lens.netMinor)}</strong>
              {lens.expensesMinor > 0 ? (
                <span className="objetivosPasivaCap">
                  brutos {fmt(lens.totalMinor)} − gastos declarados{" "}
                  {fmt(lens.expensesMinor)}
                </span>
              ) : null}
            </div>
            {coveragePct != null ? (
              <div className="objetivosPasivaFigure objetivosPasivaCoverage">
                <strong className="objetivosPasivaBig">{coveragePct}</strong>
                <span className="objetivosPasivaCap">de tu gasto declarado</span>
              </div>
            ) : null}
          </div>

          {lens.coverageRatio != null ? (
            <div className="objetivosPasivaBar" aria-hidden="true">
              {/* Un neto negativo (gastos > renta) es declarable: la barra se queda a 0. */}
              <i
                style={{
                  width: `${Math.min(100, Math.max(0, lens.coverageRatio * 100))}%`,
                }}
              />
            </div>
          ) : null}

          <p className="objetivosPasivaNote">
            Ventana: {formatDay(lens.windowStartISO)} – {formatDay(lens.windowEndISO)} ·{" "}
            {lens.count} {lens.count === 1 ? "cobro" : "cobros"}
            {lens.annualSpendingMinor != null
              ? ` · cobertura sobre ${fmt(lens.annualSpendingMinor)}/año`
              : " · añade tu gasto en tus supuestos para ver la cobertura"}
            . Suma cobros reales del periodo, sin anualizar los parciales.
          </p>

          {/* Contra QUÉ gasto se mide esa cobertura (#1520). Solo cuando hay cobertura
              que glosar: sin gasto declarado no hay porcentaje del que hablar. */}
          {debtServiceNote && lens.coverageRatio != null ? (
            <p className="objetivosPasivaNote">{debtServiceNote}</p>
          ) : null}
        </>
      ) : (
        <p className="objetivosPasivaEmpty">
          Aún no has registrado cobros (dividendos, intereses o alquileres) en este
          ámbito. Regístralos en la ficha de cada activo para ver cuánto de tu gasto ya
          cubren.
        </p>
      )}
    </section>
  );
}

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
  const projectionContext = await store.snapshots.buildProjectionContext();
  const [
    { assets, liabilities },
    goals,
    fireConfig,
    payoutRecords,
    payoutSchedules,
    contributionPlan,
    contributionReconciliations,
    contributionAllowances,
    priceCache,
    investmentMeta,
    exposureProfiles,
    returnSnapshotRows,
    publicIdRows,
  ] = await Promise.all([
    store.snapshots.readCurveValuedHoldingsAtDate(today, projectionContext),
    selectedScope ? store.goals.readGoals(selectedScope.id) : Promise.resolve([]),
    // Derived FIRE age measured on this page's "today" (#1415).
    store.readFireConfig(today),
    store.payouts.readPayouts(),
    store.payouts.readPayoutSchedules(),
    selectedScope
      ? store.contributionPlan.readContributionPlan(selectedScope.id)
      : Promise.resolve(null),
    selectedScope
      ? store.contributionPlan.readReconciliations(selectedScope.id)
      : Promise.resolve([]),
    selectedScope
      ? store.contributionAllowances.readContributionAllowances(selectedScope.id)
      : Promise.resolve([]),
    store.operations.readAllPriceCacheEntries(),
    store.assets.readInvestmentAssetsWithMeta(),
    readExposureProfilesFromCatalog(),
    store.snapshots.readSnapshotHoldings({
      includePositions: false,
      kind: "asset",
      scopeId: selectedScope?.id ?? "household",
    }),
    store.agentView.readPublicIds(),
  ]);

  // La cuota vigente de cada deuda (#1520), para que las dos tarjetas de €/mes digan
  // bajo qué supuesto hablan. Va después de la tanda de arriba porque necesita las
  // deudas ya leídas, y solo toca las que declaran modelo amortizable — en una
  // cartera real, una o dos.
  const debtServiceByLiabilityId = await readMonthlyDebtServiceByLiabilityId(
    store.agentView,
    await readDebtModelByLiabilityId(store.agentView, liabilities),
    today,
  );

  const publicIdByAssetId = Object.fromEntries(
    holdingPublicIdIndex(publicIdRows).publicByInternal,
  );

  // Derived from projectionContext.operationsByAsset (already read above via
  // buildProjectionContext) instead of one readOperations query per investment
  // asset — same rows, same per-asset order (readAllOperations sorts by
  // executedAt, occurredAt, id, matching readOperations) (#1235).
  const contributionOperations = assets
    .filter((asset) => asset.type === "investment")
    .flatMap((asset) => projectionContext.operationsByAsset.get(asset.id) ?? []);

  // Recorded payouts up to today, keyed by holding — the single source S1
  // owns, so this surface never re-derives a schedule.
  const payoutsByHolding = collectHoldingPayouts(payoutRecords, payoutSchedules, today);

  const {
    achievement,
    debtServiceCoherence,
    savingsCoherence,
    fireProjection,
    fireResult,
    // El otro lado de la declaración del inmovilizado (#1473): la isla previsualiza el
    // check eligiendo lado, no recalculando capital y tasa en el cliente.
    fireResultImmobilizedFlipped,
    fireScopeConfig,
    coastArrival,
    coastTickFraction,
    goals: goalsView,
    fireLevelRail,
    // ¿FIRE o jubilación ordinaria? (#1428.) Y la respuesta a «cuánto puedo gastar»,
    // calculada siempre: el perfil solo decide si es el titular.
    retirementProfile,
    sustainableSpending,
  } = prepareObjetivosState({
    assets,
    // Las cuotas que el testigo del gasto declarado cruza (#1520) — leídas arriba,
    // así que la glosa de las tarjetas y el aviso de salud citan la misma cifra.
    debtServiceByLiabilityId,
    fireConfig,
    goals,
    // The ledger behind the achievement-badge veto (#1449) — already read above.
    investmentOperationsByAssetId: projectionContext.operationsByAsset,
    liabilities,
    // The declared rents the FIRE rate reads (#1448) — already loaded above for the
    // passive-income lens, so the two surfaces cannot disagree about them.
    payoutSchedules,
    persistence,
    positions: [],
    priceCache,
    scopes,
    selectedScope,
    selectedView: "liquid",
    snapshots: [],
    today,
    workspace,
  });

  const currency = workspace.baseCurrency;

  // Where the FIRE age came from (#1415), so the assumptions fold can cite the birth
  // year instead of showing an age that looks typed in. Same rule the reader used:
  // `scopeCurrentAge` IS this function's `.age`.
  const ageSource = selectedScope
    ? (scopeAgeSource(workspace, selectedScope.id, today) ?? null)
    : null;

  // Los supuestos se editan aquí (#1450), así que esta página carga lo que el
  // formulario necesita y /ajustes deja de hacerlo: la sugerencia de ahorro por
  // histórico (#425) se saca de las operaciones que ya están leídas arriba.
  const savingsSuggestion = suggestMonthlySavingsCapacity(contributionOperations);
  const seededFromPlan = fireScopeConfig?.monthlySavingsCapacitySeededFromPlan === true;
  // El borrador inicial de la isla sale de los MISMOS valores que precarga el
  // formulario: si divergieran, la pantalla nacería creyendo que hay cambios sin
  // guardar (o al revés, tapando los que hay).
  const savedFieldValues = fireConfigFieldValues(fireScopeConfig);
  const savedDraft = {
    // La declaración del inmovilizado sale de los MISMOS valores del formulario
    // (#1473): un defecto distinto aquí haría nacer la pantalla creyendo que el check
    // está sin guardar.
    countImmobilized: savedFieldValues.immobilizedCounts,
    monthlySavingsCapacity: savedFieldValues.monthlySavingsCapacity ?? "",
    monthlySpending: savedFieldValues.monthlySpending ?? "",
    safeWithdrawalRate: savedFieldValues.safeWithdrawalRate,
    // Lo guardado, para que tocar el `select` cuente como cambio sin guardar (#1520).
    spendingIncludesDebtService: savedFieldValues.spendingIncludesDebtService,
    targetRetirementAge: savedFieldValues.targetRetirementAge ?? "",
  };

  // Monthly allocation view (#557): the plan's capital split for a window of
  // months, every month server-rendered once; the island toggles client-side.
  const allocationWindow = allocationMonthKeys(today);
  const allocationDefaultMonth = allocationWindow[1] ?? today.slice(0, 7);
  const allocationInitialMonth = parseAllocationMonthParam(
    resolvedSearchParams[ALLOCATION_MONTH_PARAM],
    allocationWindow,
    allocationDefaultMonth,
  );
  const unitPrices = unitPriceMajorByHoldingId(priceCache);
  const monthlyAllocations =
    contributionPlan && contributionPlan.contributions.length > 0
      ? allocationWindow.map((monthKey) =>
          computeMonthlyContributionAllocation({
            plan: contributionPlan,
            monthKey,
            today,
            unitPriceMajorByHoldingId: unitPrices,
            reconciliations: contributionReconciliations,
            operations: contributionOperations,
          }),
        )
      : null;

  const contributionProjection = contributionPlan
    ? projectContributionReconciliation({
        plan: contributionPlan,
        fromDate:
          contributionPlan.contributions.map((item) => item.startDate).sort()[0] ?? today,
        toDate: new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        today,
        reconciliations: contributionReconciliations,
        operations: contributionOperations,
      })
    : null;

  // Cupo anual de aportación (#1427): el tope lo declaró el usuario; lo consumido
  // sale del libro de operaciones del año natural en curso — nunca de lo que el
  // plan preveía aportar, que induciría a pasarse creyendo que queda margen.
  //
  // Y lo consumido sale de los planes de pensiones del alcance, vivos o en la
  // papelera (#1509, #1567): un plan traspasado se vacía y se manda a la papelera,
  // y sus aportaciones de este año siguen habiendo consumido cupo. Un fondo
  // marcado en un snapshot viejo no cuenta, ni vivo ni en la papelera. Un PP
  // dado de alta después del último save cuenta porque los destinos se
  // re-derivan del instrumento en cada lectura.
  const liveHoldingIds = new Set(assets.map((asset) => asset.id));
  const trashedHoldings =
    contributionAllowances.length > 0 ? (await store.readTrash()).assets : [];
  const derivedAllowances = contributionAllowances.map((allowance) =>
    withDerivedAllowanceDestinations(allowance, [
      ...assets,
      ...trashedHoldings.map(trashAssetToHolding),
    ]),
  );
  const allowanceOperations = contributionAllowanceOperations({
    allowances: derivedAllowances,
    liveHoldingIds,
    liveOperations: contributionOperations,
    operationsByAsset: projectionContext.operationsByAsset,
  });
  const allowanceUsageById = new Map(
    derivedAllowances.map((allowance) => [
      allowance.id,
      computeContributionAllowanceUsage({
        allowance,
        currency,
        operations: allowanceOperations,
        todayISO: today,
      }),
    ]),
  );
  const allowanceDestinationOptions = contributionAllowanceDestinationOptions(assets);
  // Los nombres incluyen los de la papelera: un destino cuyas aportaciones SÍ se
  // cuentan tiene que poder nombrarse, o el panel lo tacharía de invisible (#1509).
  const holdingNameById = new Map([
    ...assets.map((asset): [string, string] => [asset.id, asset.name]),
    ...trashedHoldings.map((holding): [string, string] => [holding.id, holding.name]),
  ]);
  const trashedHoldingIds = new Set(trashedHoldings.map((holding) => holding.id));

  // Passive-income lens (#658): the selected scope's trailing-12m payouts,
  // weighted by ownership, against declared spending. Server-rendered figures;
  // coverage is shown only when spending is known.
  const passiveIncome: PassiveIncomeLens | null = selectedScope
    ? scopePassiveIncome({
        payoutsByHolding,
        holdings: assets,
        scopeMemberIds: new Set(resolveScopeMemberIds(workspace, selectedScope.id)),
        monthlySpendingMinor: fireScopeConfig?.monthlySpendingMinor ?? null,
        todayISO: today,
      })
    : null;

  const assumedAnnualReturn = fireResult?.context.realReturnUsed ?? 0.05;
  const exposureDriftHorizon =
    fireProjection?.scenarios.find((scenario) => scenario.label === "base")
      ?.yearsToFire ?? 20;
  const exposureDriftPlan =
    contributionPlan && selectedScope && contributionPlan.contributions.length > 0
      ? { plan: contributionPlan, scope: selectedScope }
      : null;
  let holdingReturnsById = new Map<string, HoldingReturnsView | null>();
  if (exposureDriftPlan) {
    const instrumentByAsset = new Map(
      assets.map((asset) => [asset.id, instrumentOfAsset(asset)]),
    );
    const monthlyClosesByAsset = monthlyCloseValuesByHolding(
      returnSnapshotRows.filter((row) =>
        projectionContext.operationsByAsset.has(row.holdingId),
      ),
    );
    const payoutsByAsset = new Map(
      [...payoutsByHolding].map(([assetId, rows]) => [
        assetId,
        rows.map((row) => ({ amountMinor: row.amountMinor, date: row.dateISO })),
      ]),
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
    holdingReturnsById = new Map<string, HoldingReturnsView | null>(
      [...investmentReturns].map(([assetId, view]) => [assetId, view]),
    );
  }
  const exposureDriftTrajectoriesData = exposureDriftPlan
    ? buildExposureDriftTrajectories({
        workspace,
        scope: exposureDriftPlan.scope,
        assets,
        liabilities,
        investmentMeta,
        exposureProfiles,
        contributionPlan: exposureDriftPlan.plan,
        assumedAnnualReturn,
        holdingReturnsById,
        unitPrices,
        today,
        maxYears: exposureDriftHorizon,
      })
    : null;
  const exposureDriftInitialGrowth = parseExposureDriftGrowth(
    typeof resolvedSearchParams.driftGrowth === "string"
      ? resolvedSearchParams.driftGrowth
      : undefined,
  );
  const exposureDriftInitialYear = exposureDriftTrajectoriesData
    ? parseExposureDriftYear(
        typeof resolvedSearchParams.driftYear === "string"
          ? resolvedSearchParams.driftYear
          : undefined,
        exposureDriftTrajectoriesData[exposureDriftInitialGrowth],
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

      {exposureDriftTrajectoriesData ? (
        <ExposureDriftSection
          currency={currency}
          initialGrowth={exposureDriftInitialGrowth}
          initialYear={exposureDriftInitialYear}
          privacyMode={privacyMode}
          trajectories={exposureDriftTrajectoriesData}
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
      <section className="firePanel" aria-label="Objetivos">
        <div className="panelHeader">
          <h3>Tus objetivos</h3>
          <span>
            {goalsView.length} {goalsView.length === 1 ? "objetivo" : "objetivos"}
          </span>
        </div>

        {selectedScope ? (
          <>
            {goalsView.length === 0 ? (
              <p className="muted">Aún no hay objetivos en este scope.</p>
            ) : null}

            <div className="goalList">
              {goalsView.map(
                ({
                  goal,
                  reservedMinor,
                  fundedRatioBps,
                  countsTowardFire,
                  fireDelay,
                }) => {
                  const editValues =
                    formError?.formId === `goal-${goal.id}` ? formError.values : {};
                  const ev = (field: string, fallback: string) =>
                    editValues[field] ?? fallback;
                  const editAssetIds = editValues.assetIds
                    ? editValues.assetIds.split(",").filter(Boolean)
                    : null;

                  return (
                    <div className="goalRow" id={`goalEdit-${goal.id}`} key={goal.id}>
                      <form action={updateGoalAction} className="stackForm">
                        <input name="currentUrl" type="hidden" value={currentUrl} />
                        <input name="id" type="hidden" value={goal.id} />
                        <input name="scopeId" type="hidden" value={selectedScope.id} />
                        {formError?.formId === `goal-${goal.id}` ? (
                          <p className="formError" role="alert">
                            {formError.message}
                          </p>
                        ) : null}
                        <label>
                          Nombre
                          <input defaultValue={ev("name", goal.name)} name="name" />
                        </label>
                        <div className="goalFieldRow">
                          <label>
                            Importe objetivo (EUR)
                            <input
                              defaultValue={ev(
                                "targetAmount",
                                (goal.targetAmountMinor / 100).toString(),
                              )}
                              inputMode="decimal"
                              name="targetAmount"
                            />
                          </label>
                          <label>
                            Fecha límite
                            <input
                              defaultValue={ev("deadline", goal.deadline)}
                              name="deadline"
                              type="date"
                            />
                          </label>
                        </div>
                        <span className="memberProfileLabel">Prioridad</span>
                        <span className="segmented">
                          {(["high", "medium", "low"] as const).map((level) => (
                            <label key={level}>
                              <input
                                defaultChecked={ev("priority", goal.priority) === level}
                                name="priority"
                                type="radio"
                                value={level}
                              />
                              {level === "high"
                                ? "Alta"
                                : level === "medium"
                                  ? "Media"
                                  : "Baja"}
                            </label>
                          ))}
                        </span>
                        <span className="memberProfileLabel">
                          Elige qué activos financian el objetivo
                        </span>
                        <ChipChoice
                          name="assetIds"
                          options={assets}
                          selectedIds={editAssetIds ?? goal.assetIds}
                        />
                        <div className="goalFunded">
                          <span className="memberProfileLabel">
                            {(fundedRatioBps / 100).toFixed(0)} % financiado
                          </span>
                          <div className="fundedBar">
                            <i
                              className={fundedRatioBps >= 10_000 ? "full" : undefined}
                              style={{
                                width: `${Math.min(100, fundedRatioBps / 100)}%`,
                              }}
                            />
                          </div>
                          <span className="muted">
                            Reservado{" "}
                            {formatMoneyMinorPrivacy(
                              { amountMinor: reservedMinor, currency },
                              privacyMode,
                            )}
                          </span>
                          {!countsTowardFire ? (
                            <span className="objetivosGoalNote">no descuenta FIRE</span>
                          ) : fireDelay.kind === "delays" ? (
                            <span className="objetivosGoalNote fireDelay">
                              {fireDelay.months === 0
                                ? "Retrasa tu FIRE menos de 1 mes"
                                : `Retrasa tu FIRE +${fireDelay.months} ${fireDelay.months === 1 ? "mes" : "meses"}`}
                            </span>
                          ) : (
                            <span className="objetivosGoalNote">No afecta a tu FIRE</span>
                          )}
                        </div>
                        <PendingSubmit pendingLabel="Guardando…">
                          Guardar objetivo
                        </PendingSubmit>
                      </form>
                      <form action={deleteGoalAction}>
                        <input name="currentUrl" type="hidden" value={currentUrl} />
                        <input name="id" type="hidden" value={goal.id} />
                        <details suppressHydrationWarning className="confirmDelete">
                          <summary>Eliminar</summary>
                          <PendingSubmit pendingLabel="Borrando…">
                            Confirmar borrado
                          </PendingSubmit>
                        </details>
                      </form>
                    </div>
                  );
                },
              )}
            </div>

            <div className="createBlock">
              <div className="memberProfileLabel">Nuevo objetivo</div>
              {(() => {
                const cv = formError?.formId === "goal" ? formError.values : {};
                const createPriority = cv.priority ?? "medium";
                const createAssetIds = cv.assetIds
                  ? cv.assetIds.split(",").filter(Boolean)
                  : null;
                return (
                  <form
                    action={createGoalAction}
                    className="stackForm"
                    id="goalCreateForm"
                  >
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="scopeId" type="hidden" value={selectedScope.id} />
                    {formError?.formId === "goal" ? (
                      <p className="formError" role="alert">
                        {formError.message}
                      </p>
                    ) : null}
                    <label>
                      Nombre
                      <input
                        defaultValue={cv.name}
                        name="name"
                        placeholder="Entrada vivienda"
                      />
                    </label>
                    <div className="goalFieldRow">
                      <label>
                        Importe objetivo (EUR)
                        <input
                          defaultValue={cv.targetAmount}
                          inputMode="decimal"
                          name="targetAmount"
                          placeholder="60000"
                        />
                      </label>
                      <label>
                        Fecha límite
                        <input defaultValue={cv.deadline} name="deadline" type="date" />
                      </label>
                    </div>
                    <span className="memberProfileLabel">Prioridad</span>
                    <span className="segmented">
                      {(["high", "medium", "low"] as const).map((level) => (
                        <label key={level}>
                          <input
                            defaultChecked={createPriority === level}
                            name="priority"
                            type="radio"
                            value={level}
                          />
                          {level === "high"
                            ? "Alta"
                            : level === "medium"
                              ? "Media"
                              : "Baja"}
                        </label>
                      ))}
                    </span>
                    <span className="memberProfileLabel">
                      Elige qué activos financian el objetivo
                    </span>
                    <ChipChoice
                      name="assetIds"
                      options={assets}
                      selectedIds={createAssetIds ?? []}
                    />
                    <PendingSubmit className="createGoalSubmit" pendingLabel="Creando…">
                      Crear objetivo
                    </PendingSubmit>
                  </form>
                );
              })()}
            </div>
          </>
        ) : (
          <p className="muted">Selecciona un scope para gestionar objetivos.</p>
        )}
      </section>
    </div>
  );
}
