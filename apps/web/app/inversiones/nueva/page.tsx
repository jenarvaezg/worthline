import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import { listScopeOptions } from "@worthline/domain";
import type { Member } from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../intake";
import Shell from "../../shell";
import { createInvestmentAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NuevaInversionPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/inversiones/nueva", resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) return null;

    const scopes = listScopeOptions(workspace);
    const selectedScope =
      scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    return {
      activeMembers: workspace.members.filter((m) => !m.disabledAt),
      scopes,
      selectedScope,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { activeMembers, scopes, selectedScope } = storeData;

  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ??
    activeMembers[0]?.id;

  const investmentValues =
    formError?.formId === "investment" ? formError.values : {};

  return (
    <Shell
      activeSection="inversiones"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      <section className="inversionesSubpage" aria-label="Nueva inversión">
        <div className="panelHeader">
          <h2>Nueva inversión</h2>
          <a href="/inversiones">← Volver</a>
        </div>

        {formOk ? (
          <p className="successBand" role="status">
            {formOk}
          </p>
        ) : null}

        {formError?.formId === "investment" ? (
          <p className="errorBand" role="alert" id="investment-error">
            {formError.message}
          </p>
        ) : null}

        <form action={createInvestmentAction} className="stackForm inversionesForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />

          <label>
            Nombre <span aria-hidden="true">*</span>
            <input
              aria-label="Nombre de la inversión"
              aria-required="true"
              defaultValue={investmentValues["name"]}
              name="name"
              placeholder="Fondo Vanguard, MSCI World ETF…"
              required
            />
          </label>

          <label>
            Ticker / símbolo{" "}
            <small>(formato Stooq, p.ej. VWRL.UK)</small>
            <input
              aria-label="Ticker o símbolo en formato Stooq"
              defaultValue={investmentValues["unitSymbol"]}
              name="unitSymbol"
              placeholder="VWRL.UK"
            />
          </label>

          <label>
            ISIN{" "}
            <small>(opcional)</small>
            <input
              aria-label="ISIN"
              defaultValue={investmentValues["isin"]}
              name="isin"
              placeholder="IE00B3RBWM25"
            />
          </label>

          <label>
            Precio manual por unidad (EUR){" "}
            <small>
              — ¿Valor estático sin cotización?{" "}
              <a href="/patrimonio/nuevo-activo">Activo manual</a>
            </small>
            <input
              aria-label="Precio actual por unidad en EUR"
              defaultValue={investmentValues["manualPricePerUnit"]}
              inputMode="decimal"
              name="manualPricePerUnit"
              placeholder="12,50"
            />
          </label>

          {activeMembers.length > 1 ? (
            <OwnershipInputs
              members={activeMembers}
              scopeMemberId={ownershipScopeMemberId}
              values={investmentValues}
            />
          ) : null}

          <button type="submit">Añadir inversión</button>
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
  scopeMemberId?: string | undefined;
  values?: Record<string, string>;
}) {
  const scopeMember =
    members.find((m) => m.id === scopeMemberId) ?? members[0]!;
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
              defaultValue={
                values[`owner_${member.id}`] ?? (index === 0 ? "100" : "0")
              }
              inputMode="decimal"
              name={`owner_${member.id}`}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
