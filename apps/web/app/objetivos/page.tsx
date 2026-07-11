import FireProjectionCard from "@web/fire-projection-card";
import {
  buildCurrentUrlFor,
  PRIVACY_COOKIE_NAME,
  parseFormError,
  parsePrivacyCookie,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { formatDecimalAsPercentField } from "@web/intake-primitives";
import { PendingSubmit } from "@web/pending-submit";
import Shell from "@web/shell";
import { bootstrapHealthcheck, withStore } from "@web/store";
import type { FireLevel, PassiveIncomeLens } from "@worthline/domain";
import {
  collectHoldingPayouts,
  formatMoneyMinorPrivacy,
  listScopeOptions,
  prepareObjetivosState,
  projectContributionReconciliation,
  resolveScopeMemberIds,
  scopePassiveIncome,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ContributionReconciliation } from "./contribution-reconciliation";
import { createGoalAction, deleteGoalAction, updateGoalAction } from "./goal-actions";

export const dynamic = "force-dynamic";

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

function FireLevelCard({
  level,
  currency,
  privacyMode,
}: {
  level: FireLevel;
  currency: string;
  privacyMode: boolean;
}) {
  const reached = level.eta.kind === "reached";
  const etaLabel =
    level.eta.kind === "reached"
      ? "alcanzado"
      : level.eta.kind === "unreachable"
        ? "—"
        : level.eta.years === 0
          ? "este año"
          : `en ~${level.eta.years.toFixed(1).replace(".", ",")} años`;

  return (
    <div className={`fireLevelCard${reached ? " fireLevelCard--reached" : ""}`}>
      <span className="fireLevelLabel">{level.label}</span>
      <strong className="fireLevelAmount">
        {formatMoneyMinorPrivacy(
          { amountMinor: level.amountMinor, currency },
          privacyMode,
        )}
      </strong>
      <span className={`fireLevelEta${reached ? " fireLevelEta--reached" : ""}`}>
        {etaLabel}
      </span>
    </div>
  );
}

export default async function ObjetivosPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const persistence = await bootstrapHealthcheck();
  const currentUrl = buildCurrentUrlFor("/objetivos", resolvedSearchParams);
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
  const privacyMode = parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);

  const storeData = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) return null;

    const today = new Date().toISOString().slice(0, 10);
    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((s) => s.id === cookieScopeId) ?? scopes[0];
    const projectionContext = await store.snapshots.buildProjectionContext();
    const [
      { assets, liabilities },
      goals,
      fireConfig,
      overrides,
      payoutRecords,
      payoutSchedules,
      contributionPlan,
      contributionReconciliations,
      priceCache,
    ] = await Promise.all([
      store.snapshots.readCurveValuedHoldingsAtDate(today, projectionContext),
      selectedScope ? store.goals.readGoals(selectedScope.id) : Promise.resolve([]),
      store.readFireConfig(),
      store.readWarningOverrides(),
      store.payouts.readPayouts(),
      store.payouts.readPayoutSchedules(),
      selectedScope
        ? store.contributionPlan.readContributionPlan(selectedScope.id)
        : Promise.resolve(null),
      selectedScope
        ? store.contributionPlan.readReconciliations(selectedScope.id)
        : Promise.resolve([]),
      store.operations.readAllPriceCacheEntries(),
    ]);

    const contributionOperations = (
      await Promise.all(
        assets
          .filter((asset) => asset.type === "investment")
          .map((asset) => store.operations.readOperations(asset.id)),
      )
    ).flat();

    // Recorded payouts up to today, keyed by holding — the single source S1
    // owns, so this surface never re-derives a schedule.
    const payoutsByHolding = collectHoldingPayouts(payoutRecords, payoutSchedules, today);

    return {
      workspace,
      scopes,
      selectedScope,
      assets,
      liabilities,
      goals,
      fireConfig,
      overrides,
      payoutsByHolding,
      today,
      contributionPlan,
      contributionReconciliations,
      contributionOperations,
      priceCache,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  // workspace is non-null after the redirect guard above
  const {
    workspace,
    scopes,
    selectedScope,
    assets,
    liabilities,
    goals,
    fireConfig,
    overrides,
    payoutsByHolding,
    today,
    contributionPlan,
    contributionReconciliations,
    contributionOperations,
    priceCache,
  } = storeData;

  const {
    fireProjection,
    fireResult,
    fireScopeConfig,
    coastTickFraction,
    warnings,
    goals: goalsView,
    fireLevelRail,
  } = prepareObjetivosState({
    assets,
    contributionPlan,
    fireConfig,
    goals,
    liabilities,
    persistence,
    positions: [],
    priceCache,
    scopes,
    selectedScope,
    selectedView: "liquid",
    snapshots: [],
    today,
    overrides,
    workspace,
  });

  const currency = workspace.baseCurrency;

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

  return (
    <Shell
      activeSection="objetivos"
      currentPageUrl={currentUrl}
      persistence={{
        displayPath: persistence.displayPath,
        checkedAt: persistence.checkedAt,
      }}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={warnings.map((w) => ({
        code: w.code,
        entityId: w.entityId,
        message: w.message,
      }))}
    >
      <div className="objetivosPage">
        <header className="objetivosHeader">
          <h2>Objetivos</h2>
          <p>A dónde vas · tu independencia financiera y tus metas con fecha</p>
        </header>

        {formOk ? (
          <p className="successBand" role="status">
            {formOk}
          </p>
        ) : null}

        {/* ── FIRE star ─────────────────────────────────────────────── */}
        <section className="firePanel objetivosFirePanel" aria-label="FIRE">
          <div className="panelHeader">
            <h3>Independencia financiera · FIRE</h3>
            <span>tu objetivo estrella</span>
          </div>

          {fireResult ? (
            <div className="objetivosHeroGrid">
              {/* Left: % funded + bar + coast + metrics */}
              <div className="objetivosHeroLeft">
                <p className="fireBig">
                  {fireResult.percentFunded.toFixed(1).replace(".", ",")} %
                </p>

                <div className="fireBar">
                  {coastTickFraction !== null ? (
                    <span
                      aria-hidden="true"
                      className="fireTick"
                      style={{ left: `${coastTickFraction * 100}%` }}
                    />
                  ) : null}
                  <i
                    style={{
                      width: `${Math.min(100, Math.max(0, fireResult.percentFunded))}%`,
                    }}
                  />
                </div>

                {fireResult.percentFunded >= 100 ? (
                  <span className="statePill ready">FIRE alcanzado</span>
                ) : fireResult.isAlreadyAtCoastFire ? (
                  <span className="statePill ready">Coast FIRE alcanzado</span>
                ) : null}

                {/* Coast FIRE explainer */}
                {coastTickFraction !== null ? (
                  <p className="objetivosCoastNote">
                    El tick <span aria-hidden="true">▏</span> marca{" "}
                    <strong>Coast FIRE</strong> (
                    {(coastTickFraction * 100).toFixed(1).replace(".", ",")} % de tu
                    número FIRE): si alcanzas esa cifra hoy y dejas de aportar, el interés
                    compuesto hace el resto — el capital crece solo hasta tu número FIRE
                    para la jubilación.
                  </p>
                ) : null}

                <div className="fireResults objetivosMetrics">
                  <div className="fireMetric">
                    <span>Número FIRE</span>
                    <strong>
                      {formatMoneyMinorPrivacy(fireResult.fireNumber, privacyMode)}
                    </strong>
                  </div>
                  <div className="fireMetric">
                    <span>Activos elegibles</span>
                    <strong>
                      {formatMoneyMinorPrivacy(fireResult.eligibleAssets, privacyMode)}
                    </strong>
                  </div>
                  {fireResult.coastFireRequired ? (
                    <div className="fireMetric">
                      <span>Coast requerido</span>
                      <strong>
                        {formatMoneyMinorPrivacy(
                          fireResult.coastFireRequired,
                          privacyMode,
                        )}
                      </strong>
                    </div>
                  ) : null}
                  {fireScopeConfig?.currentAge !== undefined &&
                  fireResult.coastFireAge !== undefined ? (
                    <div className="fireMetric">
                      <span>Edad Coast</span>
                      <strong>
                        {fireResult.coastFireAge.toFixed(1).replace(".", ",")}
                      </strong>
                    </div>
                  ) : null}
                </div>

                {/* «¿Qué cuenta como elegible?» disclosure — derived from the
                    same rule FIRE uses: all scope assets except isPrimaryResidence
                    and manually excluded ones (config.excludedAssetIds). */}
                <details className="fireEligibleNote">
                  <summary>¿Qué cuenta como activo elegible?</summary>
                  <p className="fireEligibleRule">
                    Cuentan todos los activos del ámbito excepto la{" "}
                    <strong>vivienda habitual</strong> y los que hayas excluido
                    manualmente en Ajustes. Cash, inversiones y criptos cuentan.
                  </p>
                  {fireResult.excludedAssets.length > 0 ? (
                    <ul className="fireExcludedList">
                      {fireResult.excludedAssets.map((a) => (
                        <li key={a.id}>
                          <span>{a.name}</span>
                          <span className="fireExcludedReason">
                            {a.reason === "primary_residence"
                              ? "vivienda habitual"
                              : "excluido manualmente"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </details>
              </div>

              {/* Right: 3 scenarios + large trajectory */}
              <div className="objetivosHeroRight">
                {fireProjection ? (
                  <FireProjectionCard projection={fireProjection} />
                ) : (
                  <p className="objetivosSubNote">
                    Configura tu edad en Ajustes para ver la proyección.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="fireEmpty">
              <p className="fireEmptyHint">
                FIRE no está configurado para este ámbito. Añade tus supuestos en Ajustes
                para ver cuándo alcanzas la independencia financiera.
              </p>
              <Link className="panelAction" href="/ajustes">
                Configurar FIRE → Ajustes
              </Link>
            </div>
          )}

          {/* ── Niveles FIRE rail (N1, #513) ──────────────────────── */}
          {fireLevelRail ? (
            <section aria-label="Niveles FIRE" className="fireLevelsRail">
              <h4 className="fireLevelsTitle">Niveles FIRE</h4>
              <div className="fireLevelsGrid">
                {fireLevelRail.map((level) => (
                  <FireLevelCard
                    currency={currency}
                    key={level.key}
                    level={level}
                    privacyMode={privacyMode}
                  />
                ))}
              </div>
              {fireLevelRail.some((l) => l.key === "coast") ? (
                <p className="fireLevelsCoastNote">
                  <strong>Coast FIRE</strong>: si alcanzas esa cifra hoy y dejas de
                  aportar, el interés compuesto te llevará a tu número FIRE para la
                  jubilación.
                </p>
              ) : null}
            </section>
          ) : null}

          <div className="objetivosFireFoot">
            <span>
              Supuestos FIRE (retirada, retorno, edades) → en Ajustes
              {fireResult?.effectiveRealReturn !== undefined ? (
                <>
                  {" · "}
                  {fireScopeConfig?.expectedRealReturn !== undefined ? (
                    <span title="Retorno fijo configurado manualmente">
                      Retorno real:{" "}
                      {formatDecimalAsPercentField(fireScopeConfig.expectedRealReturn)} %
                      (manual)
                    </span>
                  ) : (
                    <span title="Retorno estimado ponderando tu mezcla de activos por tipo">
                      Retorno real estimado de tu cartera:{" "}
                      {formatDecimalAsPercentField(fireResult.effectiveRealReturn)} %
                    </span>
                  )}
                </>
              ) : null}
            </span>
            <Link className="panelAction" href="/ajustes">
              Configurar supuestos
            </Link>
          </div>
        </section>

        {contributionPlan && contributionProjection ? (
          <ContributionReconciliation
            assets={assets}
            currency={currency}
            currentUrl={currentUrl}
            operations={contributionOperations}
            plan={contributionPlan}
            projection={contributionProjection}
            suggestedPriceByHoldingId={Object.fromEntries(
              priceCache.map((entry) => [entry.assetId, entry.price]),
            )}
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
                              <span className="objetivosGoalNote">
                                No afecta a tu FIRE
                              </span>
                            )}
                          </div>
                          <PendingSubmit pendingLabel="Guardando…">
                            Guardar objetivo
                          </PendingSubmit>
                        </form>
                        <form action={deleteGoalAction}>
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="id" type="hidden" value={goal.id} />
                          <details className="confirmDelete">
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
                      <PendingSubmit pendingLabel="Creando…">
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
    </Shell>
  );
}
