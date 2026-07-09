/**
 * Housing valuation editor — the `appreciating` surface (PRD #108, #152).
 *
 * Only rendered for an appreciating holding (a property). Three stacked forms,
 * all server-action driven (no client JS, ADR 0009): the appreciation rate, a
 * new anchor, and a date-desc list of anchors with inline edit (<details>) and
 * two-step delete per row. Extracted from the monolithic editar page.
 */

import type { FormErrorContext } from "@web/intake";
import {
  addValuationAnchorAction,
  deleteValuationAnchorAction,
  setAppreciationRateAction,
  setHousingValuationCadenceAction,
  updateValuationAnchorAction,
} from "@web/patrimonio/actions";
import type { ValuationAnchorRecord } from "@worthline/db";
import type { ValuationCadence } from "@worthline/domain";
import { formatMoneyInput, formatMoneyMinorPrivacy } from "@worthline/domain";

/** Render a stored decimal rate ("0.03") back as the percent the user typed ("3"). */
function rateToPercentInput(rate: string | null): string {
  if (rate === null) {
    return "";
  }

  const pct = Number(rate) * 100;

  // Trim float noise (0.07 * 100 = 7.000000000000001) without dropping real decimals.
  return String(Math.round(pct * 1_000_000) / 1_000_000);
}

export function HousingValuationSection({
  anchors,
  appreciationRate,
  assetId,
  formError,
  privacyMode = false,
  today,
  valuationCadence,
}: {
  anchors: ValuationAnchorRecord[];
  appreciationRate: string | null;
  assetId: string;
  formError: FormErrorContext | null;
  privacyMode?: boolean;
  today: string;
  /** Stored valuation cadence (ADR 0031); null reads as the default `step`. */
  valuationCadence: ValuationCadence | null;
}) {
  const currentUrl = `/patrimonio/${assetId}/editar`;
  const rateValues = formError?.formId === "rate" ? formError.values : {};
  const anchorValues = formError?.formId === "anchor" ? formError.values : {};
  const sorted = [...anchors].sort((a, b) =>
    b.valuationDate.localeCompare(a.valuationDate),
  );

  return (
    <section className="housingValuation" aria-label="Valoración del inmueble">
      <h3>Valoración del inmueble</h3>

      <form action={setAppreciationRateAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={assetId} />
        <label>
          Tasa de revalorización anual (%)
          <input
            aria-label="Tasa de revalorización anual (%)"
            defaultValue={rateValues["rate"] ?? rateToPercentInput(appreciationRate)}
            inputMode="decimal"
            name="rate"
            placeholder="3"
          />
        </label>
        <p className="infoNote">
          Déjalo en blanco para no aplicar revalorización entre tasaciones.
        </p>
        <button type="submit">Guardar tasa</button>
      </form>

      <details className="anchorEdit">
        <summary>Avanzado</summary>
        <form action={setHousingValuationCadenceAction} className="stackForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={assetId} />
          <label>
            Cadencia de valoración
            <select
              aria-label="Cadencia de valoración"
              defaultValue={valuationCadence ?? "step"}
              name="cadence"
            >
              <option value="step">Escalonado (por defecto)</option>
              <option value="interpolated">Interpolado (suave a diario)</option>
            </select>
          </label>
          <p className="infoNote">
            Escalonado mantiene el último valor conocido hasta la siguiente tasación;
            interpolado dibuja una línea suave de revalorización entre eventos en el
            histórico.
          </p>
          <button type="submit">Guardar cadencia</button>
        </form>
      </details>

      <form
        action={addValuationAnchorAction}
        aria-label="Registrar tasación"
        className="stackForm"
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={assetId} />
        <AnchorFields max={today} values={anchorValues} />
        <button type="submit">Registrar tasación</button>
      </form>

      {sorted.length > 0 ? (
        <div className="tableScroll">
          <table aria-label="Tasaciones">
            <thead>
              <tr>
                <th>Fecha</th>
                <th className="numCol">Valor</th>
                <th>Tipo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((anchor) => (
                <AnchorRow
                  anchor={anchor}
                  assetId={assetId}
                  currentUrl={currentUrl}
                  formError={formError}
                  key={anchor.id}
                  max={today}
                  privacyMode={privacyMode}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="emptyLine">Sin tasaciones registradas.</p>
      )}
    </section>
  );
}

/** Shared date / value / type fields for the add and edit anchor forms. */
function AnchorFields({ max, values }: { max: string; values: Record<string, string> }) {
  return (
    <>
      <label>
        Fecha de la tasación
        <input
          aria-label="Fecha de la tasación"
          defaultValue={values["valuationDate"]}
          max={max}
          name="valuationDate"
          required
          type="date"
        />
      </label>
      <label>
        Valor de la tasación (EUR)
        <input
          aria-label="Valor de la tasación en EUR"
          defaultValue={values["anchorValue"]}
          inputMode="decimal"
          min="0"
          name="anchorValue"
          placeholder="180.000"
          required
        />
      </label>
      <label className="checkLine">
        <input
          defaultChecked={values["adjustsPriorCurve"] === "on"}
          name="adjustsPriorCurve"
          type="checkbox"
        />{" "}
        Es una tasación de mercado
      </label>
      <p className="infoNote">
        <strong>Tasación de mercado:</strong> una valoración real del inmueble que
        recalibra toda la curva de valoraciones previas. <strong>Mejora:</strong> una
        inversión (reforma, ampliación) que se suma al valor existente sin reemplazar las
        tasaciones anteriores.
      </p>
    </>
  );
}

/** One anchor row: data + inline edit (<details>) + two-step delete (<details>). */
function AnchorRow({
  anchor,
  assetId,
  currentUrl,
  formError,
  max,
  privacyMode = false,
}: {
  anchor: ValuationAnchorRecord;
  assetId: string;
  currentUrl: string;
  formError: FormErrorContext | null;
  max: string;
  privacyMode?: boolean;
}) {
  const editFormId = `anchor-${anchor.id}`;
  const editing = formError?.formId === editFormId;
  const editValues = editing
    ? formError.values
    : {
        adjustsPriorCurve: anchor.adjustsPriorCurve ? "on" : "",
        anchorValue: formatMoneyInput(anchor.valueMinor),
        valuationDate: anchor.valuationDate,
      };

  return (
    <tr>
      <td>{anchor.valuationDate}</td>
      <td className="numCol">
        {formatMoneyMinorPrivacy(
          { amountMinor: anchor.valueMinor, currency: "EUR" },
          privacyMode,
        )}
      </td>
      <td>{anchor.adjustsPriorCurve ? "Tasación" : "Mejora"}</td>
      <td className="rowActions">
        <details className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateValuationAnchorAction}
            aria-label="Editar tasación"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={assetId} />
            <input name="anchorId" type="hidden" value={anchor.id} />
            <AnchorFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar tasación</button>
            </div>
          </form>
        </details>
        <form action={deleteValuationAnchorAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={assetId} />
          <input name="anchorId" type="hidden" value={anchor.id} />
          <details className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </tr>
  );
}
