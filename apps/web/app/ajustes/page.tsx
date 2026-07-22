import { isDemoMode } from "@web/demo/write-guard";
import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import {
  PAYWALL_CONNECT_SOURCE_MESSAGE,
  PAYWALL_SOURCES_PAUSED_MESSAGE,
} from "@web/entitlements/paywall-copy";
import { PremiumNotice } from "@web/entitlements/premium-notice";
import { readEffectivePlan } from "@web/entitlements/read-effective-plan";
import ImportWorkspaceForm from "@web/import-workspace-form";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { formatDecimalAsPercentField } from "@web/intake-primitives";
import { resolvePageShell } from "@web/page-shell";
import { PendingSubmit } from "@web/pending-submit";
import { readStoreTarget } from "@web/read-store-target";
import Shell from "@web/shell";
import {
  formatMoneyMinorPrivacy,
  suggestMonthlySavingsCapacity,
} from "@worthline/domain";
import Link from "next/link";
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
import { connectBinanceAction, syncBinanceAction } from "./binance-actions";
import { aggregateSourceValueMinor, countNonDustTokens } from "./binance-helpers";
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
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/ajustes", resolvedSearchParams);
  // Demo mode hides the irreversible affordances entirely (ADR 0029): reset and
  // import are never offered. Export stays — it is read-only and harmless.
  const demo = await isDemoMode();

  const { persistence, privacyMode, scopes, selectedScope, store, workspace } =
    await resolvePageShell({ searchParams: resolvedSearchParams });

  const sources = await store.connectedSources.listSources();
  const allAssets = await store.assets.readAssets();
  const overrides = await store.readWarningOverrides();

  // Connected sources are premium ingestion (#1162): a free workspace keeps its
  // already-imported data, but sees an honest paused/connect reminder instead of
  // syncing. Reads and manual tracking on this page stay free.
  const sourcesGated = !isPremiumIngestionAllowed(
    await readEffectivePlan(await readStoreTarget()),
  );

  // The connected Numista source (PRD #160), if any. The derived holding's value
  // and coin count come from the asset row + its positions.
  const numistaRow = sources.find((source) => source.adapter === "numista");
  const numistaPositions = numistaRow
    ? await store.connectedSources.readPositions(numistaRow.id)
    : [];
  const numistaAsset = numistaRow
    ? (allAssets.find((a) => a.id === numistaRow.assetId) ?? null)
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
  // the distinct non-dust tokens (#479). "Ver →" links to the market (primary) asset.
  const binanceRow = sources.find((source) => source.adapter === "binance");
  const binancePositions = binanceRow
    ? await store.connectedSources.readPositions(binanceRow.id)
    : [];
  const binanceAssetIds = binanceRow
    ? new Set(await store.connectedSources.listSourceAssetIds(binanceRow.id))
    : new Set<string>();
  const binanceValueMinor = binanceRow
    ? aggregateSourceValueMinor(allAssets, binanceAssetIds)
    : 0;
  const binanceSource = binanceRow
    ? {
        id: binanceRow.id,
        assetId: binanceRow.assetId,
        label: binanceRow.label,
        lastSyncAt: binanceRow.lastSyncAt,
        tokenCount: countNonDustTokens(binancePositions),
        valueMinor: binanceValueMinor,
      }
    : null;

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
              <details>
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

        {/* ── Fuentes conectadas ──────────────────────────────────── */}
        <section className="ajustesPanel section" aria-label="Fuentes conectadas">
          <div className="panelHeader">
            <h2>Fuentes conectadas</h2>
            <span>Numista y Binance</span>
          </div>

          {sourcesGated ? (
            <PremiumNotice
              cta={false}
              message={
                sources.length > 0
                  ? PAYWALL_SOURCES_PAUSED_MESSAGE
                  : PAYWALL_CONNECT_SOURCE_MESSAGE
              }
            />
          ) : null}

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
                      {formatMoneyMinorPrivacy(
                        {
                          amountMinor: numistaSource.valueMinor,
                          currency: "EUR",
                        },
                        privacyMode,
                      )}
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
                ilíquido con valor calculado. Usa una clave de solo lectura; se guarda{" "}
                cifrada y nunca se exporta.
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
                      {formatMoneyMinorPrivacy(
                        {
                          amountMinor: binanceSource.valueMinor,
                          currency: "EUR",
                        },
                        privacyMode,
                      )}
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
                valorado en vivo. Usa <strong>obligatoriamente</strong> una clave de{" "}
                <strong>solo lectura</strong> («Enable Reading»), sin permisos de trading
                ni de retiro: worthline solo lee saldos. La clave y el secreto se guardan{" "}
                <strong>cifrados</strong> y nunca se exportan.
              </p>
              <button type="submit">Conectar Binance</button>
            </form>
          )}
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
