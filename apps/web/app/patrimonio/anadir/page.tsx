import { bootstrapHealthcheck, withStore } from "@web/store";
import { listScopeOptions } from "@worthline/domain";
import type { Member } from "@worthline/domain";
import type { CSSProperties, ReactNode } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { createHoldingAction } from "@web/patrimonio/create-holding-action";
import { PendingSubmit } from "@web/pending-submit";
import Shell from "@web/shell";

export const dynamic = "force-dynamic";

type DrawerId = "dinero" | "inversion" | "inmueble" | "bien" | "deuda";

interface Drawer {
  id: DrawerId;
  label: string;
  hint: string;
  dot: string;
}

const DRAWERS: Drawer[] = [
  {
    id: "dinero",
    label: "Dinero",
    hint: "Cuentas, efectivo o un depósito a plazo.",
    dot: "var(--tier-cash)",
  },
  {
    id: "inversion",
    label: "Una inversión",
    hint: "Fondos, acciones, planes o cripto.",
    dot: "var(--tier-market)",
  },
  {
    id: "inmueble",
    label: "Un inmueble",
    hint: "Tu casa, un piso o un local.",
    dot: "var(--tier-housing)",
  },
  {
    id: "bien",
    label: "Otro bien",
    hint: "Coche, oro u otro objeto de valor.",
    dot: "var(--tier-illiquid)",
  },
  {
    id: "deuda",
    label: "Una deuda",
    hint: "Hipoteca, préstamo o tarjeta.",
    dot: "var(--red)",
  },
];

export default async function AnadirHoldingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = await bootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

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
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;
  const values = formError?.formId === "holding" ? formError.values : {};
  const selectedDrawer = values["simpleDrawer"] as DrawerId | undefined;
  const revealCss = [
    `.simpleAdd:has(input[name="simpleDrawer"]:checked) .simpleAddEmpty{display:none}`,
    ...DRAWERS.map(
      (drawer) =>
        `.simpleAdd:has(input[name="simpleDrawer"][value="${drawer.id}"]:checked) .simpleDrawerPane[data-drawer="${drawer.id}"]{display:grid}`,
    ),
  ].join("\n");

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl="/patrimonio/anadir"
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      <style>{revealCss}</style>

      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="addHoldingPage" aria-labelledby="add-holding-title">
        <div className="panelHeader addHoldingHeader">
          <h2 id="add-holding-title">Añade algo a tu patrimonio</h2>
          <Link href="/patrimonio">← Volver</Link>
        </div>
        <div className="simpleIntro">
          <p className="addHoldingLead">
            Elige el cajón, apunta el nombre y el importe. El resto vive después en la
            ficha.
          </p>
          <Link className="actionLink" href="/patrimonio/anadir/avanzado">
            Modo avanzado
          </Link>
        </div>

        {formError?.formId === "holding" ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        <form action={createHoldingAction} className="simpleAdd">
          <div className="simpleDrawerGrid" role="group" aria-label="Qué quieres añadir">
            {DRAWERS.map((drawer) => (
              <label
                className="simpleDrawerCard"
                key={drawer.id}
                style={{ "--dot": drawer.dot } as CSSProperties}
              >
                <input
                  defaultChecked={selectedDrawer === drawer.id}
                  name="simpleDrawer"
                  type="radio"
                  value={drawer.id}
                />
                <span className="addHoldingDot" aria-hidden="true" />
                <span className="simpleDrawerCopy">
                  <strong>{drawer.label}</strong>
                  <small>{drawer.hint}</small>
                </span>
              </label>
            ))}
          </div>

          <section className="simpleAddPanes" aria-live="polite">
            <p className="simpleAddEmpty">
              Elige arriba qué quieres apuntar y aquí aparecerá lo justo que hay que
              rellenar.
            </p>
            <MoneyPane values={values} />
            <InvestmentPane />
            <HousingPane values={values} />
            <OtherAssetPane values={values} />
            <DebtPane values={values} />
          </section>

          <OwnershipInputs
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={values}
          />
        </form>
      </section>
    </Shell>
  );
}

function v(values: Record<string, string>, key: string): string | undefined {
  return values[key];
}

function PaneActions() {
  return (
    <div className="formActions simplePaneActions">
      <PendingSubmit pendingLabel="Añadiendo…">Añadir</PendingSubmit>
      <Link href="/patrimonio">Cancelar</Link>
    </div>
  );
}

function MoneyPane({ values }: { values: Record<string, string> }) {
  return (
    <div className="simpleDrawerPane" data-drawer="dinero">
      <PaneHeader title="Dinero" text="Cuenta corriente, efectivo o depósito a plazo." />
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_dinero")}
          name="simpleName_dinero"
          placeholder="Cuenta del banco"
        />
      </Field>
      <Field label="Importe actual">
        <input
          defaultValue={v(values, "simpleValue_dinero")}
          inputMode="decimal"
          name="simpleValue_dinero"
          placeholder="2.500,00"
        />
      </Field>
      <label className="simpleInlineCheck">
        <input
          defaultChecked={v(values, "cashTerm_dinero") === "on"}
          name="cashTerm_dinero"
          type="checkbox"
        />
        <span>A plazo fijo</span>
      </label>
      <PaneActions />
    </div>
  );
}

function InvestmentPane() {
  return (
    <div className="simpleDrawerPane" data-drawer="inversion">
      <div className="simpleNotice">
        <h3>Inversión va al modo avanzado</h3>
        <p>
          Fondos, acciones, planes y cripto necesitan símbolo o proveedor. Esa búsqueda
          sigue en la pantalla completa.
        </p>
        <Link className="actionLink" href="/patrimonio/anadir/avanzado">
          Ir al modo avanzado
        </Link>
      </div>
    </div>
  );
}

function HousingPane({ values }: { values: Record<string, string> }) {
  return (
    <div className="simpleDrawerPane" data-drawer="inmueble">
      <PaneHeader
        title="Inmueble"
        text="Valor actual y si cuenta como vivienda habitual."
      />
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_inmueble")}
          name="simpleName_inmueble"
          placeholder="Mi casa"
        />
      </Field>
      <Field label="Valor actual">
        <input
          defaultValue={v(values, "simpleValue_inmueble")}
          inputMode="decimal"
          name="simpleValue_inmueble"
          placeholder="300.000,00"
        />
      </Field>
      <label className="simpleInlineCheck">
        <input
          defaultChecked={v(values, "primaryResidence_inmueble") !== "off"}
          name="primaryResidence_inmueble"
          type="checkbox"
        />
        <input name="primaryResidence_inmueble" type="hidden" value="off" />
        <span>Vivienda habitual</span>
      </label>
      <p className="simpleHint">
        Compra, tasaciones y ritmo de revalorización van luego en su ficha.
      </p>
      <PaneActions />
    </div>
  );
}

function OtherAssetPane({ values }: { values: Record<string, string> }) {
  const selected = v(values, "simpleAssetKind") ?? "other";

  return (
    <div className="simpleDrawerPane" data-drawer="bien">
      <PaneHeader title="Otro bien" text="Coche, oro u otro activo mantenido a mano." />
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_bien")}
          name="simpleName_bien"
          placeholder="Renault Clio"
        />
      </Field>
      <Field label="Importe actual">
        <input
          defaultValue={v(values, "simpleValue_bien")}
          inputMode="decimal"
          name="simpleValue_bien"
          placeholder="8.500,00"
        />
      </Field>
      <fieldset className="simpleChoiceGroup">
        <legend>Tipo (opcional)</legend>
        <RadioChoice
          checked={selected === "vehicle"}
          label="Coche"
          name="simpleAssetKind"
          value="vehicle"
        />
        <RadioChoice
          checked={selected === "precious_metal"}
          label="Oro"
          name="simpleAssetKind"
          value="precious_metal"
        />
        <RadioChoice
          checked={selected === "other"}
          label="Otro"
          name="simpleAssetKind"
          value="other"
        />
      </fieldset>
      <PaneActions />
    </div>
  );
}

function DebtPane({ values }: { values: Record<string, string> }) {
  const selected = v(values, "simpleDebtKind") ?? "mortgage";

  return (
    <div className="simpleDrawerPane" data-drawer="deuda">
      <PaneHeader title="Deuda" text="Saldo pendiente y tipo de obligación." />
      <fieldset className="simpleChoiceGroup">
        <legend>Tipo de deuda</legend>
        <RadioChoice
          checked={selected === "mortgage"}
          label="Hipoteca"
          name="simpleDebtKind"
          value="mortgage"
        />
        <RadioChoice
          checked={selected === "loan"}
          label="Préstamo"
          name="simpleDebtKind"
          value="loan"
        />
        <RadioChoice
          checked={selected === "credit_card"}
          label="Tarjeta"
          name="simpleDebtKind"
          value="credit_card"
        />
      </fieldset>
      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v(values, "simpleName_deuda")}
          name="simpleName_deuda"
          placeholder="Hipoteca de casa"
        />
      </Field>
      <Field label="Saldo pendiente">
        <input
          defaultValue={v(values, "simpleValue_deuda")}
          inputMode="decimal"
          name="simpleValue_deuda"
          placeholder="120.000,00"
        />
      </Field>
      <p className="simpleHint">
        Vincularla a un inmueble y el cuadro de pagos se añaden luego en su ficha.
      </p>
      <PaneActions />
    </div>
  );
}

function PaneHeader({ text, title }: { text: string; title: string }) {
  return (
    <div className="simplePaneIntro">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="simpleField">
      <span>{label}</span>
      {children}
    </label>
  );
}

function RadioChoice({
  checked,
  label,
  name,
  value,
}: {
  checked: boolean;
  label: string;
  name: string;
  value: string;
}) {
  return (
    <label className="ownerPreset simpleChoice">
      <input defaultChecked={checked} name={name} type="radio" value={value} />
      {label}
    </label>
  );
}

function OwnershipInputs({
  members,
  scopeMemberId,
  values,
}: {
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
}) {
  const scopeMember = members.find((m) => m.id === scopeMemberId) ?? members[0];

  if (!scopeMember) {
    return null;
  }

  if (members.length <= 1) {
    return (
      <>
        <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
        <input name="ownershipPreset" type="hidden" value="scope" />
      </>
    );
  }

  const preset = values["ownershipPreset"];

  return (
    <fieldset className="ownershipGrid simpleOwnership">
      <legend>Reparto</legend>
      <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "scope"}
          name="ownershipPreset"
          type="radio"
          value="scope"
        />
        Solo mío
      </label>
      <label className="ownerPreset">
        <input
          defaultChecked={!preset || preset === "even"}
          name="ownershipPreset"
          type="radio"
          value="even"
        />
        De los dos (mitad y mitad)
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
            Otro reparto…
          </label>
        </summary>
        <div className="ownerCustom">
          {members.map((member, index) => (
            <label key={member.id}>
              {member.name}
              <input
                aria-label={`Porcentaje de ${member.name}`}
                defaultValue={values[`owner_${member.id}`] ?? (index === 0 ? "50" : "50")}
                inputMode="decimal"
                name={`owner_${member.id}`}
              />
            </label>
          ))}
        </div>
      </details>
    </fieldset>
  );
}
