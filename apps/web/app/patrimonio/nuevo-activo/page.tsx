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
import { createAssetAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NuevoActivoPage({
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
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { activeMembers, scopes, selectedScope } = storeData;

  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  const values = formError?.formId === "asset" ? formError.values : {};

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl="/patrimonio/nuevo-activo"
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

      <section className="formPage" aria-label="Nuevo activo">
        <div className="panelHeader">
          <h2>Nuevo activo</h2>
          <Link href="/patrimonio">← Volver</Link>
        </div>

        <p className="formPageNote">
          <strong>¿El activo cotiza con ticker?</strong>{" "}
          <Link href="/inversiones">Regístralo como Inversión →</Link> para que su valor
          se derive automáticamente del precio de mercado.
        </p>

        {formError ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        <form action={createAssetAction} className="stackForm">
          <input name="currentUrl" type="hidden" value="/patrimonio/nuevo-activo" />

          <label>
            Nombre
            <input
              aria-label="Nombre del activo"
              autoFocus
              defaultValue={values["name"]}
              name="name"
              placeholder="p.ej. Cuenta corriente BBVA"
            />
          </label>

          <label>
            Tipo
            <select defaultValue={values["type"] ?? "cash"} name="type">
              <option value="cash">Cash (efectivo, cuenta corriente)</option>
              <option value="manual">Manual (cualquier activo con valor manual)</option>
              <option value="real_estate">Inmueble</option>
            </select>
          </label>

          <label>
            Capa de liquidez
            <details className="tierHelp">
              <summary>¿Qué es la capa de liquidez?</summary>
              <dl>
                <dt>Caja</dt>
                <dd>
                  Efectivo, cuentas corrientes y de ahorro. Disponible de inmediato.
                </dd>
                <dt>Mercado</dt>
                <dd>Acciones, fondos, ETFs y similares. Liquidable en días.</dd>
                <dt>Jubilación</dt>
                <dd>Planes de pensiones y activos con restricciones de retirada.</dd>
                <dt>Ilíquido</dt>
                <dd>
                  Arte, vehículos, participaciones privadas. Difícil de vender rápido.
                </dd>
                <dt>Vivienda</dt>
                <dd>Inmuebles residenciales. Incluye vivienda habitual.</dd>
              </dl>
            </details>
            <select defaultValue={values["liquidityTier"] ?? "cash"} name="liquidityTier">
              <option value="cash">Caja</option>
              <option value="market">Mercado</option>
              <option value="term-locked">A plazo</option>
              <option value="illiquid">Ilíquido</option>
            </select>
          </label>

          <label>
            Valor actual (EUR)
            <input
              aria-label="Valor actual en EUR"
              defaultValue={values["currentValue"]}
              inputMode="decimal"
              name="currentValue"
              placeholder="p.ej. 12500,00"
            />
            <small>Para inmuebles se usa el precio de adquisición como valor base.</small>
          </label>

          <label className="checkLine">
            <input
              defaultChecked={values["isPrimaryResidence"] === "on"}
              name="isPrimaryResidence"
              type="checkbox"
            />{" "}
            Vivienda habitual
          </label>

          <fieldset className="ownershipGrid">
            <legend>Datos de inmueble</legend>
            <p className="infoNote">
              Si el tipo es Inmueble, la fecha y el precio de adquisición crean la primera
              tasación de mercado y sustituyen al valor actual como base inicial.
            </p>
            <label>
              Fecha de adquisición
              <input
                aria-label="Fecha de adquisición"
                defaultValue={values["acquisitionDate"]}
                max={new Date().toISOString().slice(0, 10)}
                name="acquisitionDate"
                type="date"
              />
            </label>
            <label>
              Precio de adquisición (EUR)
              <input
                aria-label="Precio de adquisición en EUR"
                defaultValue={values["acquisitionValue"]}
                inputMode="decimal"
                name="acquisitionValue"
                placeholder="p.ej. 180.000,00"
              />
            </label>
            <label>
              Tasa de revalorización anual (%)
              <input
                aria-label="Tasa de revalorización anual (%)"
                defaultValue={values["rate"]}
                inputMode="decimal"
                name="rate"
                placeholder="3"
              />
              <small>
                Déjalo en blanco para no aplicar revalorización entre tasaciones.
              </small>
            </label>
            <details className="valuationDetails">
              <summary>Añadir tasación inicial</summary>
              <div className="ownerCustom">
                <label>
                  Fecha de la tasación
                  <input
                    aria-label="Fecha de la tasación"
                    defaultValue={values["initialValuationDate"]}
                    max={new Date().toISOString().slice(0, 10)}
                    name="initialValuationDate"
                    type="date"
                  />
                </label>
                <label>
                  Valor de la tasación (EUR)
                  <input
                    aria-label="Valor de la tasación en EUR"
                    defaultValue={values["initialValuationValue"]}
                    inputMode="decimal"
                    name="initialValuationValue"
                    placeholder="p.ej. 210.000,00"
                  />
                </label>
                <label className="checkLine">
                  <input
                    defaultChecked={values["initialAdjustsPriorCurve"] === "on"}
                    name="initialAdjustsPriorCurve"
                    type="checkbox"
                  />{" "}
                  Es una tasación de mercado
                </label>
                <p className="infoNote">
                  <strong>Tasación de mercado:</strong> una valoración real del inmueble
                  que recalibra toda la curva previa. <strong>Mejora:</strong> una
                  inversión que se suma al valor existente sin reemplazar las tasaciones
                  anteriores.
                </p>
              </div>
            </details>
          </fieldset>

          <OwnershipInputs
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={values}
          />

          <div className="formActions">
            <button type="submit">Añadir activo</button>
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
  if (members.length === 0) {
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
      {members.length > 1 ? (
        <label className="ownerPreset">
          <input
            defaultChecked={preset === "even"}
            name="ownershipPreset"
            type="radio"
            value="even"
          />
          Repartir a partes iguales
        </label>
      ) : null}
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
