import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import { listScopeOptions } from "@worthline/domain";
import type { Member } from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../intake";
import Shell from "../../shell";
import { createLiabilityAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NuevaDeudaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
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

    return {
      activeMembers: workspace.members.filter((m) => !m.disabledAt),
      assets: store.assets.readAssets().filter((a) => a.type !== "investment"),
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { activeMembers, assets, scopes, selectedScope } = storeData;

  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  const values = formError?.formId === "liability" ? formError.values : {};

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl="/patrimonio/nueva-deuda"
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

      <section className="formPage" aria-label="Nueva deuda">
        <div className="panelHeader">
          <h2>Nueva deuda</h2>
          <Link href="/patrimonio">← Volver</Link>
        </div>

        {formError ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        <form action={createLiabilityAction} className="stackForm">
          <input name="currentUrl" type="hidden" value="/patrimonio/nueva-deuda" />

          <label>
            Nombre
            <input
              aria-label="Nombre de la deuda"
              autoFocus
              defaultValue={values["name"]}
              name="name"
              placeholder="p.ej. Hipoteca Santander"
            />
          </label>

          <label>
            Tipo
            <select defaultValue={values["type"] ?? "mortgage"} name="type">
              <option value="mortgage">Hipoteca</option>
              <option value="debt">Deuda</option>
            </select>
          </label>

          <label>
            Saldo pendiente (EUR)
            <input
              aria-label="Saldo pendiente en EUR"
              defaultValue={values["balance"]}
              inputMode="decimal"
              name="balance"
              placeholder="p.ej. 120000,00"
            />
            <small>Usa coma como separador decimal: 120.000,00</small>
          </label>

          <label>
            Activo asociado (opcional)
            <select
              defaultValue={values["associatedAssetId"] ?? ""}
              name="associatedAssetId"
            >
              <option value="">Sin activo asociado</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          </label>

          <OwnershipInputs
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={values}
          />

          <div className="formActions">
            <button type="submit">Añadir deuda</button>
            <Link href="/patrimonio">Cancelar</Link>
          </div>
        </form>
      </section>
    </Shell>
  );
}

function OwnershipInputs({
  members,
  scopeMemberId,
  values = {},
}: {
  members: Member[];
  scopeMemberId: string | undefined;
  values?: Record<string, string>;
}) {
  if (members.length <= 1) {
    return null;
  }

  const scopeMember = members.find((m) => m.id === scopeMemberId) ?? members[0]!;
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
      <details className="ownerCustomDetails">
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
          {members.map((member, index) => (
            <label key={member.id}>
              {member.name}
              <input
                defaultValue={values[`owner_${member.id}`] ?? (index === 0 ? "100" : "0")}
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
