import { isDemoMode } from "@web/demo/write-guard";
import ImportWorkspaceForm from "@web/import-workspace-form";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { formatDecimalAsPercentField } from "@web/intake-primitives";
import { resolvePageShell } from "@web/page-shell";
import {
  formatMoneyMinorPrivacy,
  suggestMonthlySavingsCapacity,
} from "@worthline/domain";
import Link from "next/link";
import { Suspense } from "react";
import {
  createMemberAction,
  disableMemberAction,
  hardDeleteMemberAction,
  reactivateMemberAction,
  resetWorkspaceAction,
  retractWarningOverrideAction,
  saveFireConfigAction,
  updateMemberAction,
  updateMemberProfileAction,
} from "./actions";
import AjustesSkeleton from "./ajustes-skeleton";
import { CONNECTION_ADAPTERS } from "./conexiones/connection-rows";

export default function AjustesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<AjustesSkeleton />}>
      <AjustesContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function AjustesContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = await searchParams;
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/ajustes", resolvedSearchParams);
  // Demo mode hides the irreversible affordances entirely (ADR 0029): reset and
  // import are never offered. Export stays — it is read-only and harmless.
  const demo = await isDemoMode();

  const { persistence, privacyMode, selectedScope, store, workspace } =
    await resolvePageShell({ searchParams: resolvedSearchParams });

  // Connected sources moved to their own page (#1223): here they are a count and
  // a link, so the settings page no longer reads positions, rung assets or the
  // public-id index for them.
  const sources = await store.connectedSources.listSources();
  const connectedCount = CONNECTION_ADAPTERS.filter((adapter) =>
    sources.some((source) => source.adapter === adapter),
  ).length;
  const allAssets = await store.assets.readAssets();
  const overrides = await store.readWarningOverrides();

  // The overrides list used to print the raw internal id (`asset_activo_cero_…`)
  // at the user. It reads as noise to a human and it is the retired vocabulary on
  // display (#1318), so the row names the holding. An override left behind by a
  // deleted holding has no name to show and keeps the stored id, which is the only
  // thing that still identifies it.
  const holdingNameById = new Map(allAssets.map((asset) => [asset.id, asset.name]));

  // Monthly savings capacity suggestion (#425): the historical average of net
  // money invested, offered as the default in the FIRE form. Workspace-wide
  // across investment holdings — a soft default the user can override.
  const investmentOps = (
    await Promise.all(
      allAssets
        .filter((asset) => asset.type === "investment")
        .map((asset) => store.operations.readOperations(asset.id)),
    )
  ).flat();
  const savingsSuggestion = suggestMonthlySavingsCapacity(investmentOps);

  const fireConfig = await store.readFireConfig();
  const fireScopeConfig = selectedScope ? fireConfig[selectedScope.id] : undefined;

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

      <div className="ajustesGrid">
        {/* ── Miembros ─────────────────────────────────────────────── */}
        <section className="ajustesPanel section" aria-label="Miembros">
          <div className="panelHeader">
            <h2>Miembros</h2>
            <span>{workspace.members.filter((m) => !m.disabledAt).length} activos</span>
          </div>

          {formError?.formId === "newMember" ? (
            <p className="formError" role="alert">
              {formError.message}
            </p>
          ) : null}

          <div className="memberGrid">
            {workspace.members.map((member) => (
              <div className="memberRow" key={member.id}>
                <form action={updateMemberAction}>
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  <input name="id" type="hidden" value={member.id} />
                  <input
                    aria-label={`Nombre de ${member.name}`}
                    defaultValue={member.name}
                    disabled={Boolean(member.disabledAt)}
                    name="name"
                  />
                  <span
                    className={
                      member.disabledAt ? "memberStatus inactive" : "memberStatus active"
                    }
                  >
                    {member.disabledAt ? "Inactivo" : "Activo"}
                  </span>
                  {!member.disabledAt ? <button type="submit">Guardar</button> : null}
                </form>

                {!member.disabledAt ? (
                  <form action={disableMemberAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="id" type="hidden" value={member.id} />
                    <details suppressHydrationWarning className="confirmDelete">
                      <summary>Desactivar</summary>
                      <button type="submit">Confirmar desactivación</button>
                    </details>
                  </form>
                ) : (
                  <>
                    <form action={reactivateMemberAction}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={member.id} />
                      <button type="submit">Reactivar</button>
                    </form>
                    <form action={hardDeleteMemberAction}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={member.id} />
                      <details suppressHydrationWarning className="confirmDelete">
                        <summary>Eliminar definitivamente</summary>
                        <button type="submit">Confirmar borrado definitivo</button>
                      </details>
                    </form>
                  </>
                )}

                {!member.disabledAt ? (
                  <form action={updateMemberProfileAction} className="memberProfile">
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="id" type="hidden" value={member.id} />
                    <div className="memberProfileGrid">
                      <label>
                        Año de nacimiento
                        <input
                          defaultValue={member.birthYear?.toString()}
                          inputMode="numeric"
                          name="birthYear"
                          placeholder="1990"
                        />
                      </label>
                      <label>
                        País fiscal
                        <select
                          defaultValue={member.fiscalCountry ?? ""}
                          name="fiscalCountry"
                        >
                          <option value="">—</option>
                          <option value="ES">España</option>
                          <option value="PT">Portugal</option>
                          <option value="FR">Francia</option>
                          <option value="DE">Alemania</option>
                          <option value="GB">Reino Unido</option>
                          <option value="US">Estados Unidos</option>
                        </select>
                      </label>
                    </div>
                    <span className="memberProfileLabel">Tolerancia al riesgo</span>
                    <span className="segmented">
                      <label>
                        <input
                          defaultChecked={member.riskTolerance === "conservative"}
                          name="riskTolerance"
                          type="radio"
                          value="conservative"
                        />
                        Conservadora
                      </label>
                      <label>
                        <input
                          defaultChecked={member.riskTolerance === "moderate"}
                          name="riskTolerance"
                          type="radio"
                          value="moderate"
                        />
                        Moderada
                      </label>
                      <label>
                        <input
                          defaultChecked={member.riskTolerance === "aggressive"}
                          name="riskTolerance"
                          type="radio"
                          value="aggressive"
                        />
                        Agresiva
                      </label>
                    </span>
                    <button type="submit">Guardar perfil</button>
                  </form>
                ) : null}
              </div>
            ))}
          </div>

          <form action={createMemberAction} className="inlineForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="name" aria-label="Nuevo miembro" placeholder="Nuevo miembro" />
            <button type="submit">Añadir</button>
          </form>
        </section>

        {/* ── Workspace ────────────────────────────────────────────── */}
        <section className="ajustesPanel section" aria-label="Workspace">
          <div className="panelHeader">
            <h2>Workspace</h2>
            <span>Modo e información general</span>
          </div>
          <dl className="infoList">
            <dt>Modo</dt>
            <dd>{workspace.mode === "household" ? "Hogar" : "Individual"}</dd>
            <dt>Divisa base</dt>
            <dd>{workspace.baseCurrency} (sólo lectura)</dd>
            <dt>Miembros totales</dt>
            <dd>{workspace.members.length}</dd>
            <dt>Miembros activos</dt>
            <dd>{workspace.members.filter((m) => !m.disabledAt).length}</dd>
          </dl>
        </section>

        {/* ── Configuración FIRE ───────────────────────────────────── */}
        <section className="ajustesPanel section" aria-label="Configuración FIRE">
          <div className="panelHeader">
            <h2>Configuración FIRE</h2>
            <span>Independencia financiera</span>
          </div>

          {formError?.formId === "fire" ? (
            <p className="formError" role="alert">
              {formError.message}
            </p>
          ) : null}

          {selectedScope ? (
            <form action={saveFireConfigAction} className="stackForm">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="scopeId" type="hidden" value={selectedScope.id} />
              <label>
                Gasto mensual (EUR)
                <input
                  defaultValue={
                    fireScopeConfig
                      ? (fireScopeConfig.monthlySpendingMinor / 100).toString()
                      : undefined
                  }
                  inputMode="decimal"
                  name="monthlySpending"
                  placeholder="2000"
                />
              </label>
              <label>
                Tasa de retirada segura % (por defecto 4)
                <input
                  defaultValue={
                    fireScopeConfig
                      ? formatDecimalAsPercentField(fireScopeConfig.safeWithdrawalRate)
                      : "4"
                  }
                  inputMode="decimal"
                  name="safeWithdrawalRate"
                />
              </label>
              <label>
                Retorno real esperado % (opcional — estimado por tu mezcla)
                <input
                  defaultValue={
                    fireScopeConfig?.expectedRealReturn !== undefined
                      ? formatDecimalAsPercentField(fireScopeConfig.expectedRealReturn)
                      : undefined
                  }
                  inputMode="decimal"
                  name="expectedRealReturn"
                  placeholder="estimado por tu mezcla de activos"
                />
                <small className="muted">
                  Vacío = se calcula automáticamente ponderando los retornos por tipo de
                  activo. Rellena para forzar un valor fijo (anula la estimación).
                </small>
              </label>
              <details suppressHydrationWarning>
                <summary className="muted">
                  Retornos reales por tipo de activo (opcional)
                </summary>
                <div className="stackForm" style={{ marginTop: "0.5rem" }}>
                  <label>
                    Caja %
                    <input
                      defaultValue={
                        fireScopeConfig?.tierRealReturns?.cash !== undefined
                          ? formatDecimalAsPercentField(
                              fireScopeConfig.tierRealReturns.cash,
                            )
                          : undefined
                      }
                      inputMode="decimal"
                      name="tierReturn_cash"
                      placeholder="0"
                    />
                  </label>
                  <label>
                    Mercado %
                    <input
                      defaultValue={
                        fireScopeConfig?.tierRealReturns?.market !== undefined
                          ? formatDecimalAsPercentField(
                              fireScopeConfig.tierRealReturns.market,
                            )
                          : undefined
                      }
                      inputMode="decimal"
                      name="tierReturn_market"
                      placeholder="5"
                    />
                  </label>
                  <label>
                    A plazo %
                    <input
                      defaultValue={
                        fireScopeConfig?.tierRealReturns?.["term-locked"] !== undefined
                          ? formatDecimalAsPercentField(
                              fireScopeConfig.tierRealReturns["term-locked"],
                            )
                          : undefined
                      }
                      inputMode="decimal"
                      name="tierReturn_term-locked"
                      placeholder="1.5"
                    />
                  </label>
                  <label>
                    Ilíquido %
                    <input
                      defaultValue={
                        fireScopeConfig?.tierRealReturns?.illiquid !== undefined
                          ? formatDecimalAsPercentField(
                              fireScopeConfig.tierRealReturns.illiquid,
                            )
                          : undefined
                      }
                      inputMode="decimal"
                      name="tierReturn_illiquid"
                      placeholder="3"
                    />
                  </label>
                  <small className="muted">
                    Retornos reales anuales (tras inflación) por tipo. Vacío = valores por
                    defecto (Caja 0 %, Mercado 5 %, A plazo 1,5 %, Ilíquido 3 %).
                  </small>
                </div>
              </details>
              <label>
                Edad actual (opcional)
                <input
                  defaultValue={fireScopeConfig?.currentAge?.toString()}
                  inputMode="numeric"
                  name="currentAge"
                  placeholder="35"
                />
              </label>
              <label>
                Edad objetivo de jubilación (por defecto 65)
                <input
                  defaultValue={
                    fireScopeConfig
                      ? (fireScopeConfig.targetRetirementAge ?? 65).toString()
                      : "65"
                  }
                  inputMode="numeric"
                  name="targetRetirementAge"
                />
              </label>
              <label>
                Ahorro mensual (EUR)
                <input
                  defaultValue={
                    fireScopeConfig?.monthlySavingsCapacityMinor !== undefined
                      ? (fireScopeConfig.monthlySavingsCapacityMinor / 100).toString()
                      : undefined
                  }
                  inputMode="decimal"
                  name="monthlySavingsCapacity"
                  placeholder={
                    savingsSuggestion.basis === "operations"
                      ? (savingsSuggestion.amountMinor / 100).toString()
                      : "0"
                  }
                />
                {savingsSuggestion.basis === "operations" ? (
                  <small className="muted">
                    Sugerido por tu histórico:{" "}
                    {formatMoneyMinorPrivacy(
                      {
                        amountMinor: savingsSuggestion.amountMinor,
                        currency: workspace.baseCurrency,
                      },
                      privacyMode,
                    )}
                    /mes
                  </small>
                ) : null}
              </label>
              <label>
                Multiplicador Lean FIRE (opcional)
                <input
                  defaultValue={fireScopeConfig?.leanMultiplier?.toString()}
                  inputMode="decimal"
                  name="leanMultiplier"
                  placeholder="0.7"
                />
                <small className="muted">
                  Fracción del gasto mensual para el nivel Lean (por defecto 0,7)
                </small>
              </label>
              <label>
                Multiplicador Fat FIRE (opcional)
                <input
                  defaultValue={fireScopeConfig?.fatMultiplier?.toString()}
                  inputMode="decimal"
                  name="fatMultiplier"
                  placeholder="1.5"
                />
                <small className="muted">
                  Fracción del gasto mensual para el nivel Fat (por defecto 1,5)
                </small>
              </label>
              <label>
                Ingreso a tiempo parcial (€/mes, opcional)
                <input
                  defaultValue={
                    fireScopeConfig?.baristaMonthlyIncomeMinor
                      ? (fireScopeConfig.baristaMonthlyIncomeMinor / 100).toString()
                      : undefined
                  }
                  inputMode="decimal"
                  name="baristaIncome"
                  placeholder="0"
                />
                <small className="muted">
                  Barista FIRE: ingreso parcial que reduce el capital necesario. Vacío o 0
                  = sin efecto.
                </small>
              </label>
              <button type="submit">Guardar configuración FIRE</button>
            </form>
          ) : (
            <p className="muted">Selecciona un scope para configurar FIRE.</p>
          )}
        </section>

        {/* ── Objetivos ────────────────────────────────────────────── */}
        <section className="ajustesPanel section" aria-label="Enlace objetivos">
          <div className="panelHeader">
            <h2>Objetivos</h2>
            <span>metas con fecha</span>
          </div>
          <p className="muted">
            Gestiona tus objetivos (crear, editar, eliminar) en la página Objetivos.
          </p>
          <Link className="panelAction" href="/objetivos">
            Gestionar objetivos →
          </Link>
        </section>

        {/* ── Persistencia ─────────────────────────────────────────── */}
        <section className="ajustesPanel section" aria-label="Persistencia">
          <div className="panelHeader">
            <h2>Persistencia</h2>
            <span>Base de datos SQLite local</span>
          </div>
          <dl className="infoList">
            <dt>Ruta de la base de datos</dt>
            <dd className="dbPath">{persistence.databasePath}</dd>
            <dt>Ruta de visualización</dt>
            <dd>{persistence.displayPath}</dd>
            <dt>Último guardado</dt>
            <dd>{new Date(persistence.checkedAt).toLocaleString("es-ES")}</dd>
            <dt>Clave de healthcheck</dt>
            <dd className="mono">{persistence.checkKey}</dd>
            <dt>Valor verificado</dt>
            <dd className="mono">{persistence.checkValue}</dd>
            <dt>Estado</dt>
            <dd>
              <span
                className={`statePill ${persistence.status === "ok" ? "ready" : "error"}`}
              >
                {persistence.status === "ok" ? "OK" : "Error"}
              </span>
            </dd>
          </dl>
          <p className="muted">
            Exportar descarga una copia completa del workspace en un archivo JSON:
            miembros, patrimonio, operaciones, snapshots y papelera incluidos.
          </p>
          {/* Plain anchor on purpose: the route responds with Content-Disposition
              attachment, so the browser downloads instead of navigating. */}
          <a className="panelAction" href="/ajustes/export">
            Exportar
          </a>
        </section>

        {/* ── Conexiones (#1223: la sección vive en /ajustes/conexiones) ── */}
        <section className="ajustesPanel section" aria-label="Conexiones">
          <div className="panelHeader">
            <h2>Conexiones</h2>
            <span>
              {connectedCount} de {CONNECTION_ADAPTERS.length} conectadas
            </span>
          </div>
          <p className="muted">
            Numista y Binance se conectan, sincronizan y desconectan en su propia página.
          </p>
          <Link className="panelAction" href="/ajustes/conexiones">
            Gestionar conexiones →
          </Link>
        </section>

        {/* ── Overrides de avisos ──────────────────────────────────── */}
        <section className="ajustesPanel section" aria-label="Overrides de avisos">
          <div className="panelHeader">
            <h2>Avisos marcados como intencionales</h2>
            <span>
              {overrides.length} {overrides.length === 1 ? "override" : "overrides"}
            </span>
          </div>

          {overrides.length === 0 ? (
            <p className="emptyLine">Sin avisos marcados como intencionales.</p>
          ) : (
            <div className="overrideList">
              {overrides.map((override) => (
                <form
                  action={retractWarningOverrideAction}
                  className="overrideRow"
                  key={`${override.code}-${override.entityId}`}
                >
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  <input name="code" type="hidden" value={override.code} />
                  <input name="entityId" type="hidden" value={override.entityId} />
                  <span className="overrideCode">{override.code}</span>
                  <span className="overrideEntity">
                    {holdingNameById.get(override.entityId) ?? override.entityId}
                  </span>
                  <details suppressHydrationWarning className="confirmDelete">
                    <summary>Retirar</summary>
                    <button type="submit">Confirmar retirada</button>
                  </details>
                </form>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ── Zona de peligro ──────────────────────────────────────────── */}
      {demo ? null : (
        <section className="dangerZone" aria-label="Zona de peligro">
          <div className="panelHeader">
            <h2>Zona de peligro</h2>
            <span>Acciones irreversibles</span>
          </div>

          {formError?.formId === "reset" ? (
            <p className="formError" role="alert">
              {formError.message}
            </p>
          ) : null}

          <p className="dangerExplain">
            Borrar todo elimina el workspace entero —miembros, patrimonio, inversiones,
            operaciones, histórico y ajustes— y devuelve la app al inicio. No se puede
            deshacer.
          </p>

          <form action={resetWorkspaceAction} className="stackForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <details suppressHydrationWarning className="confirmDelete">
              <summary>Borrar todo</summary>
              <label>
                Escribe <strong>borrar todo</strong> para confirmar
                <input
                  aria-label="Frase de confirmación de borrado total"
                  autoComplete="off"
                  name="confirmation"
                  placeholder="borrar todo"
                />
              </label>
              <button type="submit">Borrar todo definitivamente</button>
            </details>
          </form>

          {formError?.formId === "import" ? (
            <p className="formError" role="alert">
              {formError.message}
            </p>
          ) : null}

          <p className="dangerExplain">
            Importar un archivo de exportación reemplaza por completo el workspace actual;
            nada de lo que existe ahora se conserva.
          </p>

          <ImportWorkspaceForm currentUrl={currentUrl} showDataLossWarning />
        </section>
      )}
    </>
  );
}
