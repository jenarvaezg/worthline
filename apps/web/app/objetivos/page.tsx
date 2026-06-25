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
  parsePrivacyCookie,
  parseScopeCookie,
  PRIVACY_COOKIE_NAME,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { bootstrapHealthcheck, withStore } from "@web/store";
import Shell from "@web/shell";
import FireProjectionCard from "@web/fire-projection-card";

export const dynamic = "force-dynamic";

export default async function ObjetivosPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const persistence = await bootstrapHealthcheck();
  const currentUrl = buildCurrentUrlFor("/objetivos", resolvedSearchParams);

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

        {/* ── Goals list (read-only; create/edit/delete → S3) ─────── */}
        <section className="firePanel" aria-label="Objetivos">
          <div className="panelHeader">
            <h3>Tus objetivos</h3>
            <span>
              {goalsView.length} {goalsView.length === 1 ? "objetivo" : "objetivos"}
            </span>
          </div>

          {goalsView.length === 0 ? (
            <p className="emptyLine">
              Sin objetivos todavía. Añade metas (coche, fondo de emergencia, reforma…)
              desde <Link href="/ajustes">Ajustes</Link> — cada una reserva capital que se
              descuenta de tu número FIRE.
            </p>
          ) : (
            <div className="objetivosGoalGrid">
              {goalsView.map(
                ({ goal, fundedRatioBps, reservedMinor, countsTowardFire }) => {
                  const fundedPct = Math.min(100, fundedRatioBps / 100);
                  const priorityLabel =
                    goal.priority === "high"
                      ? "alta"
                      : goal.priority === "medium"
                        ? "media"
                        : "baja";
                  return (
                    <div className="objetivosGoalCard" key={goal.id}>
                      <div className="objetivosGoalTop">
                        <span className="objetivosGoalName">{goal.name}</span>
                        <span className={`objetivosPrio objetivosPrio--${goal.priority}`}>
                          {priorityLabel}
                        </span>
                      </div>
                      <div className="objetivosGoalMeta">
                        <span>
                          <b>
                            {formatMoneyMinorPrivacy(
                              { amountMinor: reservedMinor, currency },
                              privacyMode,
                            )}
                          </b>{" "}
                          /{" "}
                          {formatMoneyMinorPrivacy(
                            { amountMinor: goal.targetAmountMinor, currency },
                            privacyMode,
                          )}
                        </span>
                        <span>{goal.deadline}</span>
                      </div>
                      <div className="objetivosFundedBar">
                        <i style={{ width: `${fundedPct}%` }} />
                      </div>
                      <div className="objetivosGoalFoot">
                        <span className="objetivosReserved">
                          Reservado{" "}
                          <b>
                            {formatMoneyMinorPrivacy(
                              { amountMinor: reservedMinor, currency },
                              privacyMode,
                            )}
                          </b>
                        </span>
                        {!countsTowardFire ? (
                          <span className="objetivosGoalNote">no descuenta FIRE</span>
                        ) : (
                          <span className="objetivosFundedPct">
                            {fundedPct.toFixed(0)} %
                          </span>
                        )}
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
