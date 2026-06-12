import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import { collectWarnings, listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../intake";
import ImportWorkspaceForm from "../import-workspace-form";
import Shell from "../shell";
import {
  createMemberAction,
  disableMemberAction,
  hardDeleteMemberAction,
  reactivateMemberAction,
  resetWorkspaceAction,
  retractWarningOverrideAction,
  saveFireConfigAction,
  updateMemberAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AjustesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/ajustes", resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    return {
      fireConfig: store.readFireConfig(),
      overrides: store.readWarningOverrides(),
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  // prepareDashboardState needs assets/liabilities/etc — for ajustes we only
  // need the workspace, scopes, and warnings-related data. Build the minimal
  // state subset needed for the shell.
  const { scopes, selectedScope, workspace, fireConfig, overrides } = storeData;
  const fireScopeConfig = selectedScope ? fireConfig[selectedScope.id] : undefined;

  // Build warnings for the shell rail (read from full store to be accurate).
  const warnings = withStore((store) => {
    const assets = store.readAssets();
    const warningOverrides = store.readWarningOverrides();
    return collectWarnings(assets, warningOverrides);
  });

  const persistenceInfo = {
    displayPath: persistence.displayPath,
    checkedAt: persistence.checkedAt,
  };

  return (
    <Shell
      activeSection="ajustes"
      currentPageUrl={currentUrl}
      persistence={persistenceInfo}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={warnings.map((w) => ({
        code: w.code,
        entityId: w.entityId,
        message: w.message,
      }))}
    >
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
        <section className="ajustesPanel" aria-label="Miembros">
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
                    <details className="confirmDelete">
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
                      <details className="confirmDelete">
                        <summary>Eliminar definitivamente</summary>
                        <button type="submit">Confirmar borrado definitivo</button>
                      </details>
                    </form>
                  </>
                )}
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
        <section className="ajustesPanel" aria-label="Workspace">
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
        <section className="ajustesPanel" aria-label="Configuración FIRE">
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
                      ? (fireScopeConfig.safeWithdrawalRate * 100).toString()
                      : "4"
                  }
                  inputMode="decimal"
                  name="safeWithdrawalRate"
                />
              </label>
              <label>
                Retorno real esperado % (por defecto 7)
                <input
                  defaultValue={
                    fireScopeConfig
                      ? (fireScopeConfig.expectedRealReturn * 100).toString()
                      : "7"
                  }
                  inputMode="decimal"
                  name="expectedRealReturn"
                />
              </label>
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
              <button type="submit">Guardar configuración FIRE</button>
            </form>
          ) : (
            <p className="muted">Selecciona un scope para configurar FIRE.</p>
          )}
        </section>

        {/* ── Persistencia ─────────────────────────────────────────── */}
        <section className="ajustesPanel" aria-label="Persistencia">
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

        {/* ── Overrides de avisos ──────────────────────────────────── */}
        <section className="ajustesPanel" aria-label="Overrides de avisos">
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
                  <span className="overrideEntity">{override.entityId}</span>
                  <details className="confirmDelete">
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
          <details className="confirmDelete">
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
    </Shell>
  );
}
