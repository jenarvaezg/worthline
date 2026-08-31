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
import { IsinField } from "@web/patrimonio/anadir/isin-field";
import {
  addHoldingFieldValue,
  buildSymbolSearchCurrentParams,
  firstNonEmptyParam,
} from "@web/patrimonio/anadir/search-state";
import SymbolSearch from "@web/patrimonio/anadir/symbol-search";
import type { Instrument } from "@worthline/domain";
import { defaultsFor, INVESTMENT_PROFILE_INSTRUMENTS } from "@worthline/domain";
import { fetchPriceNow, isRegisteredSource } from "@worthline/pricing";
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
  resolvedParams: Record<string, string | string[] | undefined>;
  selectedInstrument: Instrument | undefined;
  today: string;
  values: PaneValues;
}

export function InvestmentPane({
  livePrice,
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

  return (
    <div {...groupPaneProps(id)}>
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
      {/* Crypto has no ISIN to ask for, and the set that decides who HAS an
          instrument identity is the domain's — the same one the health signal reads,
          so the question and the warning can never disagree. */}
      {INVESTMENT_PROFILE_INSTRUMENTS.has(group.instrument) ? (
        <IsinField className="simpleField" instrument={id} value={v("isin")} />
      ) : null}

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
