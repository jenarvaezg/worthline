import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  collectWarnings,
  formatMoneyInput,
  formatMoneyMinor,
  listScopeOptions,
} from "@worthline/domain";
import type { Liability, ManualAsset, Member } from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../../intake";
import Shell from "../../../shell";
import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
  editAssetAction,
  updateAssetValuationAction,
  updateLiabilityBalanceAction,
} from "../../actions";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export default async function EditarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    const assets = store.assets.readAssets();
    const liabilities = store.liabilities.readLiabilities();
    const overrides = store.readWarningOverrides();

    const asset = assets.find((a) => a.id === id) ?? null;
    const liability = liabilities.find((l) => l.id === id) ?? null;

    return {
      activeMembers: workspace.members.filter((m) => !m.disabledAt),
      asset,
      assets: assets.filter((a) => a.type !== "investment"),
      liability,
      overrides,
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { activeMembers, asset, assets, liability, overrides, scopes, selectedScope } =
    storeData;

  if (!asset && !liability) {
    notFound();
  }

  const warnings = asset ? collectWarnings([asset], overrides) : [];
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={`/patrimonio/${id}/editar`}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="formPage" aria-label="Editar holding">
        <div className="panelHeader">
          <h2>Editar {asset ? "activo" : "deuda"}</h2>
          <Link href={`/patrimonio#${id}`}>← Volver</Link>
        </div>

        {/* Active warnings for this holding */}
        {warnings.length > 0 ? (
          <div className="warningBand" role="alert" aria-label="Avisos">
            {warnings.map((w) => (
              <div className="warningItem" key={`${w.entityId}-${w.code}`}>
                <span>⚠ {w.message}</span>
                {w.severity === "overrideable" ? (
                  <form action={acknowledgeWarningAction}>
                    <input
                      name="currentUrl"
                      type="hidden"
                      value={`/patrimonio/${id}/editar`}
                    />
                    <input name="code" type="hidden" value={w.code} />
                    <input name="entityId" type="hidden" value={id} />
                    <button className="btnSmall btnWarning" type="submit">
                      Es intencional
                    </button>
                  </form>
                ) : (
                  <span className="blockingNote">No se puede ignorar</span>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {formError ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        {asset ? (
          <AssetEditForm
            asset={asset}
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={formError?.formId === "edit" ? formError.values : {}}
          />
        ) : liability ? (
          <LiabilityEditForm
            assets={assets}
            liability={liability}
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={formError?.formId === "edit" ? formError.values : {}}
          />
        ) : null}

        {/* Danger zone — two-step delete */}
        <div className="dangerZone">
          <h3>Zona de peligro</h3>
          {asset ? (
            <form action={deleteAssetAction}>
              <input name="currentUrl" type="hidden" value={`/patrimonio/${id}/editar`} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar activo</summary>
                <p>El activo se moverá a la Papelera y podrás recuperarlo.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          ) : (
            <form action={deleteLiabilityAction}>
              <input name="currentUrl" type="hidden" value={`/patrimonio/${id}/editar`} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar deuda</summary>
                <p>La deuda se moverá a la Papelera y podrás recuperarla.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          )}
        </div>
      </section>
    </Shell>
  );
}

function AssetEditForm({
  asset,
  members,
  scopeMemberId,
  values,
}: {
  asset: ManualAsset;
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
}) {
  const isInvestment = asset.type === "investment";

  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={`/patrimonio/${asset.id}/editar`} />
        <input name="id" type="hidden" value={asset.id} />
        <input name="scopeMemberId" type="hidden" value={scopeMemberId ?? ""} />

        <label>
          Nombre
          <input
            aria-label="Nombre del activo"
            defaultValue={values["name"] ?? asset.name}
            name="name"
            disabled={isInvestment}
          />
        </label>

        {isInvestment ? (
          <p className="infoNote">
            Este activo es una inversión gestionada en{" "}
            <Link href={`/inversiones/${asset.id}`}>Inversiones</Link>. Su nombre y capa
            se editan allí.
          </p>
        ) : (
          <>
            <label>
              Tipo
              <select defaultValue={values["type"] ?? asset.type} name="type">
                <option value="cash">Cash</option>
                <option value="manual">Manual</option>
                <option value="real_estate">Inmueble</option>
              </select>
            </label>

            <label>
              Capa de liquidez
              <select
                defaultValue={values["liquidityTier"] ?? asset.liquidityTier}
                name="liquidityTier"
              >
                <option value="cash">Caja</option>
                <option value="market">Mercado</option>
                <option value="retirement">Jubilación</option>
                <option value="illiquid">Ilíquido</option>
                <option value="housing">Vivienda</option>
              </select>
            </label>

            <label className="checkLine">
              <input
                defaultChecked={
                  values["isPrimaryResidence"]
                    ? values["isPrimaryResidence"] === "on"
                    : asset.isPrimaryResidence
                }
                name="isPrimaryResidence"
                type="checkbox"
              />{" "}
              Vivienda habitual
            </label>

            <OwnershipInputs
              members={members}
              scopeMemberId={scopeMemberId}
              currentOwnership={asset.ownership}
              values={values}
            />
          </>
        )}

        {!isInvestment ? (
          <div className="formActions">
            <button type="submit">Guardar cambios</button>
            <Link href={`/patrimonio#${asset.id}`}>Cancelar</Link>
          </div>
        ) : null}
      </form>

      {!isInvestment ? (
        <form action={updateAssetValuationAction} className="stackForm updateValueForm">
          <input
            name="currentUrl"
            type="hidden"
            value={`/patrimonio/${asset.id}/editar`}
          />
          <input name="id" type="hidden" value={asset.id} />
          <label>
            Valor actual (EUR)
            <input
              aria-label="Valor actual en EUR"
              defaultValue={formatMoneyInput(asset.currentValue.amountMinor)}
              inputMode="decimal"
              name="currentValue"
            />
          </label>
          <button type="submit">Actualizar valor</button>
        </form>
      ) : (
        <p className="infoNote">
          Valor actual: {formatMoneyMinor(asset.currentValue)} — derivado de las
          posiciones.
        </p>
      )}
    </>
  );
}

function LiabilityEditForm({
  assets,
  liability,
  members,
  scopeMemberId,
  values,
}: {
  assets: ManualAsset[];
  liability: Liability;
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
}) {
  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input
          name="currentUrl"
          type="hidden"
          value={`/patrimonio/${liability.id}/editar`}
        />
        <input name="id" type="hidden" value={liability.id} />
        <input name="scopeMemberId" type="hidden" value={scopeMemberId ?? ""} />
        <input name="isLiability" type="hidden" value="true" />

        <label>
          Nombre
          <input
            aria-label="Nombre de la deuda"
            defaultValue={values["name"] ?? liability.name}
            name="name"
          />
        </label>

        <label>
          Tipo
          <select defaultValue={values["type"] ?? liability.type} name="type">
            <option value="mortgage">Hipoteca</option>
            <option value="debt">Deuda</option>
          </select>
        </label>

        <label>
          Activo asociado (opcional)
          <select
            defaultValue={
              values["associatedAssetId"] ?? liability.associatedAssetId ?? ""
            }
            name="associatedAssetId"
          >
            <option value="">Sin activo asociado</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <OwnershipInputs
          members={members}
          scopeMemberId={scopeMemberId}
          currentOwnership={liability.ownership}
          values={values}
        />

        <div className="formActions">
          <button type="submit">Guardar cambios</button>
          <Link href={`/patrimonio#${liability.id}`}>Cancelar</Link>
        </div>
      </form>

      <form action={updateLiabilityBalanceAction} className="stackForm updateValueForm">
        <input
          name="currentUrl"
          type="hidden"
          value={`/patrimonio/${liability.id}/editar`}
        />
        <input name="id" type="hidden" value={liability.id} />
        <label>
          Saldo pendiente (EUR)
          <input
            aria-label="Saldo pendiente en EUR"
            defaultValue={formatMoneyInput(liability.currentBalance.amountMinor)}
            inputMode="decimal"
            name="balance"
          />
        </label>
        <button type="submit">Actualizar saldo</button>
      </form>
    </>
  );
}

function OwnershipInputs({
  members,
  scopeMemberId,
  currentOwnership,
  values = {},
}: {
  members: Member[];
  scopeMemberId: string | undefined;
  currentOwnership: Array<{ memberId: string; shareBps: number }>;
  values?: Record<string, string>;
}) {
  if (members.length <= 1) {
    return null;
  }

  const scopeMember = members.find((m) => m.id === scopeMemberId) ?? members[0]!;
  const preset = values["ownershipPreset"] ?? "custom";

  const currentBpsFor = (memberId: string): string => {
    const share = currentOwnership.find((s) => s.memberId === memberId);
    return share ? String(Math.round(share.shareBps / 100)) : "0";
  };

  return (
    <fieldset className="ownershipGrid">
      <legend>Propiedad</legend>
      <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "scope"}
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
      <details className="ownerCustomDetails" open={preset === "custom"}>
        <summary>
          <label className="ownerPreset" style={{ display: "inline" }}>
            <input
              defaultChecked={preset === "custom"}
              name="ownershipPreset"
              type="radio"
              value="custom"
            />
            Personalizado
          </label>
        </summary>
        <div className="ownerCustom">
          {members.map((member) => (
            <label key={member.id}>
              {member.name}
              <input
                defaultValue={values[`owner_${member.id}`] ?? currentBpsFor(member.id)}
                inputMode="decimal"
                name={`owner_${member.id}`}
                aria-label={`Porcentaje de ${member.name}`}
              />
            </label>
          ))}
        </div>
      </details>
    </fieldset>
  );
}
