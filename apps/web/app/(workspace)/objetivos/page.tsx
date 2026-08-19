import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { PendingSubmit } from "@web/pending-submit";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import type { HoldingReturnsView, PassiveIncomeLens } from "@worthline/domain";
import {
  collectHoldingPayouts,
  computeMonthlyContributionAllocation,
  formatMoneyMinorPrivacy,
  instrumentOfAsset,
  investmentReturnsById,
  monthlyCloseValuesFromSnapshotRows,
  prepareObjetivosState,
  projectContributionReconciliation,
  resolveScopeMemberIds,
  scopeAgeSource,
  scopePassiveIncome,
  unitPriceMajorByHoldingId,
} from "@worthline/domain";
import Link from "next/link";
import { Suspense } from "react";
import {
  buildExposureDriftProjection,
  exposureDriftTrajectories,
} from "./build-exposure-drift";
import { ContributionAllocation } from "./contribution-allocation";
import {
  ALLOCATION_MONTH_PARAM,
  allocationMonthKeys,
  parseAllocationMonthParam,
} from "./contribution-allocation-view";
import { ContributionReconciliation } from "./contribution-reconciliation";
import { ExposureDriftSection } from "./exposure-drift-section";
import { parseExposureDriftGrowth, parseExposureDriftYear } from "./exposure-drift-view";
import { FirePanel } from "./fire-panel";
import { createGoalAction, deleteGoalAction, updateGoalAction } from "./goal-actions";
import ObjetivosSkeleton from "./objetivos-skeleton";

const dayFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const formatDay = (iso: string) => dayFormatter.format(new Date(`${iso}T00:00:00Z`));

/**
 * Passive-income lens (#658): the selected scope's trailing-12m payouts against
 * declared spending — "how much of my spending do my holdings already pay?".
 * Server-rendered; honest about window and coverage (no annualization, coverage
 * only when spending is known).
 */
function PassiveIncomePanel({
  lens,
  currency,
  privacyMode,
}: {
  lens: PassiveIncomeLens;
  currency: string;
  privacyMode: boolean;
}) {
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
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
              <span className="objetivosPasivaCap">Cobros · últimos 12 meses</span>
              <strong className="objetivosPasivaBig">{fmt(lens.totalMinor)}</strong>
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
              <i style={{ width: `${Math.min(100, lens.coverageRatio * 100)}%` }} />
            </div>
          ) : null}

          <p className="objetivosPasivaNote">
            Ventana: {formatDay(lens.windowStartISO)} – {formatDay(lens.windowEndISO)} ·{" "}
            {lens.count} {lens.count === 1 ? "cobro" : "cobros"}
            {lens.annualSpendingMinor != null
              ? ` · cobertura sobre ${fmt(lens.annualSpendingMinor)}/año`
              : " · añade tu gasto en Ajustes para ver la cobertura"}
            . Suma cobros reales del periodo, sin anualizar los parciales.
          </p>
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
    priceCache,
    investmentMeta,
    exposureProfiles,
    returnSnapshotRows,
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
    store.operations.readAllPriceCacheEntries(),
    store.assets.readInvestmentAssetsWithMeta(),
    readExposureProfilesFromCatalog(),
    store.snapshots.readSnapshotHoldings({
      includePositions: false,
      kind: "asset",
      scopeId: selectedScope?.id ?? "household",
    }),
  ]);

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
    savingsCoherence,
    fireProjection,
    fireResult,
    fireScopeConfig,
    coastTickFraction,
    goals: goalsView,
    fireLevelRail,
  } = prepareObjetivosState({
    assets,
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
  const instrumentByAsset = new Map(
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
  const holdingReturnsById = new Map<string, HoldingReturnsView | null>(
    [...investmentReturns].map(([assetId, view]) => [assetId, view]),
  );
  const exposureDriftTrajectoriesData =
    contributionPlan && selectedScope && contributionPlan.contributions.length > 0
      ? exposureDriftTrajectories({
          flat: buildExposureDriftProjection({
            workspace,
            scope: selectedScope,
            assets,
            liabilities,
            investmentMeta,
            exposureProfiles,
            contributionPlan,
            growthAssumption: "flat",
            assumedAnnualReturn,
            holdingReturnsById,
            unitPrices,
            today,
            maxYears: exposureDriftHorizon,
          }).trajectory,
          historical: buildExposureDriftProjection({
            workspace,
            scope: selectedScope,
            assets,
            liabilities,
            investmentMeta,
            exposureProfiles,
            contributionPlan,
            growthAssumption: "historical",
            assumedAnnualReturn,
            holdingReturnsById,
            unitPrices,
            today,
            maxYears: exposureDriftHorizon,
          }).trajectory,
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

      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      {/* ── FIRE star (#1426: cada cifra derivada dice de dónde sale) ── */}
      <FirePanel
        achievement={achievement}
        ageSource={ageSource}
        coastTickFraction={coastTickFraction}
        currency={currency}
        fireLevelRail={fireLevelRail}
        fireProjection={fireProjection}
        fireResult={fireResult}
        fireScopeConfig={fireScopeConfig}
        privacyMode={privacyMode}
        savingsCoherence={savingsCoherence}
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
                        <span className="memberProfileLabel">Activos asignados</span>
                        <span className="chipChoice">
                          {assets.map((asset) => (
                            <label key={asset.id}>
                              <input
                                defaultChecked={
                                  editAssetIds
                                    ? editAssetIds.includes(asset.id)
                                    : goal.assetIds.includes(asset.id)
                                }
                                name="assetIds"
                                type="checkbox"
                                value={asset.id}
                              />
                              {asset.name}
                            </label>
                          ))}
                        </span>
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
                    <span className="memberProfileLabel">Activos asignados</span>
                    <span className="chipChoice">
                      {assets.map((asset) => (
                        <label key={asset.id}>
                          <input
                            defaultChecked={
                              createAssetIds ? createAssetIds.includes(asset.id) : false
                            }
                            name="assetIds"
                            type="checkbox"
                            value={asset.id}
                          />
                          {asset.name}
                        </label>
                      ))}
                    </span>
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
