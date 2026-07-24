import { parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { InvestmentCapture } from "@web/patrimonio/anadir/investment-capture";
import {
  addHoldingFieldValue,
  buildSymbolSearchCurrentParams,
  firstNonEmptyParam,
  selectedInstrumentFromAddHoldingState,
} from "@web/patrimonio/anadir/search-state";
import { AddSuccessPanel } from "@web/patrimonio/anadir/success-panel";
import SymbolSearch from "@web/patrimonio/anadir/symbol-search";
import { createHoldingAction } from "@web/patrimonio/create-holding-action";
import { CurrentStateDebtFields } from "@web/patrimonio/current-state-debt-fields";
import { PendingSubmit } from "@web/pending-submit";
import type { Instrument, Member } from "@worthline/domain";
import {
  calculateNetWorth,
  defaultsFor,
  formatMoneyMinorPrivacy,
} from "@worthline/domain";
import type { RegisteredSource } from "@worthline/pricing";
import { fetchPriceNow } from "@worthline/pricing";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

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
    dot: "var(--debit-rule)",
  },
];

/**
 * The 3 behavior groups of «Una inversión» (#597): not the 6 fine instrument
 * labels, but the 3 that price differently. Bolsa maps to `fund` by default (the
 * fine ETF/acción/índice label is editable in the ficha — ADR 0014); the search
 * is scoped to each group's provider, which sidesteps cross-provider noise (#304).
 */
interface InvestmentGroup {
  instrument: Extract<Instrument, "fund" | "pension_plan" | "crypto">;
  label: string;
  hint: string;
  providerLabel: string;
  searchPlaceholder: string;
  symbolLabel: string;
  symbolHint?: string;
}

const INVESTMENT_GROUPS: InvestmentGroup[] = [
  {
    instrument: "fund",
    label: "Cotiza en bolsa",
    hint: "Fondos, ETFs, acciones o índices.",
    providerLabel: "Yahoo Finance",
    searchPlaceholder: "MSCI World, IE00BYX5NX33…",
    symbolLabel: "Símbolo del proveedor",
  },
  {
    instrument: "pension_plan",
    label: "Plan de pensiones",
    hint: "Tu plan, por su código de Finect.",
    providerLabel: "Finect",
    searchPlaceholder: "N5394-Myinvestor",
    symbolLabel: "Código Finect",
  },
  {
    instrument: "crypto",
    label: "Cripto",
    hint: "Bitcoin, Ethereum y otras monedas.",
    providerLabel: "CoinGecko",
    searchPlaceholder: "bitcoin, ethereum…",
    symbolLabel: "Id de CoinGecko",
    symbolHint: "p. ej. «bitcoin»",
  },
];

const REGISTERED_SOURCES: readonly RegisteredSource[] = [
  "yahoo",
  "stooq",
  "coingecko",
  "finect",
];

function isRegisteredSource(value: string | undefined): value is RegisteredSource {
  return value !== undefined && (REGISTERED_SOURCES as readonly string[]).includes(value);
}

/**
 * The picked symbol's live unit price, fetched once when a candidate has been
 * chosen (#597 — «búsqueda devuelve símbolo + precio en vivo»). Returns null when
 * nothing is picked yet or the provider has no quote, so the manual-fallback price
 * field stays empty for the user to fill.
 */
async function fetchPickedSymbolPrice(
  instrument: Instrument,
  pickedSymbol: string | undefined,
): Promise<string | null> {
  const provider = defaultsFor(instrument).priceProvider;

  if (!pickedSymbol || !isRegisteredSource(provider)) {
    return null;
  }

  const fetched = await fetchPriceNow(provider, {
    assetId: "alta-preview",
    currency: "EUR",
    nowIso: new Date().toISOString(),
    symbol: pickedSymbol,
  });

  return fetched?.price ?? null;
}

export default async function AnadirHoldingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const { privacyMode, scopes, selectedScope, store, workspace } = await resolvePageShell(
    { searchParams: resolvedSearchParams },
  );

  // Holdings drive the first-run copy (no holdings yet → warm welcome, #600)
  // and the running net-worth total shown on the success screen's loop.
  const [assets, liabilities] = await Promise.all([
    store.assets.readAssets(),
    store.liabilities.readLiabilities(),
  ]);
  const netWorth = calculateNetWorth({
    assets,
    liabilities,
    scopeId: selectedScope?.id ?? scopes[0]?.id ?? "",
    workspace,
  });

  const activeMembers = workspace.members.filter((m) => !m.disabledAt);
  const currency = workspace.baseCurrency;
  const hasHoldings = assets.length > 0 || liabilities.length > 0;
  const hasPrimaryResidence = assets.some((asset) => asset.isPrimaryResidence);
  const netWorthMinor = netWorth.totalNetWorth.amountMinor;
  const resolvedParams = resolvedSearchParams ?? {};
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;
  const values = formError?.formId === "holding" ? formError.values : {};

  // The drawer (and the investment group) must survive a search/pick navigation,
  // so resolve them from BOTH the preserved error values AND the URL params (#597).
  const selectedDrawer = (values["simpleDrawer"] ??
    firstNonEmptyParam(resolvedParams["simpleDrawer"])) as DrawerId | undefined;
  const selectedInstrument = selectedInstrumentFromAddHoldingState(
    values,
    resolvedParams,
  );

  // A candidate has been picked (or a symbol typed) for the chosen investment
  // group → fetch its live unit price once, to prefill the price field and the
  // «≈ participaciones» hint. Only the investment drawer pays this fetch.
  const pickedSymbol =
    selectedDrawer === "inversion" && selectedInstrument
      ? (firstNonEmptyParam(resolvedParams["pfSymbol"]) ??
        addHoldingFieldValue({
          field: "symbol",
          instrument: selectedInstrument,
          searchParams: resolvedParams,
          selectedInstrument,
          values,
        }))
      : undefined;
  const livePrice =
    selectedDrawer === "inversion" && selectedInstrument
      ? await fetchPickedSymbolPrice(selectedInstrument, pickedSymbol)
      : null;

  // Success-loop state (#600): a completed add returns to the wizard with `ok`
  // (the message) + `added` (the new holding's id). The success panel replaces
  // the form so the user can chain adds; the running net worth is the hook.
  const okKey = firstNonEmptyParam(resolvedParams["ok"]);
  const addedId = firstNonEmptyParam(resolvedParams["added"]);
  const isSuccess = Boolean(formOk);
  const firstRun = !hasHoldings;
  const netWorthLabel = formatMoneyMinorPrivacy(
    { amountMinor: netWorthMinor, currency },
    privacyMode,
  );
  // "Hoy" for the debt drawer's «alta por estado actual» baseline (ADR 0056, #677).
  const today = new Date().toISOString().slice(0, 10);

  const revealCss = [
    `.simpleAdd:has(input[name="simpleDrawer"]:checked) .simpleAddEmpty{display:none}`,
    ...DRAWERS.map(
      (drawer) =>
        `.simpleAdd:has(input[name="simpleDrawer"][value="${drawer.id}"]:checked) .simpleDrawerPane[data-drawer="${drawer.id}"]{display:grid}`,
    ),
    `.simpleAdd:has(input[name="instrument"]:checked) .invGroupEmpty{display:none}`,
    ...INVESTMENT_GROUPS.flatMap((group) => [
      `.simpleAdd:has(input[name="instrument"][value="${group.instrument}"]:checked) .invGroupPane[data-group="${group.instrument}"]{display:grid}`,
      `.invGroupPane[data-group="${group.instrument}"]:has(input[name="invMode_${group.instrument}"][value="saldo"]:checked) .invModePane[data-mode="saldo"]{display:grid}`,
      `.invGroupPane[data-group="${group.instrument}"]:has(input[name="invMode_${group.instrument}"][value="import"]:checked) .invModePane[data-mode="import"]{display:block}`,
    ]),
    // «Alta por estado actual» (ADR 0056, #677): the default path for hipoteca/
    // préstamo; tarjeta (revolving) never gets a plan, so it keeps the plain
    // balance field instead.
    `.simpleDrawerPane[data-drawer="deuda"]:has(input[name="simpleDebtKind"][value="mortgage"]:checked) .debtSimpleBalanceField{display:none}`,
    `.simpleDrawerPane[data-drawer="deuda"]:has(input[name="simpleDebtKind"][value="loan"]:checked) .debtSimpleBalanceField{display:none}`,
    `.simpleDrawerPane[data-drawer="deuda"]:has(input[name="simpleDebtKind"][value="credit_card"]:checked) .debtCurrentStateBlock{display:none}`,
  ].join("\n");

  return (
    <>
      <style>{revealCss}</style>

      <section className="addHoldingPage" aria-label="Añadir al patrimonio">
        {isSuccess ? (
          <AddSuccessPanel
            addedId={addedId}
            isInvestment={okKey === "investment_added"}
            message={formOk!}
            netWorthLabel={netWorthLabel}
          />
        ) : (
          <>
            <div className="panelHeader addHoldingHeader">
              <h2 id="add-holding-title">Añade algo a tu patrimonio</h2>
              <Link href="/patrimonio">← Volver</Link>
            </div>
            <div className="simpleIntro">
              <p className="addHoldingLead">
                {firstRun
                  ? "¡Bienvenido! Empieza por tu primera cosa —una cuenta, una inversión, tu casa— y verás tu patrimonio tomar forma. Solo el nombre y el importe; el resto vive después en la ficha."
                  : "Elige el cajón, apunta el nombre y el importe. El resto vive después en la ficha."}
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
              <div
                className="simpleDrawerGrid"
                role="group"
                aria-label="Qué quieres añadir"
              >
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
                <InvestmentPane
                  livePrice={livePrice}
                  resolvedParams={resolvedParams}
                  selectedInstrument={selectedInstrument}
                  values={values}
                />
                <HousingPane hasPrimaryResidence={hasPrimaryResidence} values={values} />
                <OtherAssetPane values={values} />
                <DebtPane today={today} values={values} />
              </section>

              <OwnershipInputs
                allowCustomSplit={selectedDrawer === "inmueble"}
                members={activeMembers}
                scopeMemberId={ownershipScopeMemberId}
                values={values}
              />
            </form>
          </>
        )}
      </section>
    </>
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

function InvestmentPane({
  livePrice,
  resolvedParams,
  selectedInstrument,
  values,
}: {
  livePrice: string | null;
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedInstrument: Instrument | undefined;
  values: Record<string, string>;
}) {
  return (
    <div className="simpleDrawerPane" data-drawer="inversion">
      <PaneHeader
        title="Una inversión"
        text="Elige dónde está, busca el símbolo y dinos cuánto tienes hoy."
      />
      <fieldset className="simpleChoiceGroup invGroupChoice">
        <legend>¿Dónde está tu inversión?</legend>
        {INVESTMENT_GROUPS.map((group) => (
          <label className="ownerPreset simpleChoice" key={group.instrument}>
            <input
              defaultChecked={selectedInstrument === group.instrument}
              name="instrument"
              type="radio"
              value={group.instrument}
            />
            <span className="invGroupLabel">
              <strong>{group.label}</strong>
              <small>{group.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="invGroupEmpty simpleHint">
        Elige arriba y aparecerá la búsqueda del proveedor que le corresponde.
      </p>

      {INVESTMENT_GROUPS.map((group) => (
        <InvestmentGroupPane
          group={group}
          key={group.instrument}
          livePrice={livePrice}
          resolvedParams={resolvedParams}
          selectedInstrument={selectedInstrument}
          values={values}
        />
      ))}
    </div>
  );
}

function InvestmentGroupPane({
  group,
  livePrice,
  resolvedParams,
  selectedInstrument,
  values,
}: {
  group: InvestmentGroup;
  livePrice: string | null;
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedInstrument: Instrument | undefined;
  values: Record<string, string>;
}) {
  const id = group.instrument;
  const isSelected = selectedInstrument === id;
  const v = (field: string): string | undefined =>
    addHoldingFieldValue({
      field,
      instrument: id,
      searchParams: resolvedParams,
      selectedInstrument,
      values,
    });

  // Live price only applies to the group actually selected; prefill the price
  // field with the user's own entry first (error round-trip), else the live quote.
  const priceValue = v("price") ?? (isSelected && livePrice ? livePrice : "");
  const captureKey = `${id}:${isSelected ? (livePrice ?? "manual") : ""}:${
    (isSelected && v("symbol")) || ""
  }`;

  return (
    <div className="invGroupPane" data-group={id}>
      <SymbolSearch
        basePath="/patrimonio/anadir"
        instrument={id}
        pickedSymbol={
          isSelected && typeof resolvedParams["pfSymbol"] === "string"
            ? resolvedParams["pfSymbol"]
            : undefined
        }
        query={isSelected ? firstNonEmptyParam(resolvedParams["symbolq"]) : undefined}
        currentParams={buildSymbolSearchCurrentParams(resolvedParams, selectedInstrument)}
      />

      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v("name")}
          name={`name_${id}`}
          placeholder="Mi inversión"
        />
      </Field>
      <Field label={group.symbolLabel}>
        <input
          autoComplete="off"
          defaultValue={v("symbol")}
          name={`symbol_${id}`}
          placeholder={group.searchPlaceholder}
        />
      </Field>
      <input name={`isin_${id}`} type="hidden" value={v("isin") ?? ""} />

      <fieldset className="simpleChoiceGroup">
        <legend>¿Cómo lo registramos?</legend>
        <RadioChoice
          checked={v("invMode") !== "import"}
          label="Sé cuánto tengo hoy"
          name={`invMode_${id}`}
          value="saldo"
        />
        <RadioChoice
          checked={v("invMode") === "import"}
          label="Tengo el extracto del bróker"
          name={`invMode_${id}`}
          value="import"
        />
      </fieldset>

      <div className="invModePane" data-mode="saldo">
        <InvestmentCapture
          defaultPrice={priceValue}
          defaultSaldo={v("saldo") ?? ""}
          instrument={id}
          key={captureKey}
          priceHint={
            isSelected && livePrice
              ? `Precio en vivo de ${group.providerLabel}.`
              : group.symbolHint
          }
        />
        <PaneActions />
      </div>

      <div className="invModePane" data-mode="import">
        <p className="simpleHint">
          Crearemos la inversión vacía y te llevamos a <strong>Cargar movimientos</strong>{" "}
          para subir la plantilla de Worthline. Sus operaciones serán el histórico — sin
          ninguna apertura inventada de hoy.
        </p>
        {group.instrument === "fund" ? (
          <p className="simpleHint">
            ¿El extracto de tu bróker trae varios fondos a la vez?{" "}
            <Link href="/patrimonio/importar-extracto">
              Importar extracto de toda la cartera
            </Link>{" "}
            reparte cada ISIN entre lo que ya tienes y lo que falta por crear.
          </p>
        ) : null}
        <PaneActions />
      </div>
    </div>
  );
}

function HousingPane({
  hasPrimaryResidence,
  values,
}: {
  hasPrimaryResidence: boolean;
  values: Record<string, string>;
}) {
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
          defaultChecked={
            v(values, "primaryResidence_inmueble") !== undefined
              ? v(values, "primaryResidence_inmueble") !== "off"
              : !hasPrimaryResidence
          }
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

function DebtPane({ today, values }: { today: string; values: Record<string, string> }) {
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

      {/* Tarjeta: no admite «alta por estado actual» (revolving, sin plan). */}
      <div className="debtSimpleBalanceField">
        <Field label="Saldo pendiente">
          <input
            defaultValue={v(values, "simpleValue_deuda")}
            inputMode="decimal"
            name="simpleValue_deuda"
            placeholder="120.000,00"
          />
        </Field>
      </div>

      {/* Hipoteca/préstamo: «alta por estado actual» (ADR 0056, #677) — el
          camino por defecto para una deuda antigua. Deja «Fecha de fin» en
          blanco para dar de alta solo el saldo y rellenar el plan más tarde. */}
      <div className="debtCurrentStateBlock">
        <p className="simpleHint">
          Recomendado para una deuda antigua: lo que debes hoy, cuándo termina y tu cuota
          o tipo actual.
        </p>
        <CurrentStateDebtFields
          baselineDate={today}
          idPrefix="wizard-deuda"
          initialValues={values}
        />
      </div>

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
  allowCustomSplit,
}: {
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
  /** Custom splits below 100% are only honoured for real estate (#737). */
  allowCustomSplit: boolean;
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

  const preset = allowCustomSplit
    ? values["ownershipPreset"]
    : values["ownershipPreset"] === "custom"
      ? "even"
      : values["ownershipPreset"];

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
      {allowCustomSplit ? (
        <label className="ownerPreset">
          <input
            defaultChecked={preset === "custom"}
            name="ownershipPreset"
            type="radio"
            value="custom"
          />
          Otro reparto…
        </label>
      ) : null}
      {allowCustomSplit ? (
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
          <p className="simpleHint">
            ¿Un inmueble a medias con alguien de fuera? Pon solo vuestra parte; el resto
            se da por suyo. Solo se admite en inmuebles — el dinero y las inversiones
            suman al 100%.
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
