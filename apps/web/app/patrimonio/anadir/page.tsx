import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import { defaultsFor, listScopeOptions } from "@worthline/domain";
import type {
  Instrument,
  LiquidityTier,
  Member,
  ValuationMethod,
} from "@worthline/domain";
import { cookies } from "next/headers";
import type { CSSProperties } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../../intake";
import Shell from "../../shell";
import { createHoldingAction } from "../create-holding-action";
import {
  addHoldingFieldValue,
  buildSymbolSearchCurrentParams,
  firstNonEmptyParam,
  selectedInstrumentFromAddHoldingState,
} from "./search-state";
import SymbolSearch from "./symbol-search";

export const dynamic = "force-dynamic";

interface InstrumentEntry {
  id: Instrument;
  label: string;
  hint: string;
}

interface Family {
  key: string;
  label: string;
  instruments: InstrumentEntry[];
}

/** The instrument gallery, grouped by family (PRD #146 S5, Variant D). */
const FAMILIES: Family[] = [
  {
    key: "liquido",
    label: "Líquido",
    instruments: [
      { id: "current_account", label: "Cuenta corriente", hint: "Efectivo disponible" },
      { id: "term_deposit", label: "Depósito a plazo", hint: "Bloqueado un tiempo" },
    ],
  },
  {
    key: "inversion",
    label: "Inversión",
    instruments: [
      { id: "fund", label: "Fondo", hint: "Cotiza · Yahoo" },
      { id: "etf", label: "ETF", hint: "Cotiza · Yahoo" },
      { id: "stock", label: "Acción", hint: "Cotiza · Yahoo" },
      { id: "index", label: "Índice", hint: "Cotiza · Yahoo" },
      { id: "pension_plan", label: "Plan de pensiones", hint: "Cotiza · Finect" },
      { id: "crypto", label: "Cripto", hint: "Cotiza · CoinGecko" },
    ],
  },
  {
    key: "bienes",
    label: "Bienes",
    instruments: [
      { id: "property", label: "Inmueble", hint: "Revalorización + tasaciones" },
      { id: "vehicle", label: "Vehículo", hint: "Valor manual" },
      { id: "precious_metal", label: "Metal precioso", hint: "Valor manual" },
      { id: "other", label: "Otro", hint: "Cualquier valor manual" },
    ],
  },
  {
    key: "deuda",
    label: "Deuda",
    instruments: [
      { id: "mortgage", label: "Hipoteca", hint: "Amortización francesa" },
      { id: "loan", label: "Préstamo", hint: "Amortizable o informal" },
      { id: "credit_card", label: "Tarjeta de crédito", hint: "Saldos declarados" },
    ],
  },
];

const ALL_INSTRUMENTS: InstrumentEntry[] = FAMILIES.flatMap((f) => f.instruments);

const LIABILITY_INSTRUMENTS = new Set<Instrument>(["mortgage", "loan", "credit_card"]);

const RUNG_LABEL: Record<LiquidityTier, string> = {
  cash: "Caja",
  market: "Mercado",
  "term-locked": "A plazo",
  illiquid: "Ilíquido",
  // Type-completeness only: housing is instrument-derived (a `property` instrument
  // resolves to the housing rung via defaultsFor), never a manual rung pick.
  housing: "Vivienda",
};

const METHOD_LABEL: Record<ValuationMethod, string> = {
  stored: "Manual — lo actualizas tú",
  derived: "Calculado — unidades × precio",
  appreciating: "Revalorización + tasaciones",
  amortized: "Amortización francesa",
  anchored: "Saldos declarados",
};

const PROVIDER_LABEL: Record<string, string> = {
  yahoo: "Yahoo Finance",
  stooq: "Stooq",
  finect: "Finect",
  coingecko: "CoinGecko",
};

interface Placeholders {
  name: string;
  value?: string;
  symbol?: string;
  price?: string;
  acqValue?: string;
  rate?: string;
  balance?: string;
}

const PLACEHOLDERS: Record<Instrument, Placeholders> = {
  current_account: { name: "Cuenta corriente BBVA", value: "2.500,00" },
  term_deposit: { name: "Depósito 12 meses Openbank", value: "10.000,00" },
  fund: { name: "Vanguard Global Stock Index", symbol: "VANGTLI", price: "215,40" },
  etf: { name: "iShares Core MSCI World", symbol: "EUNL.DE", price: "92,15" },
  stock: { name: "Apple", symbol: "AAPL", price: "180,50" },
  index: { name: "S&P 500", symbol: "^GSPC", price: "5.200,00" },
  pension_plan: { name: "Indexa Más Rentabilidad", symbol: "N5394", price: "12,80" },
  crypto: { name: "Bitcoin", symbol: "bitcoin", price: "58.000,00" },
  property: { name: "Piso en Malasaña", acqValue: "180.000,00", rate: "3" },
  vehicle: { name: "Renault Clio 2019", value: "8.500,00" },
  precious_metal: { name: "Lingote de oro 100 g", value: "6.200,00" },
  other: { name: "Colección de relojes", value: "3.000,00" },
  mortgage: { name: "Hipoteca Santander", balance: "120.000,00" },
  loan: { name: "Préstamo coche", balance: "8.000,00" },
  credit_card: { name: "Visa BBVA", balance: "850,00" },
  // A connected source's rolled-up holding (e.g. "Colección Numista") is created
  // by syncing the source, never hand-added — so it is absent from FAMILIES and
  // never rendered here. This entry only satisfies the exhaustive Instrument map.
  coin_collection: { name: "Colección Numista" },
};

/** The liquidity-tier color token a holding's rung paints with (design-system §5). */
function tierVar(instrument: Instrument): string {
  return `var(--tier-${defaultsFor(instrument).rung})`;
}

export default async function AnadirHoldingPage({
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
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { activeMembers, assets, scopes, selectedScope } = storeData;
  const resolvedParams = resolvedSearchParams ?? {};
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  const values = formError?.formId === "holding" ? formError.values : {};
  const selectedInstrument = selectedInstrumentFromAddHoldingState(
    values,
    resolvedParams,
  );
  const assocOptions = assets.map((a) => ({ id: a.id, name: a.name }));

  // Pure-CSS `:has()` disclosure: one reveal rule per instrument, generated from
  // the catalog so it stays the single source of the instrument list (ADR 0009).
  const revealCss = [
    `.addHolding:has(input[name="instrument"]:checked) .addHoldingEmpty{display:none}`,
    `.addHolding:has(input[name="instrument"]:checked) .addHoldingFooter{display:flex}`,
    ...ALL_INSTRUMENTS.map(
      (e) =>
        `.addHolding:has(input[name="instrument"][value="${e.id}"]:checked) .addHoldingPane[data-instrument="${e.id}"]{display:grid}`,
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

      <section className="addHoldingPage" aria-label="Añadir holding">
        <div className="panelHeader addHoldingHeader">
          <h2>Añadir holding</h2>
          <Link href="/patrimonio">← Volver</Link>
        </div>
        <p className="addHoldingLead">
          Elige primero <strong>qué es</strong>. La capa de liquidez, el método de
          valoración y el proveedor se derivan del instrumento.
        </p>

        {formError?.formId === "holding" ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        <form action={createHoldingAction} className="addHolding">
          <div className="addHoldingGrid">
            <aside className="addHoldingGallery" aria-label="Instrumentos">
              {FAMILIES.map((family) => (
                <fieldset key={family.key} className="addHoldingFamily">
                  <legend>{family.label}</legend>
                  <div className="addHoldingChips">
                    {family.instruments.map((entry) => (
                      <label
                        key={entry.id}
                        className="addHoldingChip"
                        style={{ "--dot": tierVar(entry.id) } as CSSProperties}
                      >
                        <input
                          type="radio"
                          name="instrument"
                          value={entry.id}
                          defaultChecked={selectedInstrument === entry.id}
                        />
                        <span className="addHoldingDot" aria-hidden="true" />
                        <span className="addHoldingChipBody">
                          <span className="addHoldingChipLabel">{entry.label}</span>
                          <span className="addHoldingChipHint">{entry.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </aside>

            <div className="addHoldingRight">
              <section className="addHoldingPanes" aria-live="polite">
                <p className="addHoldingEmpty">
                  Elige un instrumento a la izquierda para empezar.
                </p>
                {ALL_INSTRUMENTS.map((entry) => (
                  <InstrumentPane
                    key={entry.id}
                    entry={entry}
                    values={values}
                    resolvedParams={resolvedParams}
                    selectedInstrument={selectedInstrument}
                    assocOptions={assocOptions}
                  />
                ))}
              </section>

              <div className="addHoldingFooter">
                <OwnershipInputs
                  members={activeMembers}
                  scopeMemberId={ownershipScopeMemberId}
                  values={values}
                />
                <div className="formActions">
                  <button type="submit">Añadir al patrimonio</button>
                  <Link href="/patrimonio">Cancelar</Link>
                </div>
              </div>
            </div>
          </div>
        </form>
      </section>
    </Shell>
  );
}

function InstrumentPane({
  entry,
  values,
  assocOptions,
  resolvedParams,
  selectedInstrument,
}: {
  entry: InstrumentEntry;
  values: Record<string, string>;
  assocOptions: Array<{ id: string; name: string }>;
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedInstrument: Instrument | undefined;
}) {
  const defaults = defaultsFor(entry.id);
  const isLiability = LIABILITY_INSTRUMENTS.has(entry.id);

  return (
    <div
      className="addHoldingPane"
      data-instrument={entry.id}
      style={{ "--dot": tierVar(entry.id) } as CSSProperties}
    >
      <div className="addHoldingMain">
        <h3 className="addHoldingTitle">{entry.label}</h3>
        <MethodFields
          entry={entry}
          values={values}
          resolvedParams={resolvedParams}
          selectedInstrument={selectedInstrument}
          assocOptions={assocOptions}
        />
      </div>

      <aside className="addHoldingSummary" aria-label="Se creará">
        <p className="addHoldingSummaryLabel">Se creará</p>
        <dl className="addHoldingReadout">
          <div>
            <dt>Dirección</dt>
            <dd>{isLiability ? "Pasivo (deuda)" : "Activo"}</dd>
          </div>
          <div>
            <dt>Método de valoración</dt>
            <dd>{METHOD_LABEL[defaults.valuationMethod]}</dd>
          </div>
          <div>
            <dt>Capa de liquidez</dt>
            <dd>
              <span className="addHoldingCapaDot" aria-hidden="true" />
              {RUNG_LABEL[defaults.rung]}
            </dd>
          </div>
          <div>
            <dt>Proveedor de precios</dt>
            <dd>
              {defaults.priceProvider
                ? (PROVIDER_LABEL[defaults.priceProvider] ?? defaults.priceProvider)
                : "—"}
            </dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

/** Progressive disclosure: only the fields the valuation method needs (suffixed). */
function MethodFields({
  entry,
  values,
  assocOptions,
  resolvedParams,
  selectedInstrument,
}: {
  entry: InstrumentEntry;
  values: Record<string, string>;
  assocOptions: Array<{ id: string; name: string }>;
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedInstrument: Instrument | undefined;
}) {
  const id = entry.id;
  const method = defaultsFor(id).valuationMethod;
  const ph = PLACEHOLDERS[id];
  const v = (field: string): string | undefined =>
    addHoldingFieldValue({
      field,
      instrument: id,
      searchParams: resolvedParams,
      selectedInstrument,
      values,
    });

  return (
    <div className="addHoldingFields">
      <label className="addHoldingFull">
        Nombre
        <input
          name={`name_${id}`}
          defaultValue={v("name")}
          placeholder={ph.name}
          autoComplete="off"
        />
      </label>

      {method === "stored" ? (
        <label>
          Valor actual (EUR)
          <input
            name={`value_${id}`}
            defaultValue={v("value")}
            inputMode="decimal"
            placeholder={ph.value}
          />
        </label>
      ) : null}

      {method === "derived" ? (
        <>
          <SymbolSearch
            basePath="/patrimonio/anadir"
            instrument={id}
            pickedSymbol={
              id === selectedInstrument
                ? typeof resolvedParams["pfSymbol"] === "string"
                  ? resolvedParams["pfSymbol"]
                  : undefined
                : undefined
            }
            query={
              id === selectedInstrument
                ? firstNonEmptyParam(resolvedParams["symbolq"])
                : undefined
            }
            currentParams={buildSymbolSearchCurrentParams(
              resolvedParams,
              selectedInstrument,
            )}
          />
          <label>
            Símbolo del proveedor
            {id === "crypto" ? <small> (id de CoinGecko, p. ej. «bitcoin»)</small> : null}
            <input
              name={`symbol_${id}`}
              defaultValue={v("symbol")}
              placeholder={ph.symbol}
              autoComplete="off"
            />
          </label>
          <label>
            Precio manual por unidad (EUR) <small>(opcional)</small>
            <input
              name={`price_${id}`}
              defaultValue={v("price")}
              inputMode="decimal"
              placeholder={ph.price}
            />
          </label>
        </>
      ) : null}

      {method === "appreciating" ? (
        <>
          <label>
            Fecha de adquisición
            <input
              name={`acqDate_${id}`}
              defaultValue={v("acqDate")}
              type="date"
              max={new Date().toISOString().slice(0, 10)}
            />
          </label>
          <label>
            Precio de adquisición (EUR)
            <input
              name={`acqValue_${id}`}
              defaultValue={v("acqValue")}
              inputMode="decimal"
              placeholder={ph.acqValue}
            />
          </label>
          <label>
            Tasa de revalorización anual (%) <small>(opcional)</small>
            <input
              name={`rate_${id}`}
              defaultValue={v("rate")}
              inputMode="decimal"
              placeholder={ph.rate}
            />
          </label>
        </>
      ) : null}

      {id === "loan" ? (
        <label>
          Modelo de deuda
          <select name={`debtModel_${id}`} defaultValue={v("debtModel") ?? "amortizable"}>
            <option value="amortizable">Amortizable · cuadro de amortización</option>
            <option value="informal">Informal · saldos declarados</option>
          </select>
          <small>
            Informal no necesita plazo ni fecha de primer pago: registras saldos.
          </small>
        </label>
      ) : null}

      {method === "amortized" || method === "anchored" ? (
        <label>
          Saldo pendiente (EUR)
          <input
            name={`balance_${id}`}
            defaultValue={v("balance")}
            inputMode="decimal"
            placeholder={ph.balance}
          />
        </label>
      ) : null}

      {id === "mortgage" ? (
        <>
          <label className="addHoldingFull">
            Activo asociado <small>(la vivienda que garantiza)</small>
            <select name={`assoc_${id}`} defaultValue={v("assoc") ?? ""}>
              <option value="">Sin activo asociado</option>
              {assocOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.name}
                </option>
              ))}
            </select>
          </label>
          <label className="addHoldingFull addHoldingInherit">
            <input
              type="checkbox"
              name={`inheritOwnership_${id}`}
              defaultChecked={v("inheritOwnership") !== "off"}
            />
            <span>
              Mismo reparto que el activo asociado{" "}
              <small>(copia su propiedad; podrás ajustarla luego)</small>
            </span>
          </label>
        </>
      ) : null}
    </div>
  );
}

/** Shared ownership inputs (canonical names) — one set for whatever instrument is chosen. */
function OwnershipInputs({
  members,
  scopeMemberId,
  values,
}: {
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
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
