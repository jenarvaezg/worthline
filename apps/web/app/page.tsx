import type { MoneyMinor } from "@worthline/domain";
import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  captureNetWorthSnapshot,
  formatMoneyInput,
  formatMoneyMinor,
  getPriceFreshness,
  listScopeOptions,
  moneySign,
  prepareDashboardState,
} from "@worthline/domain";
import type {
  ManualAsset,
  Member,
  NetWorthFraming,
  PriceFreshnessState,
} from "@worthline/domain";
import { fetchAndCachePrice, stooqProvider } from "@worthline/pricing";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  buildSnapshotId,
  parseAssetCommand,
  parseEntityId,
  parseFireConfigForm,
  parseInvestmentAssetCommand,
  parseLiabilityCommand,
  parseMoneyMinorField,
  parseNewMember,
  parseOperationCommand,
  parseScopeParam,
  parseSnapshotForm,
  parseViewParam,
  parseWorkspaceInit,
  validateOwnershipShares,
} from "./intake";

export const dynamic = "force-dynamic";

function buildCurrentUrl(
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, item);
        }
      } else {
        params.set(key, value);
      }
    }
  }

  const queryString = params.toString();

  return queryString ? `/?${queryString}` : "/";
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
  const errorParam = resolvedSearchParams?.error;
  const formError = Array.isArray(errorParam) ? errorParam[0] : errorParam;
  const isFireEdit = resolvedSearchParams?.fireEdit === "true";
  const currentUrl = buildCurrentUrl(resolvedSearchParams);
  const storeData = withStore((store) => {
    const workspace = store.readWorkspace();
    const scopes = workspace ? listScopeOptions(workspace) : [];
    const selectedScopeId = parseScopeParam(resolvedSearchParams?.scope);
    const selectedScope =
      scopes.find((scope) => scope.id === selectedScopeId) ?? scopes[0];

    return {
      assets: store.readAssets(),
      fireConfig: store.readFireConfig(),
      liabilities: store.readLiabilities(),
      positions: selectedScope ? store.readPositions(selectedScope.id) : [],
      priceCache: store.readAllPriceCacheEntries(),
      scopes,
      selectedScope,
      snapshots: selectedScope ? store.readSnapshots(selectedScope.id) : [],
      workspace,
    };
  });

  const state = prepareDashboardState({
    ...storeData,
    persistence,
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
    positions,
    presentation,
    priceCache,
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

      {formError ? (
        <p role="alert" style={{ color: "#c0392b", fontWeight: 600, margin: "0 0 12px" }}>
          {formError}
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <div
          role="alert"
          style={{
            background: "#fffbeb",
            border: "1px solid #f59e0b",
            borderRadius: 6,
            color: "#92400e",
            margin: "0 0 12px",
            padding: "10px 14px",
          }}
        >
          {warnings.map((w) => (
            <p key={`${w.entityId}-${w.code}`} style={{ margin: "2px 0" }}>
              ⚠ {w.message}
            </p>
          ))}
        </div>
      ) : null}

      <section className="summaryBand" aria-label="Resumen patrimonial">
        <div className="scopeRail">
          <span>{selectedScope?.label ?? "Sin workspace"}</span>
          <span>{workspace?.baseCurrency ?? "EUR"}</span>
          <span>{new Date(dashboard.generatedAt).toLocaleString("es-ES")}</span>
        </div>
        {scopes.length > 0 ? (
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
        ) : null}
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
        {presentation ? (
          <div className="headline">
            <span>{presentation.headlineLabel}</span>
            <strong>{formatMoneyMinor(presentation.headline)}</strong>
            <div className="breakdown">
              {presentation.breakdown.map((item) => (
                <span key={item.id}>
                  {item.label} <b>{formatMoneyMinor(item.value)}</b>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {deltas ? (
          <div className="deltaStrip" aria-label="Cambios de snapshots">
            <span>
              Snapshot anterior{" "}
              <b className={deltas.changeSincePrevious ? moneySign(deltas.changeSincePrevious) : undefined}>
                {formatOptionalMoney(deltas.changeSincePrevious)}
              </b>
            </span>
            <span>
              Cierre mensual{" "}
              <b className={deltas.changeSinceMonthlyClose ? moneySign(deltas.changeSinceMonthlyClose) : undefined}>
                {formatOptionalMoney(deltas.changeSinceMonthlyClose)}
              </b>
            </span>
          </div>
        ) : null}
      </section>

      {!workspace ? (
        <section className="setupPanel" aria-label="Onboarding local">
          <div className="panelHeader">
            <h2>Crear workspace local</h2>
            <span>EUR por defecto</span>
          </div>
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
              Miembros
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
            <input name="name" placeholder="Nuevo miembro" />
            <button type="submit">Añadir</button>
          </form>
        </section>
      )}

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
              <input name="name" placeholder="Nombre" />
              <select name="type" defaultValue="cash">
                <option value="cash">Cash</option>
                <option value="manual">Manual</option>
                <option value="real_estate">Vivienda</option>
              </select>
              <input inputMode="decimal" name="currentValue" placeholder="Valor EUR" />
              <select name="liquidityTier" defaultValue="cash">
                <option value="cash">Caja</option>
                <option value="market">Mercado</option>
                <option value="retirement">Jubilacion</option>
                <option value="illiquid">Iliquido</option>
                <option value="housing">Vivienda</option>
              </select>
              <label className="checkLine">
                <input name="isPrimaryResidence" type="checkbox" /> Vivienda habitual
              </label>
              <OwnershipInputs members={activeMembers} scopeMemberId={ownershipScopeMemberId} />
              <button type="submit">Añadir activo</button>
            </form>

            <form action={createLiabilityAction} className="stackForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
              <h3>Deuda</h3>
              <input name="name" placeholder="Nombre" />
              <select name="type" defaultValue="mortgage">
                <option value="mortgage">Hipoteca</option>
                <option value="debt">Deuda</option>
              </select>
              <input inputMode="decimal" name="balance" placeholder="Saldo EUR" />
              <select name="associatedAssetId" defaultValue="">
                <option value="">Sin activo asociado</option>
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
              <OwnershipInputs members={activeMembers} scopeMemberId={ownershipScopeMemberId} />
              <button type="submit">Añadir deuda</button>
            </form>
          </div>

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
                <tr key={asset.id}>
                  <td>{asset.name}</td>
                  <td>{asset.liquidityTier}</td>
                  <td>{formatMoneyMinor(asset.currentValue)}</td>
                  <td>
                    <form action={updateAssetValuationAction} className="rowForm">
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={asset.id} />
                      <input
                        aria-label={`Valor de ${asset.name}`}
                        defaultValue={formatMoneyInput(asset.currentValue.amountMinor)}
                        inputMode="decimal"
                        name="currentValue"
                      />
                      <button type="submit">OK</button>
                    </form>
                  </td>
                  <td>
                    <form action={deleteAssetAction}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={asset.id} />
                      <button type="submit">Eliminar</button>
                    </form>
                  </td>
                </tr>
              ))}
              {liabilities.map((liability) => (
                <tr key={liability.id}>
                  <td>{liability.name}</td>
                  <td>{liability.type}</td>
                  <td>{formatMoneyMinor(liability.currentBalance)}</td>
                  <td>
                    <form action={updateLiabilityBalanceAction} className="rowForm">
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={liability.id} />
                      <input
                        aria-label={`Saldo de ${liability.name}`}
                        defaultValue={formatMoneyInput(
                          liability.currentBalance.amountMinor,
                        )}
                        inputMode="decimal"
                        name="balance"
                      />
                      <button type="submit">OK</button>
                    </form>
                  </td>
                  <td>
                    <form action={deleteLiabilityAction}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={liability.id} />
                      <button type="submit">Eliminar</button>
                    </form>
                  </td>
                </tr>
              ))}
              {assets.length === 0 && liabilities.length === 0 ? (
                <tr>
                  <td colSpan={5}>Sin registros</td>
                </tr>
              ) : null}
            </tbody>
          </table>
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
              <input name="name" placeholder="Nombre" />
              <input name="unitSymbol" placeholder="Ticker / símbolo" />
              <input name="isin" placeholder="ISIN (opcional)" />
              <input
                inputMode="decimal"
                name="manualPricePerUnit"
                placeholder="Precio actual/unidad EUR"
              />
              <OwnershipInputs members={activeMembers} scopeMemberId={ownershipScopeMemberId} />
              <button type="submit">Añadir inversión</button>
            </form>

            <form action={recordOperationAction} className="stackForm">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <h3>Operación</h3>
              <select name="assetId" defaultValue="">
                <option disabled value="">
                  Selecciona inversión
                </option>
                {investmentAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
              <select name="kind" defaultValue="buy">
                <option value="buy">Compra</option>
                <option value="sell">Venta</option>
              </select>
              <input
                aria-label="Fecha"
                defaultValue={today}
                name="executedAt"
                type="date"
              />
              <input inputMode="decimal" name="units" placeholder="Unidades" />
              <input
                inputMode="decimal"
                name="pricePerUnit"
                placeholder="Precio/unidad EUR"
              />
              <input
                defaultValue="0"
                inputMode="decimal"
                name="fees"
                placeholder="Comisiones EUR"
              />
              <button type="submit">Registrar operación</button>
            </form>
          </div>

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
                    <td className={position.unrealizedPnl ? moneySign(position.unrealizedPnl) : undefined}>
                      {position.unrealizedPnl
                        ? formatMoneyMinor(position.unrealizedPnl)
                        : "—"}
                    </td>
                  </tr>
                );
              })}
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={6}>Sin inversiones</td>
                </tr>
              ) : null}
            </tbody>
          </table>
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
                    <i style={{ width: `${Math.max(2, tier.shareOfGrossBps / 100)}%` }} />
                  </span>
                  <b className={moneySign(tier.netValue)}>{formatMoneyMinor(tier.netValue)}</b>
                  <span className="tierShare">{Math.round(tier.shareOfGrossBps / 100)}%</span>
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

      <section className="historyPanel" aria-label="Snapshots">
        <div className="panelHeader">
          <h2>Snapshots</h2>
          <span>{snapshots.length} guardados</span>
        </div>
        {selectedScope ? (
          <form action={saveSnapshotAction} className="snapshotForm">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="scopeId" type="hidden" value={selectedScope.id} />
            <label className="checkLine">
              <input name="isMonthlyClose" type="checkbox" /> Cierre mensual
            </label>
            <label className="checkLine">
              <input name="replace" type="checkbox" /> Reemplazar hoy
            </label>
            <button type="submit">Guardar snapshot</button>
          </form>
        ) : null}
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
            <span className="emptyLine">Sin snapshots</span>
          ) : null}
        </div>
      </section>

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
                  defaultValue={
                    fireScopeConfig?.currentAge?.toString()
                  }
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
            <div>
              <span>% financiado</span>
              <strong>{fireResult!.percentFunded.toFixed(1)}%</strong>
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

      <footer className="persistenceBar">
        <span>{dashboard.persistence.displayPath}</span>
        <code>{dashboard.persistence.checkKey}</code>
      </footer>
    </main>
  );
}

function OwnershipInputs({
  members,
  scopeMemberId,
}: {
  members: Member[];
  scopeMemberId?: string | undefined;
}) {
  // A single active member implicitly owns 100% — no control needed.
  if (members.length <= 1) {
    return null;
  }

  const scopeMember = members.find((member) => member.id === scopeMemberId) ?? members[0]!;

  return (
    <fieldset className="ownershipGrid">
      <legend>Propiedad</legend>
      <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
      <label className="ownerPreset">
        <input defaultChecked name="ownershipPreset" type="radio" value="scope" />
        100% {scopeMember.name}
      </label>
      <label className="ownerPreset">
        <input name="ownershipPreset" type="radio" value="even" />
        Repartir a partes iguales
      </label>
      <label className="ownerPreset">
        <input name="ownershipPreset" type="radio" value="custom" />
        Personalizado
      </label>
      <div className="ownerCustom">
        {members.map((member, index) => (
          <label key={member.id}>
            {member.name}
            <input
              defaultValue={index === 0 ? "100" : "0"}
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
    return;
  }

  withStore((store) => store.createMember(member));
  redirect(formData.get("currentUrl") as string || "/");
}

async function updateMemberAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);
  const name = String(formData.get("name") ?? "").trim();

  if (!id || !name) {
    return;
  }

  withStore((store) => store.updateMember({ id, name }));
  redirect(formData.get("currentUrl") as string || "/");
}

async function disableMemberAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    return;
  }

  withStore((store) => store.disableMember(id, new Date().toISOString()));
  redirect(formData.get("currentUrl") as string || "/");
}

async function createAssetAction(formData: FormData) {
  "use server";

  const currentValue = parseMoneyMinorField(formData, "currentValue");

  if (currentValue === null) {
    redirect(`/?error=${encodeURIComponent("El valor del activo no es válido.")}`);
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
    redirect(`/?error=${encodeURIComponent(result.error)}`);
  }

  if (result.ok) {
    redirect(formData.get("currentUrl") as string || "/");
  }
}

async function updateAssetValuationAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);
  const currentValue = parseMoneyMinorField(formData, "currentValue");

  if (!id) {
    return;
  }

  if (currentValue === null) {
    redirect(`/?error=${encodeURIComponent("El valor del activo no es válido.")}`);
  }

  withStore((store) => store.updateAssetValuation(id, currentValue));
  redirect(formData.get("currentUrl") as string || "/");
}

async function createLiabilityAction(formData: FormData) {
  "use server";

  const balance = parseMoneyMinorField(formData, "balance");

  if (balance === null) {
    redirect(`/?error=${encodeURIComponent("El saldo de la deuda no es válido.")}`);
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
    redirect(`/?error=${encodeURIComponent(result.error)}`);
  }

  if (result.ok) {
    redirect(formData.get("currentUrl") as string || "/");
  }
}

async function createInvestmentAssetAction(formData: FormData) {
  "use server";

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
    redirect(`/?error=${encodeURIComponent(result.error)}`);
  }

  if (result.ok) {
    redirect(formData.get("currentUrl") as string || "/");
  }
}

async function recordOperationAction(formData: FormData) {
  "use server";

  const fees = parseMoneyMinorField(formData, "fees");

  if (fees === null) {
    redirect(
      `/?error=${encodeURIComponent(
        "No se pudo registrar la operación: revisa unidades, precio y comisiones.",
      )}`,
    );
  }

  const command = parseOperationCommand(
    formData,
    Date.now(),
    new Date().toISOString().slice(0, 10),
  );

  if (!command.assetId) {
    return;
  }

  try {
    withStore((store) => store.recordOperation(command));
  } catch {
    redirect(
      `/?error=${encodeURIComponent(
        "No se pudo registrar la operación: revisa unidades, precio y comisiones.",
      )}`,
    );
  }

  redirect(formData.get("currentUrl") as string || "/");
}

async function updateLiabilityBalanceAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);
  const balance = parseMoneyMinorField(formData, "balance");

  if (!id) {
    return;
  }

  if (balance === null) {
    redirect(`/?error=${encodeURIComponent("El saldo de la deuda no es válido.")}`);
  }

  withStore((store) => store.updateLiabilityBalance(id, balance));
  redirect(formData.get("currentUrl") as string || "/");
}

async function saveFireConfigAction(formData: FormData) {
  "use server";

  const scopeId = parseScopeParam(formData.get("scopeId") as string | undefined);
  const config = parseFireConfigForm(formData);

  withStore((store) => store.saveFireConfig(scopeId, config));
  redirect(formData.get("currentUrl") as string || "/");
}

async function deleteAssetAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    return;
  }

  withStore((store) => store.softDeleteAsset(id, new Date().toISOString()));
  redirect(formData.get("currentUrl") as string || "/");
}

async function deleteLiabilityAction(formData: FormData) {
  "use server";

  const id = parseEntityId(formData);

  if (!id) {
    return;
  }

  withStore((store) => store.softDeleteLiability(id, new Date().toISOString()));
  redirect(formData.get("currentUrl") as string || "/");
}

async function saveSnapshotAction(formData: FormData) {
  "use server";

  const { scopeId, isMonthlyClose, replace } = parseSnapshotForm(formData);
  const saved = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return false;
    }

    const scopes = listScopeOptions(workspace);
    const scope = scopes.find((option) => option.id === scopeId) ?? scopes[0];

    if (!scope) {
      return false;
    }

    const now = new Date().toISOString();
    const snapshot = captureNetWorthSnapshot({
      assets: store.readAssets(),
      capturedAt: now,
      id: buildSnapshotId(scope.id, now, Date.now()),
      isMonthlyClose,
      liabilities: store.readLiabilities(),
      scopeId: scope.id,
      scopeLabel: scope.label,
      workspace,
    });

    store.saveSnapshot({ replace, snapshot });

    return true;
  });

  if (saved) {
    redirect(formData.get("currentUrl") as string || "/");
  }
}

async function refreshPricesAction(formData: FormData) {
  "use server";

  const nowIso = new Date().toISOString();

  await withStore(async (store) => {
    const investmentAssets = store.readInvestmentAssetsWithMeta();

    await Promise.allSettled(
      investmentAssets
        .filter((asset) => Boolean(asset.providerSymbol))
        .map(async (asset) => {
          const price = await fetchAndCachePrice(stooqProvider, {
            assetId: asset.id,
            symbol: asset.providerSymbol!,
            currency: asset.currency,
            nowIso,
          });
          store.upsertPrice(price);
        }),
    );
  });

  redirect(formData.get("currentUrl") as string || "/");
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
