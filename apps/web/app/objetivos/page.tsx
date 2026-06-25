import {
  formatMoneyMinorPrivacy,
  listScopeOptions,
  prepareObjetivosState,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parsePrivacyCookie,
  parseScopeCookie,
  resolveOkMessage,
  PRIVACY_COOKIE_NAME,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { bootstrapHealthcheck, withStore } from "@web/store";
import { PendingSubmit } from "@web/pending-submit";
import Shell from "@web/shell";
import FireProjectionCard from "@web/fire-projection-card";

import { createGoalAction, deleteGoalAction, updateGoalAction } from "./goal-actions";

export const dynamic = "force-dynamic";

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

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((s) => s.id === cookieScopeId) ?? scopes[0];
    const assets = await store.assets.readAssets();
    const goals = selectedScope ? await store.goals.readGoals(selectedScope.id) : [];
    const fireConfig = await store.readFireConfig();
    const overrides = await store.readWarningOverrides();

    return { workspace, scopes, selectedScope, assets, goals, fireConfig, overrides };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  // workspace is non-null after the redirect guard above
  const { workspace, scopes, selectedScope, assets, goals, fireConfig, overrides } =
    storeData;

  const {
    fireProjection,
    fireResult,
    fireScopeConfig,
    coastTickFraction,
    warnings,
    goals: goalsView,
  } = prepareObjetivosState({
    assets,
    fireConfig,
    goals,
    liabilities: [],
    persistence,
    positions: [],
    priceCache: [],
    scopes,
    selectedScope,
    selectedView: "liquid",
    snapshots: [],
    overrides,
    workspace,
  });

  const currency = workspace.baseCurrency;

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
                  <FireProjectionCard
                    currency={currency}
                    privacyMode={privacyMode}
                    projection={fireProjection}
                  />
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

          <div className="objetivosFireFoot">
            <span>Supuestos FIRE (retirada, retorno, edades) → en Ajustes</span>
            <Link className="panelAction" href="/ajustes">
              Configurar supuestos
            </Link>
          </div>
        </section>

        {/* ── Goals (editable; S3) ──────────────────────────────────── */}
        <section className="firePanel" aria-label="Objetivos">
          <div className="panelHeader">
            <h3>Tus objetivos</h3>
            <span>
              {goalsView.length} {goalsView.length === 1 ? "objetivo" : "objetivos"}
            </span>
          </div>

          {formError?.formId === "goal" ? (
            <p className="formError" role="alert">
              {formError.message}
            </p>
          ) : null}

          {selectedScope ? (
            <>
              {goalsView.length === 0 ? (
                <p className="muted">Aún no hay objetivos en este scope.</p>
              ) : null}

              <div className="goalList">
                {goalsView.map(
                  ({ goal, reservedMinor, fundedRatioBps, countsTowardFire }) => (
                    <div className="goalRow" key={goal.id}>
                      <form action={updateGoalAction} className="stackForm">
                        <input name="currentUrl" type="hidden" value={currentUrl} />
                        <input name="id" type="hidden" value={goal.id} />
                        <input name="scopeId" type="hidden" value={selectedScope.id} />
                        <label>
                          Nombre
                          <input defaultValue={goal.name} name="name" />
                        </label>
                        <div className="goalFieldRow">
                          <label>
                            Importe objetivo (EUR)
                            <input
                              defaultValue={(goal.targetAmountMinor / 100).toString()}
                              inputMode="decimal"
                              name="targetAmount"
                            />
                          </label>
                          <label>
                            Fecha límite
                            <input
                              defaultValue={goal.deadline}
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
                                defaultChecked={goal.priority === level}
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
                        <span className="memberProfileLabel">Holdings asignados</span>
                        <span className="chipChoice">
                          {assets.map((asset) => (
                            <label key={asset.id}>
                              <input
                                defaultChecked={goal.assetIds.includes(asset.id)}
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
                              style={{ width: `${Math.min(100, fundedRatioBps / 100)}%` }}
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
                          ) : null}
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
                  ),
                )}
              </div>

              <div className="createBlock">
                <div className="memberProfileLabel">Nuevo objetivo</div>
                <form action={createGoalAction} className="stackForm">
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  <input name="scopeId" type="hidden" value={selectedScope.id} />
                  <label>
                    Nombre
                    <input name="name" placeholder="Entrada vivienda" />
                  </label>
                  <div className="goalFieldRow">
                    <label>
                      Importe objetivo (EUR)
                      <input
                        inputMode="decimal"
                        name="targetAmount"
                        placeholder="60000"
                      />
                    </label>
                    <label>
                      Fecha límite
                      <input name="deadline" type="date" />
                    </label>
                  </div>
                  <span className="memberProfileLabel">Prioridad</span>
                  <span className="segmented">
                    <label>
                      <input name="priority" type="radio" value="high" />
                      Alta
                    </label>
                    <label>
                      <input defaultChecked name="priority" type="radio" value="medium" />
                      Media
                    </label>
                    <label>
                      <input name="priority" type="radio" value="low" />
                      Baja
                    </label>
                  </span>
                  <span className="memberProfileLabel">Holdings asignados</span>
                  <span className="chipChoice">
                    {assets.map((asset) => (
                      <label key={asset.id}>
                        <input name="assetIds" type="checkbox" value={asset.id} />
                        {asset.name}
                      </label>
                    ))}
                  </span>
                  <PendingSubmit pendingLabel="Creando…">Crear objetivo</PendingSubmit>
                </form>
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
