import type { MoneyMinor } from "@worthline/contracts";
import { createWorthlineStore, runBootstrapHealthcheck } from "@worthline/db";
import {
  buildLiquidityPyramid,
  calculateNetWorth,
  calculateSnapshotDeltas,
  createDashboardShell,
  formatMoneyInput,
  formatMoneyMinor,
  listScopeOptions,
  parseDecimal,
  parseDecimalToMinor,
  presentNetWorth,
  resolveScopeMemberIds,
} from "@worthline/domain";
import type { ManualAsset, Member, NetWorthPresentationMode } from "@worthline/domain";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const presentationModes = [
  { id: "liquid", label: "Liquido" },
  { id: "housing-inclusive", label: "Con vivienda" },
  { id: "gross-debt", label: "Bruto/deuda" },
] as const satisfies Array<{ id: NetWorthPresentationMode; label: string }>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const store = createWorthlineStore();
  const workspace = store.readWorkspace();
  const assets = store.readAssets();
  const liabilities = store.readLiabilities();
  const scopes = workspace ? listScopeOptions(workspace) : [];
  const selectedScopeId = normalizeParam(resolvedSearchParams?.scope) ?? "household";
  const selectedScope = scopes.find((scope) => scope.id === selectedScopeId) ?? scopes[0];
  const selectedView = parsePresentationMode(normalizeParam(resolvedSearchParams?.view));
  const snapshots = selectedScope ? store.readSnapshots(selectedScope.id) : [];
  store.close();

  const summary =
    workspace && selectedScope
      ? calculateNetWorth({
          assets,
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : undefined;
  const presentation = summary ? presentNetWorth(summary, selectedView) : undefined;
  const selectedMemberIds =
    workspace && selectedScope ? resolveScopeMemberIds(workspace, selectedScope.id) : [];
  const pyramid =
    workspace && selectedScope
      ? buildLiquidityPyramid({
          assets,
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : [];
  const latestSnapshot = snapshots.at(-1);
  const deltas = latestSnapshot
    ? calculateSnapshotDeltas(snapshots, latestSnapshot.id)
    : undefined;
  const dashboard = createDashboardShell({
    moduleStates: {
      liquidity: workspace ? "ready" : "empty",
      members: workspace ? "ready" : "empty",
      ownership: assets.length > 0 || liabilities.length > 0 ? "ready" : "empty",
      snapshots: snapshots.length > 0 ? "ready" : "empty",
    },
    persistence,
    ...(summary ? { summary } : {}),
  });
  const activeMembers = workspace?.members.filter((member) => !member.disabledAt) ?? [];

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
              >
                {scope.label}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="metricsGrid">
          {dashboard.metrics.map((metric) => (
            <article className={`metricTile ${metric.posture}`} key={metric.id}>
              <span>{metric.label}</span>
              <strong>{formatMoneyMinor(metric.value)}</strong>
            </article>
          ))}
        </div>
        {deltas ? (
          <div className="deltaStrip" aria-label="Cambios de snapshots">
            <span>
              Snapshot anterior <b>{formatOptionalMoney(deltas.changeSincePrevious)}</b>
            </span>
            <span>
              Cierre mensual <b>{formatOptionalMoney(deltas.changeSinceMonthlyClose)}</b>
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
                      name="id"
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
            <input name="name" placeholder="Nuevo miembro" />
            <button type="submit">Añadir</button>
          </form>
        </section>
      )}

      <div className="mainGrid">
        <section className="ledgerPanel" aria-label="Activos y deudas">
          <div className="panelHeader">
            <h2>Linea operativa</h2>
            <span>{presentation?.label ?? "Bootstrap"}</span>
          </div>
          {selectedScope ? (
            <nav className="viewTabs" aria-label="Modo de neto">
              {presentationModes.map((mode) => (
                <Link
                  className={mode.id === selectedView ? "active" : undefined}
                  href={`/?scope=${encodeURIComponent(selectedScope.id)}&view=${mode.id}`}
                  key={mode.id}
                >
                  {mode.label}
                </Link>
              ))}
            </nav>
          ) : null}
          {presentation ? (
            <div className="presentationReadout">
              <span>{presentation.label}</span>
              <strong>{formatMoneyMinor(presentation.primary)}</strong>
              {presentation.mode === "gross-debt" ? (
                <div>
                  <span>Bruto {formatMoneyMinor(presentation.gross)}</span>
                  <span>Deuda {formatMoneyMinor(presentation.debt)}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="entryGrid">
            <form action={createAssetAction} className="stackForm">
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
              <OwnershipInputs members={activeMembers} />
              <button type="submit">Añadir activo</button>
            </form>

            <form action={createLiabilityAction} className="stackForm">
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
              <OwnershipInputs members={activeMembers} />
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
                </tr>
              ))}
              {liabilities.map((liability) => (
                <tr key={liability.id}>
                  <td>{liability.name}</td>
                  <td>{liability.type}</td>
                  <td>{formatMoneyMinor(liability.currentBalance)}</td>
                  <td>
                    <form action={updateLiabilityBalanceAction} className="rowForm">
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
                </tr>
              ))}
              {assets.length === 0 && liabilities.length === 0 ? (
                <tr>
                  <td colSpan={4}>Sin registros</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section className="liquidityPanel" aria-label="Piramide de liquidez">
          <div className="panelHeader">
            <h2>Liquidez</h2>
            <span>Neto por capa</span>
          </div>
          <div className="pyramid">
            {pyramid.map((tier) => (
              <details className={`tier ${tier.tier}`} key={tier.tier} open>
                <summary>
                  <span>{tierLabel(tier.tier)}</span>
                  <b>{formatMoneyMinor(tier.netValue)}</b>
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
            <div className="historyBar" key={snapshot.id}>
              <span>{snapshot.dateKey}</span>
              <b>{formatMoneyMinor(snapshot.totalNetWorth)}</b>
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

      <footer className="persistenceBar">
        <span>{dashboard.persistence.displayPath}</span>
        <code>{dashboard.persistence.checkKey}</code>
      </footer>
    </main>
  );
}

function OwnershipInputs({ members }: { members: Member[] }) {
  return (
    <fieldset className="ownershipGrid">
      <legend>Ownership %</legend>
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
    </fieldset>
  );
}

async function initializeWorkspaceAction(formData: FormData) {
  "use server";

  const mode = formData.get("mode") === "household" ? "household" : "individual";
  const names = parseNames(formData.get("memberNames"));
  const selectedNames = mode === "individual" ? [names[0] ?? "Yo"] : names;
  const store = createWorthlineStore();

  store.initializeWorkspace({
    members: selectedNames.map((name, index) => ({
      id: createStableId("member", name, index),
      name,
    })),
    mode,
  });
  store.close();
  revalidatePath("/");
  redirect("/?scope=household");
}

async function createMemberAction(formData: FormData) {
  "use server";

  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return;
  }

  const store = createWorthlineStore();
  store.createMember({
    id: createStableId("member", name, Date.now()),
    name,
  });
  store.close();
  revalidatePath("/");
}

async function updateMemberAction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (!id || !name) {
    return;
  }

  const store = createWorthlineStore();
  store.updateMember({ id, name });
  store.close();
  revalidatePath("/");
}

async function disableMemberAction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");

  if (!id) {
    return;
  }

  const store = createWorthlineStore();
  store.disableMember(id, new Date().toISOString());
  store.close();
  revalidatePath("/");
}

async function createAssetAction(formData: FormData) {
  "use server";

  const store = createWorthlineStore();
  const workspace = store.readWorkspace();

  if (!workspace) {
    store.close();
    return;
  }

  const name = String(formData.get("name") ?? "").trim() || "Activo";
  store.createManualAsset({
    currency: "EUR",
    currentValueMinor: parseMoneyToMinor(formData.get("currentValue")),
    id: createStableId("asset", name, Date.now()),
    isPrimaryResidence: formData.get("isPrimaryResidence") === "on",
    liquidityTier: parseLiquidityTier(formData.get("liquidityTier")),
    name,
    ownership: parseOwnership(formData, workspace.members),
    type: parseAssetType(formData.get("type")),
  });
  store.close();
  revalidatePath("/");
}

async function updateAssetValuationAction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");

  if (!id) {
    return;
  }

  const store = createWorthlineStore();
  store.updateAssetValuation(id, parseMoneyToMinor(formData.get("currentValue")));
  store.close();
  revalidatePath("/");
}

async function createLiabilityAction(formData: FormData) {
  "use server";

  const store = createWorthlineStore();
  const workspace = store.readWorkspace();

  if (!workspace) {
    store.close();
    return;
  }

  const name = String(formData.get("name") ?? "").trim() || "Deuda";
  const associatedAssetId = String(formData.get("associatedAssetId") ?? "");
  store.createLiability({
    balanceMinor: parseMoneyToMinor(formData.get("balance")),
    currency: "EUR",
    id: createStableId("debt", name, Date.now()),
    name,
    ownership: parseOwnership(formData, workspace.members),
    type: formData.get("type") === "debt" ? "debt" : "mortgage",
    ...(associatedAssetId ? { associatedAssetId } : {}),
  });
  store.close();
  revalidatePath("/");
}

async function updateLiabilityBalanceAction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");

  if (!id) {
    return;
  }

  const store = createWorthlineStore();
  store.updateLiabilityBalance(id, parseMoneyToMinor(formData.get("balance")));
  store.close();
  revalidatePath("/");
}

async function saveSnapshotAction(formData: FormData) {
  "use server";

  const scopeId = String(formData.get("scopeId") ?? "household");
  const store = createWorthlineStore();
  const workspace = store.readWorkspace();

  if (!workspace) {
    store.close();
    return;
  }

  const scopes = listScopeOptions(workspace);
  const scope = scopes.find((option) => option.id === scopeId) ?? scopes[0];

  if (!scope) {
    store.close();
    return;
  }

  const now = new Date().toISOString();
  const summary = calculateNetWorth({
    assets: store.readAssets(),
    liabilities: store.readLiabilities(),
    scopeId: scope.id,
    workspace,
  });

  store.saveSnapshot({
    capturedAt: now,
    id: createStableId("snapshot", `${scope.id}_${now.slice(0, 10)}`, Date.now()),
    isMonthlyClose: formData.get("isMonthlyClose") === "on",
    replace: formData.get("replace") === "on",
    scopeId: scope.id,
    scopeLabel: scope.label,
    summary,
  });
  store.close();
  revalidatePath("/");
}

function parseNames(value: FormDataEntryValue | null): string[] {
  const names = String(value ?? "")
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter(Boolean);

  return names.length > 0 ? names : ["Yo"];
}

function parseOwnership(formData: FormData, members: Member[]) {
  const activeMembers = members.filter((member) => !member.disabledAt);
  const ownership = activeMembers
    .map((member) => ({
      memberId: member.id,
      shareBps: Math.round(
        parseLocalizedNumber(formData.get(`owner_${member.id}`)) * 100,
      ),
    }))
    .filter((share) => share.shareBps > 0);

  return ownership.length > 0
    ? ownership
    : [{ memberId: activeMembers[0]?.id ?? "", shareBps: 10_000 }];
}

function parseMoneyToMinor(value: FormDataEntryValue | null): number {
  return parseDecimalToMinor(String(value ?? ""));
}

function parseLocalizedNumber(value: FormDataEntryValue | null): number {
  return parseDecimal(String(value ?? ""));
}

function parseAssetType(value: FormDataEntryValue | null): ManualAsset["type"] {
  if (value === "real_estate") {
    return "real_estate";
  }

  if (value === "manual") {
    return "manual";
  }

  return "cash";
}

function parseLiquidityTier(
  value: FormDataEntryValue | null,
): ManualAsset["liquidityTier"] {
  if (
    value === "market" ||
    value === "retirement" ||
    value === "illiquid" ||
    value === "housing"
  ) {
    return value;
  }

  return "cash";
}

function parsePresentationMode(value: string | undefined): NetWorthPresentationMode {
  if (value === "housing-inclusive" || value === "gross-debt") {
    return value;
  }

  return "liquid";
}

function createStableId(prefix: string, name: string, index: number): string {
  const slug =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || prefix;

  return `${prefix}_${slug}_${index}`;
}

function normalizeParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function formatOptionalMoney(value: MoneyMinor | undefined): string {
  return value ? formatMoneyMinor(value) : "sin dato";
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
