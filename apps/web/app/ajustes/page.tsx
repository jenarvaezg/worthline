import { bootstrapHealthcheck, withStore } from "@web/store";
import { collectWarnings, formatMoneyMinor, listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { isDemoMode } from "@web/demo/write-guard";
import ImportWorkspaceForm from "@web/import-workspace-form";
import { PendingSubmit } from "@web/pending-submit";
import Shell from "@web/shell";
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
import { connectBinanceAction, syncBinanceAction } from "./binance-actions";
import { aggregateSourceValueMinor } from "./binance-helpers";
import DisconnectBinanceFold from "./disconnect-binance-fold";
import DisconnectNumistaFold from "./disconnect-numista-fold";
import { connectNumistaAction, syncNumistaAction } from "./numista-actions";
import { formatLastSync } from "./numista-helpers";

export const dynamic = "force-dynamic";

export default async function AjustesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = await bootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/ajustes", resolvedSearchParams);
  // Demo mode hides the irreversible affordances entirely (ADR 0029): reset and
  // import are never offered. Export stays — it is read-only and harmless.
  const demo = isDemoMode();

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = await withStore((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    // The connected Numista source (PRD #160), if any. The derived holding's value
    // and coin count come from the asset row + its positions.
    const numistaRow = store.connectedSources
      .listSources()
      .find((source) => source.adapter === "numista");
    const numistaPositions = numistaRow
      ? store.connectedSources.readPositions(numistaRow.id)
      : [];
    const numistaAsset = numistaRow
      ? (store.assets.readAssets().find((a) => a.id === numistaRow.assetId) ?? null)
      : null;
    const numistaSource = numistaRow
      ? {
          id: numistaRow.id,
          assetId: numistaRow.assetId,
          label: numistaRow.label,
          lastSyncAt: numistaRow.lastSyncAt,
          coinCount: numistaPositions.reduce(
            (sum, p) => sum + (p.kind === "coin" ? p.quantity : 0),
            0,
          ),
          valueMinor: numistaAsset?.currentValue.amountMinor ?? 0,
        }
      : null;

    // The connected Binance source (PRD #245/#248), if any. A source now spans
    // rungs — one asset per occupied rung (market + term-locked) — so the tile
    // AGGREGATES across the source's assets: value = Σ asset values, token count =
    // all the source's token positions. "Ver →" links to the market (primary) asset.
    const binanceRow = store.connectedSources
      .listSources()
      .find((source) => source.adapter === "binance");
    const binancePositions = binanceRow
      ? store.connectedSources.readPositions(binanceRow.id)
      : [];
    const binanceAssetIds = binanceRow
      ? new Set(store.connectedSources.listSourceAssetIds(binanceRow.id))
      : new Set<string>();
    const binanceValueMinor = binanceRow
      ? aggregateSourceValueMinor(store.assets.readAssets(), binanceAssetIds)
      : 0;
    const binanceSource = binanceRow
      ? {
          id: binanceRow.id,
          assetId: binanceRow.assetId,
          label: binanceRow.label,
          lastSyncAt: binanceRow.lastSyncAt,
          tokenCount: binancePositions.filter((p) => p.kind === "token").length,
          valueMinor: binanceValueMinor,
        }
      : null;

    return {
      binanceSource,
      fireConfig: store.readFireConfig(),
      numistaSource,
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
  const {
    scopes,
    selectedScope,
    workspace,
    fireConfig,
    overrides,
    numistaSource,
    binanceSource,
  } = storeData;
  const fireScopeConfig = selectedScope ? fireConfig[selectedScope.id] : undefined;

  // Build warnings for the shell rail (read from full store to be accurate).
  const warnings = await withStore((store) => {
    const assets = store.assets.readAssets();
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

        {/* ── Fuentes conectadas ──────────────────────────────────── */}
        <section className="ajustesPanel" aria-label="Fuentes conectadas">
          <div className="panelHeader">
            <h2>Fuentes conectadas</h2>
            <span>Numista y Binance</span>
          </div>

          {formError?.formId === "numista" ? (
            <p className="formError" role="alert">
              {formError.message}
            </p>
          ) : null}

          {numistaSource ? (
            <div className="coinSourceTile">
              <div className="coinSourceStatus">
                <span className="coinStatusPill">Conectado</span>
                <dl className="coinSourceStats">
                  <div>
                    <dt>Última sincronización</dt>
                    <dd>{formatLastSync(numistaSource.lastSyncAt)}</dd>
                  </div>
                  <div>
                    <dt>Monedas</dt>
                    <dd className="coinNum">{numistaSource.coinCount}</dd>
                  </div>
                  <div>
                    <dt>Valor</dt>
                    <dd className="coinNum">
                      {formatMoneyMinor({
                        amountMinor: numistaSource.valueMinor,
                        currency: "EUR",
                      })}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="coinSourceActions">
                <form action={syncNumistaAction} className="coinSyncForm">
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  <input name="sourceId" type="hidden" value={numistaSource.id} />
                  <PendingSubmit pendingLabel="Sincronizando…">
                    Sincronizar Numista
                  </PendingSubmit>
                </form>
                <Link
                  className="actionLink"
                  href={`/patrimonio/${numistaSource.assetId}/editar`}
                >
                  Ver colección →
                </Link>
                <DisconnectNumistaFold
                  currentUrl={currentUrl}
                  sourceId={numistaSource.id}
                />
              </div>
            </div>
          ) : (
            <form action={connectNumistaAction} className="stackForm">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <label>
                Clave de API de Numista
                <input
                  aria-label="Clave de API de Numista"
                  autoComplete="off"
                  name="apiKey"
                  placeholder="Pega aquí tu clave de API"
                  type="password"
                />
              </label>
              <p className="muted">
                Conecta tu colección de Numista para reflejar tus monedas como un activo
                ilíquido con valor calculado. La clave se guarda solo en este dispositivo.
              </p>
              <button type="submit">Conectar Numista</button>
            </form>
          )}

          {/* ── Binance (PRD #245, ADR 0021) ─────────────────────────── */}
          {formError?.formId === "binance" ? (
            <p className="formError" role="alert">
              {formError.message}
            </p>
          ) : null}

          {binanceSource ? (
            <div className="coinSourceTile">
              <div className="coinSourceStatus">
                <span className="coinStatusPill">Conectado</span>
                <dl className="coinSourceStats">
                  <div>
                    <dt>Última sincronización</dt>
                    <dd>{formatLastSync(binanceSource.lastSyncAt)}</dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd className="coinNum">{binanceSource.tokenCount}</dd>
                  </div>
                  <div>
                    <dt>Valor</dt>
                    <dd className="coinNum">
                      {formatMoneyMinor({
                        amountMinor: binanceSource.valueMinor,
                        currency: "EUR",
                      })}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="coinSourceActions">
                <form action={syncBinanceAction} className="coinSyncForm">
                  <input name="currentUrl" type="hidden" value={currentUrl} />
                  <input name="sourceId" type="hidden" value={binanceSource.id} />
                  <PendingSubmit pendingLabel="Sincronizando…">
                    Sincronizar Binance
                  </PendingSubmit>
                </form>
                <Link
                  className="actionLink"
                  href={`/patrimonio/${binanceSource.assetId}/editar`}
                >
                  Ver →
                </Link>
                <DisconnectBinanceFold
                  currentUrl={currentUrl}
                  sourceId={binanceSource.id}
                  summary="Desconectar"
                />
              </div>
            </div>
          ) : (
            <form action={connectBinanceAction} className="stackForm">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <label>
                Clave de API de Binance
                <input
                  aria-label="Clave de API de Binance"
                  autoComplete="off"
                  name="apiKey"
                  placeholder="Pega aquí tu clave de API"
                  type="password"
                />
              </label>
              <label>
                Secreto de API de Binance
                <input
                  aria-label="Secreto de API de Binance"
                  autoComplete="off"
                  name="apiSecret"
                  placeholder="Pega aquí tu secreto de API"
                  type="password"
                />
              </label>
              <p className="muted">
                Conecta tu cuenta de Binance para reflejar tus tokens como un activo
                valorado en vivo. Usa una clave de <strong>solo lectura</strong> («Enable
                Reading»), sin permisos de trading ni de retiro. La clave y el secreto se
                guardan solo en este dispositivo y nunca se exportan.
              </p>
              <button type="submit">Conectar Binance</button>
            </form>
          )}
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
      )}
    </Shell>
  );
}
