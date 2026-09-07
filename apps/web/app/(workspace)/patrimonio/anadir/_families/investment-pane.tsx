/**
 * The investment family's alta pane (#1700), beside {@link runInvestmentAlta}.
 *
 * The richest drawer, and the only nested disclosure in the wizard: pick where
 * the investment lives (three groups, three providers — #597), then how you can
 * answer «cuánto tengo» (a balance today, a broker statement, or capital that
 * arrived by traspaso — #1541). Both levels reveal with the CSS generated from
 * the drawers table; this module never spells a class or a `data-*` value.
 */

import { ExternalTransferCapture } from "@web/patrimonio/anadir/external-transfer-capture";
import { InvestmentCapture } from "@web/patrimonio/anadir/investment-capture";
import { parseOpeningCostMode } from "@web/patrimonio/anadir/investment-units";
import {
  PlanSearchResult,
  type PlanSearchState,
} from "@web/patrimonio/anadir/plan-search";
import {
  addHoldingFieldValue,
  buildSymbolSearchCurrentParams,
  firstNonEmptyParam,
} from "@web/patrimonio/anadir/search-state";
import {
  SecurityIdField,
  securityIdFieldName,
} from "@web/patrimonio/anadir/security-id-field";
import SymbolSearch from "@web/patrimonio/anadir/symbol-search";
import type { Instrument } from "@worthline/domain";
import { defaultsFor, normalizeDgsCode } from "@worthline/domain";
import { fetchPriceNow, isRegisteredSource, searchSymbols } from "@worthline/pricing";
import Link from "next/link";
import type { DrawerId } from "./alta-drawers";
import {
  drawerPaneProps,
  GROUP_EMPTY_PROPS,
  GROUP_FIELD,
  groupPaneProps,
  INVESTMENT_GROUPS,
  INVESTMENT_MODES,
  type InvestmentGroup,
  isNonDefaultInvestmentMode,
  modeField,
  modePaneProps,
} from "./alta-drawers";
import { Field, PaneActions, PaneHeader, type PaneValues } from "./pane-shell";

/** Where the alta's own GET sub-forms submit — the search recipe of ADR 0009/0036. */
const ALTA_BASE_PATH = "/patrimonio/anadir";

/**
 * The plan's own search (variante A de #1669): the DGS code the user typed, resolved
 * against Finect's public plan API so the alta can offer the candidate whose pick
 * prefills name and symbol.
 *
 * Null unless the plan group is the one open AND a code travelled — the code arrives
 * as a search param only through the «Buscar plan» GET and the pick navigation that
 * follows it, so an ordinary render of the alta pays no network.
 *
 * It NEVER throws and never blocks: `searchSymbols` degrades each provider to no
 * results, so Finect down, Finect slow or a code that does not exist all land as
 * `candidate: null` — and what the pane then renders is the way out, not a wall.
 */
export async function loadPlanSearch({
  resolvedParams,
  selectedDrawer,
  selectedInstrument,
}: {
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedDrawer: DrawerId | undefined;
  selectedInstrument: Instrument | undefined;
}): Promise<PlanSearchState | null> {
  const group = INVESTMENT_GROUPS.find((row) => row.instrument === selectedInstrument);

  if (selectedDrawer !== "inversion" || !group?.identitySeedsSearch) {
    return null;
  }

  const code = firstNonEmptyParam(
    resolvedParams[securityIdFieldName(group.instrument)],
  )?.trim();

  if (!code) return null;

  // Lo que busca Finect es el código CANÓNICO: su lector distingue código de slug
  // por la forma (`N5394`), y `n-5394` —como lo imprime más de un extracto— no casa
  // con ninguna de las dos. Se normaliza antes de preguntar, y lo que se enseña si
  // no hay candidato sigue siendo lo que el usuario escribió. Un valor que no es un
  // código pasa tal cual: puede ser un slug completo o una URL de Finect, que su
  // lector sí entiende.
  const candidates = await searchSymbols(
    normalizeDgsCode(code) ?? code,
    group.instrument,
  );

  return { candidate: candidates[0] ?? null, code };
}

/**
 * The one network read the whole alta performs, and it is this family's: the
 * picked symbol's live unit price (#597 — «búsqueda devuelve símbolo + precio en
 * vivo»), fetched once when a candidate has been chosen, to prefill the price
 * field and the «≈ participaciones» hint.
 *
 * Null when the investment drawer is not the one open, when nothing has been
 * picked yet, or when the provider has no quote — then the manual-fallback price
 * field stays empty for the user to fill. Only the investment drawer pays this
 * fetch: the page hands over the whole question rather than pre-deciding it.
 */
export async function loadInvestmentLivePrice({
  resolvedParams,
  selectedDrawer,
  selectedInstrument,
  values,
}: {
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedDrawer: DrawerId | undefined;
  selectedInstrument: Instrument | undefined;
  values: PaneValues;
}): Promise<string | null> {
  if (selectedDrawer !== "inversion" || !selectedInstrument) {
    return null;
  }

  const pickedSymbol =
    firstNonEmptyParam(resolvedParams["pfSymbol"]) ??
    addHoldingFieldValue({
      field: "symbol",
      instrument: selectedInstrument,
      searchParams: resolvedParams,
      selectedInstrument,
      values,
    });
  const provider = defaultsFor(selectedInstrument).priceProvider;

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

export interface InvestmentPaneProps {
  /** The picked symbol's live unit price, when a candidate has been chosen (#597). */
  livePrice: string | null;
  /** What the plan's DGS code resolved to, when one was searched (#1746). */
  planSearch: PlanSearchState | null;
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedInstrument: Instrument | undefined;
  today: string;
  values: PaneValues;
}

export function InvestmentPane({
  livePrice,
  planSearch,
  resolvedParams,
  selectedInstrument,
  today,
  values,
}: InvestmentPaneProps) {
  return (
    <div {...drawerPaneProps("inversion")}>
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
              name={GROUP_FIELD}
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

      <p {...GROUP_EMPTY_PROPS}>
        Elige arriba y aparecerá la búsqueda del proveedor que le corresponde.
      </p>

      {INVESTMENT_GROUPS.map((group) => (
        <InvestmentGroupPane
          group={group}
          key={group.instrument}
          livePrice={livePrice}
          planSearch={planSearch}
          resolvedParams={resolvedParams}
          selectedInstrument={selectedInstrument}
          today={today}
          values={values}
        />
      ))}
    </div>
  );
}

function InvestmentGroupPane({
  group,
  livePrice,
  planSearch,
  resolvedParams,
  selectedInstrument,
  today,
  values,
}: InvestmentPaneProps & { group: InvestmentGroup }) {
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
  const invMode = v("invMode");

  const pickedSymbol =
    isSelected && typeof resolvedParams["pfSymbol"] === "string"
      ? resolvedParams["pfSymbol"]
      : undefined;
  const currentParams = buildSymbolSearchCurrentParams(
    resolvedParams,
    selectedInstrument,
  );

  const symbolSource = group.identitySeedsSearch
    ? {
        above: (
          <>
            <SecurityIdField
              className="simpleField"
              instrument={id}
              searchBasePath={ALTA_BASE_PATH}
              value={v("securityId")}
            />
            {isSelected && planSearch ? (
              <PlanSearchResult
                basePath={ALTA_BASE_PATH}
                currentParams={currentParams}
                pickedSymbol={pickedSymbol}
                state={planSearch}
              />
            ) : null}
          </>
        ),
        // Sin candidato el símbolo viaja vacío, y el plan nace «identificado, sin
        // cotizar» — legítimo, con señal de salud y reintento desde la ficha.
        below: <input name={`symbol_${id}`} type="hidden" value={v("symbol") ?? ""} />,
      }
    : {
        above: (
          <SymbolSearch
            basePath={ALTA_BASE_PATH}
            currentParams={currentParams}
            instrument={id}
            pickedSymbol={pickedSymbol}
            query={isSelected ? firstNonEmptyParam(resolvedParams["symbolq"]) : undefined}
          />
        ),
        below: (
          <>
            <Field label={group.symbolLabel}>
              <input
                autoComplete="off"
                defaultValue={v("symbol")}
                name={`symbol_${id}`}
                placeholder={group.searchPlaceholder}
              />
            </Field>
            {/* Crypto has no identifier to ask for: the field derives that from the
                same domain map the health signal reads, so the question and the
                warning can never disagree — it renders nothing at all there. */}
            <SecurityIdField
              className="simpleField"
              instrument={id}
              value={v("securityId")}
            />
          </>
        ),
      };

  return (
    <div {...groupPaneProps(id)}>
      {/* Cómo llega el símbolo es LA diferencia entre los grupos, y son dos
          bloques que van uno a cada lado del nombre — así que se deciden juntos,
          en la única rama sobre la tabla que hay aquí (ADR 0095):

          - variante A (#1669): el identificador ES la caja de búsqueda, y el
            símbolo viaja prellenado del candidato elegido. Un plan se busca por su
            código; nadie tiene impreso un slug de Finect.
          - los demás: buscan por nombre/ISIN, teclean el símbolo si hace falta, y
            el identificador es un campo más. */}
      {symbolSource.above}

      <Field label="Nombre">
        <input
          autoComplete="off"
          defaultValue={v("name")}
          name={`name_${id}`}
          placeholder="Mi inversión"
        />
      </Field>
      {symbolSource.below}

      <fieldset className="simpleChoiceGroup">
        <legend>¿Cómo lo registramos?</legend>
        {INVESTMENT_MODES.map((mode) => (
          <label className="ownerPreset simpleChoice" key={mode.id}>
            <input
              // The default mode is read as a NEGATIVE list on purpose (see
              // `isNonDefaultInvestmentMode`): anything the round-trip did not
              // bring back reopens «saldo». A positive test would leave the group
              // with NO radio checked, which is a form that submits nothing.
              defaultChecked={
                mode.isDefault
                  ? !isNonDefaultInvestmentMode(invMode)
                  : invMode === mode.id
              }
              name={modeField(id)}
              type="radio"
              value={mode.id}
            />
            {mode.label}
          </label>
        ))}
      </fieldset>

      <div {...modePaneProps("saldo")}>
        <InvestmentCapture
          defaultCost={v("cost") ?? ""}
          defaultCostMode={parseOpeningCostMode(v("costMode") ?? "") ?? undefined}
          defaultDate={v("saldoDate") ?? ""}
          defaultPrice={priceValue}
          defaultSaldo={v("saldo") ?? ""}
          instrument={id}
          key={captureKey}
          priceHint={
            isSelected && livePrice
              ? `Precio en vivo de ${group.providerLabel}.`
              : group.symbolHint
          }
          today={today}
        />
        <PaneActions />
      </div>

      <div {...modePaneProps("traspaso")}>
        <p className="simpleHint">
          No es una compra: el capital ya era tuyo y solo ha cambiado de gestora, así que{" "}
          <strong>no consume cupo de aportación</strong> y no realiza plusvalía. El coste
          que traían las participaciones viaja con ellas.
        </p>
        <ExternalTransferCapture
          defaultAmount={v("trAmount") ?? ""}
          defaultCost={v("trCost") ?? ""}
          defaultDate={v("trDate") ?? ""}
          // No live-quote prefill here, unlike the saldo pane: the VL this entry
          // needs is the one of the DAY THE CAPITAL LANDED, and today's quote for a
          // traspaso recorded weeks later would be a wrong figure presented as a
          // helpful one — and it is the figure that fixes the participaciones.
          defaultPrice={v("trPrice") ?? ""}
          defaultSeniority={v("trSeniority") ?? ""}
          instrument={id}
          key={`tr-${captureKey}`}
          today={today}
        />
        <PaneActions />
      </div>

      <div {...modePaneProps("import")}>
        <p className="simpleHint">
          Crearemos la inversión vacía y te llevamos a <strong>Cargar movimientos</strong>{" "}
          para subir la plantilla de Worthline. Sus operaciones serán el histórico — sin
          ninguna apertura inventada de hoy.
        </p>
        {group.accountLevelImport ? (
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
