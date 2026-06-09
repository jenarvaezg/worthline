import type { MoneyMinor } from "@worthline/domain";
import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  captureNetWorthSnapshot,
  formatMoneyInput,
  formatMoneyMinor,
  getPriceFreshness,
  listScopeOptions,
  moneySign,
  planSnapshotCapture,
  prepareDashboardState,
} from "@worthline/domain";
import type {
  ManualAsset,
  Member,
  NetWorthFraming,
  PriceFreshnessState,
} from "@worthline/domain";
import { fetchAndCachePrice, refreshStalePrices, stooqProvider } from "@worthline/pricing";
import Link from "next/link";
import { redirect } from "next/navigation";

import type { FormErrorContext } from "./intake";
import {
  appendParam,
  buildCurrentUrl,
  buildSnapshotId,
  errorRedirectUrl,
  parseAssetCommand,
  parseEntityId,
  parseFireConfigForm,
  parseFormError,
  parseInvestmentAssetCommand,
  parseLiabilityCommand,
  parseMoneyMinorField,
  parseNewMember,
  parseOperationCommand,
  parseScopeParam,
  parseViewParam,
  parseWorkspaceInit,
  preserveFields,
  pricesRefreshedRedirectUrl,
  resolveOkMessage,
  successRedirectUrl,
  validateOwnershipShares,
} from "./intake";

export const dynamic = "force-dynamic";

// Typed fields refilled beside each form after a validation error.
const ASSET_FORM_FIELDS = [
  "name",
  "type",
  "currentValue",
  "liquidityTier",
  "isPrimaryResidence",
  "ownershipPreset",
];
const LIABILITY_FORM_FIELDS = [
  "name",
  "type",
  "balance",
  "associatedAssetId",
  "ownershipPreset",
];
const INVESTMENT_FORM_FIELDS = [
  "name",
  "unitSymbol",
  "isin",
  "manualPricePerUnit",
  "ownershipPreset",
];
const OPERATION_FORM_FIELDS = [
  "assetId",
  "kind",
  "executedAt",
  "units",
  "pricePerUnit",
  "fees",
];

/** The page URL an action should return to, defaulting to the dashboard root. */
function currentUrlOf(formData: FormData): string {
  return (formData.get("currentUrl") as string) || "/";
}

const framingTabs = [
  { id: "total", label: "Total" },
  { id: "liquid", label: "Liquido" },
] as const satisfies Array<{ id: NetWorthFraming; label: string }>;

/** Outcome of a write server action: ok signals revalidate, error surfaces to the user. */
type ActionResult = { ok: boolean; error?: string };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const selectedView = parseViewParam(resolvedSearchParams?.view);
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const isFireEdit = resolvedSearchParams?.fireEdit === "true";
  const currentUrl = buildCurrentUrl(resolvedSearchParams);
  // Auto-refresh stale prices first — before snapshot capture — so the day's
  // snapshot reflects refreshed prices (ADR 0005 + #52). Failures degrade to
  // "Fallido" labels, never an error page.
  const investmentAssetsMeta = withStore((store) => store.readInvestmentAssetsWithMeta());
  const initialPriceCache = withStore((store) => store.readAllPriceCacheEntries());
  const refreshedPrices = await refreshStalePrices(
    initialPriceCache,
    investmentAssetsMeta,
    persistence.checkedAt,
  ).catch(() => null);

  // Persist refreshed prices and re-read so capture + render see the latest state.
  const priceCache = withStore((store) => {
    if (refreshedPrices) {
      for (const price of refreshedPrices.refreshed) {
        store.upsertPrice(price);
      }
    }
    return store.readAllPriceCacheEntries();
  });

  const storeData = withStore((store) => {
    const workspace = store.readWorkspace();
    const scopes = workspace ? listScopeOptions(workspace) : [];
    const selectedScopeId = parseScopeParam(resolvedSearchParams?.scope);
    const selectedScope =
      scopes.find((scope) => scope.id === selectedScopeId) ?? scopes[0];

    // Automatic capture-on-load: at most one snapshot per scope per day,
    // latest wins (ADR 0005). Runs for every scope so all scopes get history.
    if (workspace) {
      const today = new Date().toISOString().slice(0, 10);
      const assets = store.readAssets();
      const liabilities = store.readLiabilities();

      for (const scope of scopes) {
        const existing = store.readSnapshots(scope.id);
        const plan = planSnapshotCapture(existing, scope.id, today);

        if (plan.shouldCapture) {
          const now = new Date().toISOString();
          const snapshot = captureNetWorthSnapshot({
            assets,
            capturedAt: now,
            id: buildSnapshotId(scope.id, now, Date.now()),
            liabilities,
            scopeId: scope.id,
            scopeLabel: scope.label,
            workspace,
          });
          store.saveSnapshot({ snapshot, replace: plan.replacesId !== undefined });
        }
      }
    }

    return {
      assets: store.readAssets(),
      fireConfig: store.readFireConfig(),
      liabilities: store.readLiabilities(),
      positions: selectedScope ? store.readPositions(selectedScope.id) : [],
      overrides: store.readWarningOverrides(),
      priceCache: store.readAllPriceCacheEntries(),
      trash: store.readTrash(),
      scopes,
      selectedScope,
      snapshots: selectedScope ? store.readSnapshots(selectedScope.id) : [],
      workspace,
    };
  });

  const state = prepareDashboardState({
    ...storeData,
    persistence,
    priceCache,
    selectedView,
  });

  const {
    activeMembers,
    assets,
    dashboard,
    deltas,
    fireResult,
    fireScopeConfig,
    investmentAssets,
    liabilities,
    onboarding,
    positions,
    presentation,
    pyramid,
    scopes,
    selectedMemberIds,
    selectedScope,
    snapshots,
    today,
    warnings,
    workspace,
  } = state;

  // Default owner for new holdings: the member whose scope is selected, else the
  // first active member. The ownership control auto-completes to total 100%.
  const ownershipScopeMemberId =
    activeMembers.find((member) => member.id === selectedScope?.id)?.id ??
    activeMembers[0]?.id;

  // First run: without holdings, zero figures are demoted ("sin datos aún").
  const hasHoldings = assets.length + liabilities.length > 0;

  // Typed input preserved for the form that failed validation (empty otherwise).
  const valuesFor = (formId: string): Record<string, string> =>
    formError?.formId === formId ? formError.values : {};
  const assetValues = valuesFor("asset");
  const liabilityValues = valuesFor("liability");
  const investmentValues = valuesFor("investment");
  const operationValues = valuesFor("operation");

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1>worthline</h1>
            <p>Patrimonio neto local</p>
          </div>
        </div>
        <div className="topbarMeta" aria-label="Estado de persistencia">
          <span className="statusDot" aria-hidden="true" />
          SQLite OK
        </div>
      </header>

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

      {warnings.length > 0 ? (
        <div className="warningBand" role="alert">
          {warnings.map((w) => (
            <div
              key={`${w.entityId}-${w.code}`}
              style={{
                alignItems: "center",
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                margin: "4px 0",
              }}
            >
              <span>⚠ {w.message}</span>
              <a href={`#${w.entityId}`} style={{ color: "#92400e", fontWeight: 700 }}>
                Actualizar valor
              </a>
              <form action={acknowledgeWarningAction}>
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <input name="code" type="hidden" value={w.code} />
                <input name="entityId" type="hidden" value={w.entityId} />
                <button type="submit">Es intencional</button>
              </form>
            </div>
          ))}
        </div>
      ) : null}

      {workspace && !hasHoldings ? (
        <section className="onboardingChecklist" aria-label="Primeros pasos">
          <div className="panelHeader">
            <h2>Primeros pasos</h2>
            <span>Empieza aquí</span>
          </div>
          <ol>
            {onboarding.map((step) => (
              <li className={step.done ? "done" : undefined} key={step.id}>
                {step.done ? "✓" : "○"} {step.label}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {workspace && scopes.length > 0 ? (
        <div className="tabsBar">
          <nav className="scopeTabs" aria-label="Selector de scope">
            {scopes.map((scope) => (
              <Link
                className={scope.id === selectedScope?.id ? "active" : undefined}
                href={`/?scope=${encodeURIComponent(scope.id)}&view=${selectedView}`}
                key={scope.id}
                scroll={false}
              >
                {scope.label}
              </Link>
            ))}
          </nav>
          {selectedScope ? (
            <nav className="framingTabs" aria-label="Vista de patrimonio">
              {framingTabs.map((tab) => (
                <Link
                  className={tab.id === selectedView ? "active" : undefined}
                  href={`/?scope=${encodeURIComponent(selectedScope.id)}&view=${tab.id}`}
                  key={tab.id}
                  scroll={false}
                >
                  {tab.label}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}

      {workspace ? (
        <section className="summaryBand" aria-label="Resumen patrimonial">
          <div className="scopeRail">
            <span>{selectedScope?.label ?? "Sin workspace"}</span>
            <span>{workspace?.baseCurrency ?? "EUR"}</span>
            <span>{new Date(dashboard.generatedAt).toLocaleString("es-ES")}</span>
          </div>
          {presentation ? (
            <div className="headline">
              <span>{presentation.headlineLabel}</span>
              <strong className={hasHoldings ? undefined : "emptyFigure"}>
                {formatMoneyMinor(presentation.headline)}
                {!hasHoldings ? <small>sin datos aún</small> : null}
              </strong>
              <div className="breakdown">
                {presentation.breakdown.map((item) => (
                  <span key={item.id}>
                    {item.label}{" "}
                    <b className={hasHoldings ? undefined : "emptyFigure"}>
                      {formatMoneyMinor(item.value)}
                    </b>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {deltas ? (
            <div className="deltaStrip" aria-label="Cambios de snapshots">
              <span>
                Snapshot anterior{" "}
                <b
                  className={
                    deltas.changeSincePrevious
                      ? moneySign(deltas.changeSincePrevious)
                      : undefined
                  }
                >
                  {formatOptionalMoney(deltas.changeSincePrevious)}
                </b>
              </span>
              <span>
                Cierre mensual{" "}
                <b
                  className={
                    deltas.changeSinceMonthlyClose
                      ? moneySign(deltas.changeSinceMonthlyClose)
                      : undefined
                  }
                >
                  {formatOptionalMoney(deltas.changeSinceMonthlyClose)}
                </b>
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      {!workspace ? (
        <section className="setupPanel" aria-label="Onboarding local">
          <div className="panelHeader">
            <h2>Crear workspace local</h2>
            <span>EUR por defecto</span>
          </div>
          <p className="onboardingHint">
            Todo se guarda solo en este dispositivo (SQLite local): sin nube, sin cuenta.
            «Hogar» habilita varios miembros con porcentajes de propiedad compartidos.
          </p>
          <form action={initializeWorkspaceAction} className="stackForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <label>
              Modo
              <select name="mode" defaultValue="individual">
                <option value="individual">Individual</option>
                <option value="household">Hogar</option>
              </select>
            </label>
            <label>
              Miembros (un nombre por línea)
              <textarea
                name="memberNames"
                defaultValue="Yo"
                rows={4}
                spellCheck={false}
              />
            </label>
            <button type="submit">Crear</button>
          </form>
        </section>
      ) : (
        <section className="setupPanel" aria-label="Miembros del workspace">
          <div className="panelHeader">
            <h2>Miembros</h2>
            <span>{selectedMemberIds.length} en scope</span>
          </div>
          <div className="memberGrid">
            {workspace.members.map((member) => (
              <form action={updateMemberAction} className="memberRow" key={member.id}>
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <input name="id" type="hidden" value={member.id} />
                <input
                  aria-label={`Nombre de ${member.name}`}
                  defaultValue={member.name}
                  disabled={Boolean(member.disabledAt)}
                  name="name"
                />
                <span>{member.disabledAt ? "Inactivo" : "Activo"}</span>
                {!member.disabledAt ? (
                  <>
                    <button type="submit">Guardar</button>
                    <button
                      formAction={disableMemberAction}
                      type="submit"
                      value={member.id}
                    >
                      Desactivar
                    </button>
                  </>
                ) : null}
              </form>
            ))}
          </div>
          <form action={createMemberAction} className="inlineForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="name" aria-label="Nuevo miembro" placeholder="Nuevo miembro" />
            <button type="submit">Añadir</button>
          </form>
        </section>
      )}

      {workspace ? (
        <div className="mainGrid">
          <section className="ledgerPanel" aria-label="Activos y deudas">
            <div className="panelHeader">
              <h2>Linea operativa</h2>
              <span>Activos y deudas</span>
            </div>
            <div className="entryGrid">
              <form action={createAssetAction} className="stackForm">
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <h3>Activo</h3>
                <FormErrorNote error={formError} formId="asset" />
                <input
                  aria-label="Nombre"
                  defaultValue={assetValues["name"]}
                  name="name"
                  placeholder="Nombre"
                />
                <select name="type" defaultValue={assetValues["type"] ?? "cash"}>
                  <option value="cash">Cash</option>
                  <option value="manual">Manual</option>
                  <option value="real_estate">Vivienda</option>
                </select>
                <input
                  defaultValue={assetValues["currentValue"]}
                  inputMode="decimal"
                  name="currentValue"
                  aria-label="Valor EUR"
                  placeholder="Valor EUR"
                />
                <select
                  name="liquidityTier"
                  defaultValue={assetValues["liquidityTier"] ?? "cash"}
                  title="Capa de liquidez: cómo de rápido puedes convertir el activo en efectivo (caja → mercado → jubilación → ilíquido → vivienda)."
                >
                  <option value="cash">Caja</option>
                  <option value="market">Mercado</option>
                  <option value="retirement">Jubilacion</option>
                  <option value="illiquid">Iliquido</option>
                  <option value="housing">Vivienda</option>
                </select>
                <label className="checkLine">
                  <input
                    defaultChecked={assetValues["isPrimaryResidence"] === "on"}
                    name="isPrimaryResidence"
                    type="checkbox"
                  />{" "}
                  Vivienda habitual
                </label>
                <OwnershipInputs
                  members={activeMembers}
                  scopeMemberId={ownershipScopeMemberId}
                  values={assetValues}
                />
                <button type="submit">Añadir activo</button>
              </form>

              <form action={createLiabilityAction} className="stackForm">
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <h3>Deuda</h3>
                <FormErrorNote error={formError} formId="liability" />
                <input
                  aria-label="Nombre"
                  defaultValue={liabilityValues["name"]}
                  name="name"
                  placeholder="Nombre"
                />
                <select name="type" defaultValue={liabilityValues["type"] ?? "mortgage"}>
                  <option value="mortgage">Hipoteca</option>
                  <option value="debt">Deuda</option>
                </select>
                <input
                  defaultValue={liabilityValues["balance"]}
                  inputMode="decimal"
                  name="balance"
                  aria-label="Saldo EUR"
                  placeholder="Saldo EUR"
                />
                <select
                  name="associatedAssetId"
                  defaultValue={liabilityValues["associatedAssetId"] ?? ""}
                >
                  <option value="">Sin activo asociado</option>
                  {assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </select>
                <OwnershipInputs
                  members={activeMembers}
                  scopeMemberId={ownershipScopeMemberId}
                  values={liabilityValues}
                />
                <button type="submit">Añadir deuda</button>
              </form>
            </div>

            <div className="tableScroll">
              <table>
                <thead>
                  <tr>
                    <th>Registro</th>
                    <th>Tipo</th>
                    <th>Valor actual</th>
                    <th>Actualizar</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => (
                    <tr id={asset.id} key={asset.id}>
                      <td>{asset.name}</td>
                      <td>{asset.liquidityTier}</td>
                      <td>{formatMoneyMinor(asset.currentValue)}</td>
                      <td>
                        {asset.type === "investment" ? (
                          <span aria-label={`Valor de ${asset.name} (derivado)`}>
                            {formatMoneyMinor(asset.currentValue)}
                          </span>
                        ) : (
                          <form action={updateAssetValuationAction} className="rowForm">
                            <input name="currentUrl" type="hidden" value={currentUrl} />
                            <input name="id" type="hidden" value={asset.id} />
                            <input
                              aria-label={`Valor de ${asset.name}`}
                              defaultValue={
                                formError?.formId === asset.id
                                  ? formError.values["currentValue"]
                                  : formatMoneyInput(asset.currentValue.amountMinor)
                              }
                              inputMode="decimal"
                              name="currentValue"
                            />
                            <button type="submit">OK</button>
                            <FormErrorNote error={formError} formId={asset.id} />
                          </form>
                        )}
                      </td>
                      <td>
                        <form action={deleteAssetAction}>
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="id" type="hidden" value={asset.id} />
                          <details className="confirmDelete">
                            <summary>Eliminar</summary>
                            <button type="submit">Confirmar</button>
                          </details>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {liabilities.map((liability) => (
                    <tr id={liability.id} key={liability.id}>
                      <td>{liability.name}</td>
                      <td>{liability.type}</td>
                      <td>{formatMoneyMinor(liability.currentBalance)}</td>
                      <td>
                        <form action={updateLiabilityBalanceAction} className="rowForm">
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="id" type="hidden" value={liability.id} />
                          <input
                            aria-label={`Saldo de ${liability.name}`}
                            defaultValue={
                              formError?.formId === liability.id
                                ? formError.values["balance"]
                                : formatMoneyInput(liability.currentBalance.amountMinor)
                            }
                            inputMode="decimal"
                            name="balance"
                          />
                          <button type="submit">OK</button>
                          <FormErrorNote error={formError} formId={liability.id} />
                        </form>
                      </td>
                      <td>
                        <form action={deleteLiabilityAction}>
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="id" type="hidden" value={liability.id} />
                          <details className="confirmDelete">
                            <summary>Eliminar</summary>
                            <button type="submit">Confirmar</button>
                          </details>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {assets.length === 0 && liabilities.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        Sin registros todavía — añade tu primer activo o deuda con los
                        formularios de arriba.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {storeData.trash.assets.length + storeData.trash.liabilities.length > 0 ? (
              <details className="trashPanel">
                <summary>
                  Papelera (
                  {storeData.trash.assets.length + storeData.trash.liabilities.length})
                </summary>
                <div className="trashList">
                  {storeData.trash.assets.map((item) => (
                    <form action={restoreAssetAction} className="trashRow" key={item.id}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={item.id} />
                      <span>{item.name}</span>
                      <button type="submit">Restaurar</button>
                    </form>
                  ))}
                  {storeData.trash.liabilities.map((item) => (
                    <form
                      action={restoreLiabilityAction}
                      className="trashRow"
                      key={item.id}
                    >
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={item.id} />
                      <span>{item.name}</span>
                      <button type="submit">Restaurar</button>
                    </form>
                  ))}
                </div>
              </details>
            ) : null}
          </section>

          <section className="positionsPanel" aria-label="Inversiones y posiciones">
            <div className="panelHeader">
              <h2>Inversiones</h2>
              <span>Unidades, coste medio y P/L</span>
            </div>
            <form action={refreshPricesAction} className="inlineForm">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <button type="submit">Actualizar precios</button>
            </form>
            <div className="entryGrid">
              <form action={createInvestmentAssetAction} className="stackForm">
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <h3>Nueva inversión</h3>
                <FormErrorNote error={formError} formId="investment" />
                <input
                  aria-label="Nombre"
                  defaultValue={investmentValues["name"]}
                  name="name"
                  placeholder="Nombre"
                />
                <input
                  defaultValue={investmentValues["unitSymbol"]}
                  name="unitSymbol"
                  aria-label="Ticker o símbolo"
                  placeholder="Ticker / símbolo"
                />
                <input
                  defaultValue={investmentValues["isin"]}
                  name="isin"
                  aria-label="ISIN (opcional)"
                  placeholder="ISIN (opcional)"
                />
                <input
                  defaultValue={investmentValues["manualPricePerUnit"]}
                  inputMode="decimal"
                  name="manualPricePerUnit"
                  aria-label="Precio actual por unidad en EUR"
                  placeholder="Precio actual/unidad EUR"
                />
                <OwnershipInputs
                  members={activeMembers}
                  scopeMemberId={ownershipScopeMemberId}
                  values={investmentValues}
                />
                <button type="submit">Añadir inversión</button>
              </form>

              <form action={recordOperationAction} className="stackForm">
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <h3>Operación</h3>
                <FormErrorNote error={formError} formId="operation" />
                <select name="assetId" defaultValue={operationValues["assetId"] ?? ""}>
                  <option disabled value="">
                    Selecciona inversión
                  </option>
                  {investmentAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </select>
                <select name="kind" defaultValue={operationValues["kind"] ?? "buy"}>
                  <option value="buy">Compra</option>
                  <option value="sell">Venta</option>
                </select>
                <input
                  aria-label="Fecha"
                  defaultValue={operationValues["executedAt"] ?? today}
                  name="executedAt"
                  type="date"
                />
                <input
                  defaultValue={operationValues["units"]}
                  inputMode="decimal"
                  name="units"
                  aria-label="Unidades"
                  placeholder="Unidades"
                />
                <input
                  defaultValue={operationValues["pricePerUnit"]}
                  inputMode="decimal"
                  name="pricePerUnit"
                  aria-label="Precio por unidad en EUR"
                  placeholder="Precio/unidad EUR"
                />
                <input
                  defaultValue={operationValues["fees"] ?? "0"}
                  inputMode="decimal"
                  name="fees"
                  aria-label="Comisiones EUR"
                  placeholder="Comisiones EUR"
                />
                <button type="submit">Registrar operación</button>
              </form>
            </div>

            <div className="tableScroll">
              <table>
                <thead>
                  <tr>
                    <th>Inversión</th>
                    <th>Unidades</th>
                    <th>Coste medio</th>
                    <th>Precio/u</th>
                    <th>Valor</th>
                    <th>P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position) => {
                    const cachedPrice = priceCache.find(
                      (entry) => entry.assetId === position.assetId,
                    );
                    const freshness = cachedPrice
                      ? getPriceFreshness(cachedPrice, persistence.checkedAt)
                      : null;

                    return (
                      <tr key={position.assetId}>
                        <td>
                          {position.name}
                          {position.warnings.length > 0 ? " ⚠" : ""}
                        </td>
                        <td>{position.currentUnits}</td>
                        <td>{position.averageUnitCost}</td>
                        <td>
                          {cachedPrice ? (
                            <>
                              {cachedPrice.price}{" "}
                              <small className={`priceStatus ${freshness ?? "unknown"}`}>
                                {priceFreshnessLabel(freshness)}
                              </small>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          {position.marketValue
                            ? formatMoneyMinor(position.marketValue)
                            : "—"}
                        </td>
                        <td
                          className={
                            position.unrealizedPnl
                              ? moneySign(position.unrealizedPnl)
                              : undefined
                          }
                        >
                          {position.unrealizedPnl
                            ? formatMoneyMinor(position.unrealizedPnl)
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {positions.length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        Sin inversiones todavía — crea una con «Nueva inversión».
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="liquidityPanel" aria-label="Liquidez por capa">
            <div className="panelHeader">
              <h2>Liquidez</h2>
              <span>Por capa · % del bruto</span>
            </div>
            <div className="pyramid">
              {pyramid.map((tier) => (
                <details className={`tier ${tier.tier}`} key={tier.tier} open>
                  <summary>
                    <span className="tierName">{tierLabel(tier.tier)}</span>
                    <span className="tierBar" aria-hidden="true">
                      <i
                        style={{ width: `${Math.max(2, tier.shareOfGrossBps / 100)}%` }}
                      />
                    </span>
                    <b className={moneySign(tier.netValue)}>
                      {formatMoneyMinor(tier.netValue)}
                    </b>
                    <span className="tierShare">
                      {Math.round(tier.shareOfGrossBps / 100)}%
                    </span>
                  </summary>
                  <div className="tierDetails">
                    <span>Bruto {formatMoneyMinor(tier.grossAssets)}</span>
                    <span>Deuda {formatMoneyMinor(tier.debts)}</span>
                    {tier.assets.map((asset) => (
                      <small key={asset.id}>+ {asset.name}</small>
                    ))}
                    {tier.liabilities.map((liability) => (
                      <small key={liability.id}>- {liability.name}</small>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {workspace ? (
        <section className="historyPanel" aria-label="Snapshots">
          <div className="panelHeader">
            <h2>Snapshots</h2>
            <span>{snapshots.length} capturas</span>
          </div>
          <div className="historyBars">
            {snapshots.map((snapshot) => (
              <div
                className={`historyBar ${moneySign(snapshot.totalNetWorth) === "neg" ? "negative" : ""}`}
                key={snapshot.id}
              >
                <span>{snapshot.dateKey}</span>
                <b className={moneySign(snapshot.totalNetWorth)}>
                  {formatMoneyMinor(snapshot.totalNetWorth)}
                </b>
                <i
                  style={{
                    width: `${historyWidth(snapshot.totalNetWorth, snapshots)}%`,
                  }}
                />
              </div>
            ))}
            {snapshots.length === 0 ? (
              <span className="emptyLine">
                Sin capturas todavía — vuelve mañana para ver tu primera comparativa.
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {workspace ? (
        <section className="firePanel" aria-label="FIRE">
          <div className="panelHeader">
            <h2>FIRE</h2>
            <span>Independencia financiera</span>
          </div>
          {!fireScopeConfig || isFireEdit ? (
            selectedScope ? (
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
            ) : null
          ) : (
            <div className="fireResults">
              <div>
                <span>Número FIRE</span>
                <strong>{formatMoneyMinor(fireResult!.fireNumber)}</strong>
              </div>
              <div>
                <span>Activos elegibles</span>
                <strong>{formatMoneyMinor(fireResult!.eligibleAssets)}</strong>
              </div>
              <div className="fireProgress">
                <div className="fireProgressTop">
                  <span>% financiado</span>
                  <strong>{fireResult!.percentFunded.toFixed(1)}%</strong>
                </div>
                <div className="fireBar">
                  {fireResult!.coastFireRequired &&
                  fireResult!.fireNumber.amountMinor > 0 ? (
                    <span
                      aria-hidden="true"
                      className="fireTick"
                      style={{
                        left: `${Math.min(
                          100,
                          (fireResult!.coastFireRequired.amountMinor /
                            fireResult!.fireNumber.amountMinor) *
                            100,
                        )}%`,
                      }}
                    />
                  ) : null}
                  <i
                    style={{
                      width: `${Math.min(100, Math.max(0, fireResult!.percentFunded))}%`,
                    }}
                  />
                </div>
                {fireResult!.percentFunded >= 100 ? (
                  <span className="statePill ready">FIRE alcanzado</span>
                ) : fireResult!.isAlreadyAtCoastFire ? (
                  <span className="statePill ready">Coast FIRE alcanzado</span>
                ) : null}
              </div>
              {fireResult!.coastFireRequired ? (
                <div>
                  <span>Coast FIRE requerido</span>
                  <strong>{formatMoneyMinor(fireResult!.coastFireRequired)}</strong>
                </div>
              ) : null}
              {fireResult!.coastFireAge !== undefined ? (
                <div>
                  <span>Edad Coast FIRE</span>
                  <strong>{fireResult!.coastFireAge.toFixed(1)}</strong>
                </div>
              ) : null}
              {selectedScope ? (
                <Link
                  className="reconfigureButton"
                  href={`/?scope=${encodeURIComponent(selectedScope.id)}&fireEdit=true`}
                  scroll={false}
                >
                  Reconfigurar
                </Link>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <footer className="persistenceBar">
        <span>Base de datos · {dashboard.persistence.displayPath}</span>
        <span>
          guardado ·{" "}
          {new Date(dashboard.persistence.checkedAt).toLocaleTimeString("es-ES", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </footer>
    </main>
  );
}

/** The validation error rendered beside the form that produced it. */
function FormErrorNote({
  error,
  formId,
}: {
  error: FormErrorContext | null;
  formId: string;
}) {
  if (!error || error.formId !== formId) {
    return null;
  }

  return (
    <p className="formError" role="alert">
      {error.message}
    </p>
  );
}

function OwnershipInputs({
  members,
  scopeMemberId,
  values = {},
}: {
  members: Member[];
  scopeMemberId?: string | undefined;
  values?: Record<string, string>;
}) {
  // A single active member implicitly owns 100% — no control needed.
  if (members.length <= 1) {
    return null;
  }

  const scopeMember =
    members.find((member) => member.id === scopeMemberId) ?? members[0]!;
  const preset = values["ownershipPreset"];

  return (
    <fieldset className="ownershipGrid">
      <legend>Propiedad</legend>
      <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
      <label className="ownerPreset">
        <input
          defaultChecked={!preset || preset === "scope"}
          name="ownershipPreset"
          type="radio"
          value="scope"
        />
        100% {scopeMember.name}
      </label>
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "even"}
          name="ownershipPreset"
          type="radio"
          value="even"
        />
        Repartir a partes iguales
      </label>
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "custom"}
          name="ownershipPreset"
          type="radio"
          value="custom"
        />
        Personalizado
      </label>
      <div className="ownerCustom">
        {members.map((member, index) => (
          <label key={member.id}>
            {member.name}
            <input
              defaultValue={values[`owner_${member.id}`] ?? (index === 0 ? "100" : "0")}
              inputMode="decimal"
              name={`owner_${member.id}`}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

async function initializeWorkspaceAction(formData: FormData) {
  "use server";

  const command = parseWorkspaceInit(formData);

  withStore((store) => store.initializeWorkspace(command));
  redirect("/?scope=household");
}

async function createMemberAction(formData: FormData) {
  "use server";

  const member = parseNewMember(formData, Date.now());

  if (!member) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "El nombre del miembro es obligatorio.",
      }),
    );
  }

  withStore((store) => store.createMember(member));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

async function updateMemberAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);
  const name = String(formData.get("name") ?? "").trim();

  if (!id || !name) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: !id
          ? "Identificador de miembro no encontrado."
          : "El nombre del miembro es obligatorio.",
      }),
    );
  }

  withStore((store) => store.updateMember({ id, name }));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

async function disableMemberAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  withStore((store) => store.disableMember(id, new Date().toISOString()));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

async function createAssetAction(formData: FormData) {
  "use server";

  const assetErrorUrl = (message: string) =>
    errorRedirectUrl(currentUrlOf(formData), {
      formId: "asset",
      message,
      values: preserveFields(formData, ASSET_FORM_FIELDS, ["owner_"]),
    });
  const currentValue = parseMoneyMinorField(formData, "currentValue");

  if (currentValue === null) {
    redirect(assetErrorUrl("El valor del activo no es válido."));
  }

  const result = withStore((store): ActionResult => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return { ok: false };
    }

    const command = parseAssetCommand(formData, workspace.members, Date.now());
    const ownershipError = validateOwnershipShares(command.ownership);

    if (ownershipError) {
      return { error: ownershipError, ok: false };
    }

    store.createManualAsset(command);

    return { ok: true };
  });

  if (result.error) {
    redirect(assetErrorUrl(result.error));
  }

  if (result.ok) {
    redirect(appendParam(currentUrlOf(formData), "ok", "asset_added"));
  }

  redirect(
    errorRedirectUrl(currentUrlOf(formData), {
      message: "No se pudo añadir el activo: workspace no inicializado.",
    }),
  );
}

async function updateAssetValuationAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);
  const currentValue = parseMoneyMinorField(formData, "currentValue");

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  if (currentValue === null) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        formId: id,
        message: "El valor del activo no es válido.",
        values: preserveFields(formData, ["currentValue"]),
      }),
    );
  }

  withStore((store) => store.updateAssetValuation(id, currentValue));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

async function createLiabilityAction(formData: FormData) {
  "use server";

  const liabilityErrorUrl = (message: string) =>
    errorRedirectUrl(currentUrlOf(formData), {
      formId: "liability",
      message,
      values: preserveFields(formData, LIABILITY_FORM_FIELDS, ["owner_"]),
    });
  const balance = parseMoneyMinorField(formData, "balance");

  if (balance === null) {
    redirect(liabilityErrorUrl("El saldo de la deuda no es válido."));
  }

  const result = withStore((store): ActionResult => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return { ok: false };
    }

    const command = parseLiabilityCommand(formData, workspace.members, Date.now());
    const ownershipError = validateOwnershipShares(command.ownership);

    if (ownershipError) {
      return { error: ownershipError, ok: false };
    }

    store.createLiability(command);

    return { ok: true };
  });

  if (result.error) {
    redirect(liabilityErrorUrl(result.error));
  }

  if (result.ok) {
    redirect(appendParam(currentUrlOf(formData), "ok", "liability_added"));
  }

  redirect(
    errorRedirectUrl(currentUrlOf(formData), {
      message: "No se pudo añadir la deuda: workspace no inicializado.",
    }),
  );
}

async function createInvestmentAssetAction(formData: FormData) {
  "use server";

  const investmentErrorUrl = (message: string) =>
    errorRedirectUrl(currentUrlOf(formData), {
      formId: "investment",
      message,
      values: preserveFields(formData, INVESTMENT_FORM_FIELDS, ["owner_"]),
    });
  const result = withStore((store): ActionResult => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return { ok: false };
    }

    const command = parseInvestmentAssetCommand(formData, workspace.members, Date.now());
    const ownershipError = validateOwnershipShares(command.ownership);

    if (ownershipError) {
      return { error: ownershipError, ok: false };
    }

    store.createInvestmentAsset(command);

    return { ok: true };
  });

  if (result.error) {
    redirect(investmentErrorUrl(result.error));
  }

  if (result.ok) {
    redirect(appendParam(currentUrlOf(formData), "ok", "investment_added"));
  }

  redirect(
    errorRedirectUrl(currentUrlOf(formData), {
      message: "No se pudo añadir la inversión: workspace no inicializado.",
    }),
  );
}

async function recordOperationAction(formData: FormData) {
  "use server";

  const operationErrorUrl = () =>
    errorRedirectUrl(currentUrlOf(formData), {
      formId: "operation",
      message: "No se pudo registrar la operación: revisa unidades, precio y comisiones.",
      values: preserveFields(formData, OPERATION_FORM_FIELDS),
    });
  const fees = parseMoneyMinorField(formData, "fees");

  if (fees === null) {
    redirect(operationErrorUrl());
  }

  const command = parseOperationCommand(
    formData,
    Date.now(),
    new Date().toISOString().slice(0, 10),
  );

  if (!command.assetId) {
    redirect(operationErrorUrl());
  }

  try {
    withStore((store) => store.recordOperation(command));
  } catch {
    redirect(operationErrorUrl());
  }

  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

async function updateLiabilityBalanceAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);
  const balance = parseMoneyMinorField(formData, "balance");

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  if (balance === null) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        formId: id,
        message: "El saldo de la deuda no es válido.",
        values: preserveFields(formData, ["balance"]),
      }),
    );
  }

  withStore((store) => store.updateLiabilityBalance(id, balance));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

async function saveFireConfigAction(formData: FormData) {
  "use server";

  const scopeId = parseScopeParam(formData.get("scopeId") as string | undefined);
  const config = parseFireConfigForm(formData);

  withStore((store) => store.saveFireConfig(scopeId, config));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

async function deleteAssetAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  withStore((store) => store.softDeleteAsset(id, new Date().toISOString()));
  redirect(successRedirectUrl(currentUrlOf(formData), "deleted_recoverable", id));
}

async function deleteLiabilityAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  withStore((store) => store.softDeleteLiability(id, new Date().toISOString()));
  redirect(successRedirectUrl(currentUrlOf(formData), "deleted_recoverable", id));
}

async function restoreAssetAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de activo no encontrado.",
      }),
    );
  }

  withStore((store) => store.restoreAsset(id));
  redirect(successRedirectUrl(currentUrlOf(formData), "restored", id));
}

async function restoreLiabilityAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de deuda no encontrado.",
      }),
    );
  }

  withStore((store) => store.restoreLiability(id));
  redirect(successRedirectUrl(currentUrlOf(formData), "restored", id));
}

async function acknowledgeWarningAction(formData: FormData) {
  "use server";

  const code = String(formData.get("code") ?? "").trim();
  const entityId = String(formData.get("entityId") ?? "").trim();

  if (!code || !entityId) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Datos de aviso incompletos.",
      }),
    );
  }

  withStore((store) => store.acknowledgeWarning(code, entityId));
  redirect(appendParam(currentUrlOf(formData), "ok", "warning_acknowledged"));
}

async function refreshPricesAction(formData: FormData) {
  "use server";

  const nowIso = new Date().toISOString();

  // fetchAndCachePrice never throws: failures come back as freshnessState "failed".
  const outcome = await withStore(async (store) => {
    const investmentAssets = store.readInvestmentAssetsWithMeta();
    const refreshable = investmentAssets.filter((asset) => Boolean(asset.providerSymbol));
    const results = await Promise.all(
      refreshable.map(async (asset) => {
        const price = await fetchAndCachePrice(stooqProvider, {
          assetId: asset.id,
          symbol: asset.providerSymbol!,
          currency: asset.currency,
          nowIso,
        });
        store.upsertPrice(price);

        return { price, symbol: asset.providerSymbol! };
      }),
    );

    return {
      failedSymbols: results
        .filter((entry) => entry.price.freshnessState === "failed")
        .map((entry) => entry.symbol),
      updated: results.filter((entry) => entry.price.freshnessState === "fresh").length,
    };
  });

  redirect(pricesRefreshedRedirectUrl(currentUrlOf(formData), outcome));
}

function formatOptionalMoney(value: MoneyMinor | undefined): string {
  return value ? formatMoneyMinor(value) : "sin dato";
}

function priceFreshnessLabel(freshness: PriceFreshnessState | null): string {
  if (!freshness) return "—";
  const labels: Record<PriceFreshnessState, string> = {
    failed: "Fallido",
    fresh: "Reciente",
    manual: "Manual",
    stale: "Obsoleto",
  };
  return labels[freshness];
}

function tierLabel(tier: ManualAsset["liquidityTier"]): string {
  const labels = {
    cash: "Caja",
    housing: "Vivienda",
    illiquid: "Iliquido",
    market: "Mercado",
    retirement: "Jubilacion",
  } as const;

  return labels[tier];
}

function historyWidth(
  value: MoneyMinor,
  snapshots: Array<{ totalNetWorth: MoneyMinor }>,
): number {
  const max = Math.max(
    1,
    ...snapshots.map((snapshot) => Math.abs(snapshot.totalNetWorth.amountMinor)),
  );

  return Math.max(4, Math.round((Math.abs(value.amountMinor) / max) * 100));
}
