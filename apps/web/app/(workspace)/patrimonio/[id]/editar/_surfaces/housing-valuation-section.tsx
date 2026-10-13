/**
 * Housing valuation editor — the `appreciating` surface (PRD #108, #152).
 *
 * Only rendered for an appreciating holding (a property), as its ficha's
 * «Valoración» tab (#1847). Stacked forms, all server-action driven (no client JS,
 * ADR 0009): the appreciation rate, and a date-desc list of anchors with inline
 * edit (<details>) and two-step delete per row. A NEW anchor is the ficha's
 * habitual action, so its form ({@link AnchorAddForm}) lives in the side panel and
 * not here; the row it adds is marked when the panel lands back on this tab.
 *
 * The ONE exception is the named acquisition editor (#1437), an island since
 * #1562: editing the oldest point of the curve rewrites decades of history, so
 * it asks before it does it (preview → confirm).
 */

import { FormRefusal, refusalAria, refusalFor } from "@web/_components/form-refusal";
import { FreshMark, FreshRow } from "@web/_components/fresh-rows";
import type { FormErrorContext } from "@web/intake";
import { formatDecimalAsPercentField } from "@web/intake-primitives";
import {
  addValuationAnchorAction,
  deleteValuationAnchorAction,
  setAppreciationRateAction,
  setHousingValuationCadenceAction,
  updateValuationAnchorAction,
} from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { ValuationAnchorRecord } from "@worthline/db";
import type { ValuationCadence } from "@worthline/domain";
import { formatMoneyInput, formatMoneyMinorPrivacy } from "@worthline/domain";
import type { ReactNode } from "react";
import { AcquisitionEditForm } from "./acquisition-edit-form";
import { anchorKindLabel } from "./housing-valuation-view";

/** The «Registrar tasación» form's `formId`: its refusal reopens the panel. */
export const ANCHOR_FORM_ID = "anchor";

const ANCHOR_ERROR_ID = "anchor-error";

/** The anchors' list name, for the ficha to point at the one just added (#1847). */
export const APPRAISALS_ROW_LIST = "tasaciones";

export function HousingValuationSection({
  addLink,
  anchors,
  appreciationRate,
  assetId,
  currentUrl,
  formError,
  privacyMode = false,
  today,
  valuationCadence,
}: {
  /**
   * With no anchor yet, the door to «Registrar tasación» printed in the one line
   * that says so (#1847), as Cobros' empty line opens its own panel (#1830).
   */
  addLink?: ReactNode;
  anchors: ValuationAnchorRecord[];
  appreciationRate: string | null;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  assetId: string;
  /** The holding's own public `wl_hld_…` URL, where every form here returns. */
  currentUrl: string;
  formError: FormErrorContext | null;
  privacyMode?: boolean;
  today: string;
  /** Stored valuation cadence (ADR 0031); null reads as the default `step`. */
  valuationCadence: ValuationCadence | null;
}) {
  const rateValues = formError?.formId === "rate" ? formError.values : {};
  const sorted = [...anchors].sort((a, b) =>
    b.valuationDate.localeCompare(a.valuationDate),
  );
  // #1437: the acquisition is a named field, not an anonymous table row. The
  // editor below targets its anchor through the same update action; errors ride
  // the standard `anchor-<id>` band.
  const acquisition = anchors.find((a) => a.kind === "acquisition") ?? null;
  const acquisitionValues =
    acquisition && formError?.formId === `anchor-${acquisition.id}`
      ? formError.values
      : {};

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
            defaultValue={
              rateValues["rate"] ??
              (appreciationRate === null
                ? ""
                : formatDecimalAsPercentField(Number(appreciationRate)))
            }
            inputMode="decimal"
            name="rate"
            placeholder="3"
          />
        </label>
        <p className="infoNote">
          Déjalo en blanco para no aplicar revalorización entre tasaciones.
        </p>
        <button className="btnSecondary" type="submit">
          Guardar tasa
        </button>
      </form>

      <details suppressHydrationWarning className="anchorEdit">
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
          <button className="btnSecondary" type="submit">
            Guardar cadencia
          </button>
        </form>
      </details>

      {acquisition ? (
        <AcquisitionEditForm
          anchorId={acquisition.id}
          assetId={assetId}
          currentUrl={currentUrl}
          defaultAnchorValue={
            acquisitionValues["anchorValue"] ?? formatMoneyInput(acquisition.valueMinor)
          }
          defaultDate={acquisitionValues["valuationDate"] ?? acquisition.valuationDate}
          privacyMode={privacyMode}
          today={today}
        />
      ) : null}

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
        <p className="emptyLine">Sin tasaciones registradas. {addLink}</p>
      )}
    </section>
  );
}

/**
 * «Registrar tasación»: a new anchor, from the ficha's side panel (#1847). Its date
 * comes set to today — the usual case is an appraisal just received — and stays
 * editable, never past today. «Es una tasación de mercado» starts unticked, as it
 * always has: ticking it recalibrates the whole curve behind it, so it is a choice.
 *
 * Its refusal is its own (`ANCHOR_FORM_ID`): a repeated date or an unreadable value
 * comes back with what was typed and is printed here, inside the panel, which on a
 * phone covers the page band that would otherwise say it.
 */
export function AnchorAddForm({
  assetId,
  currentUrl,
  formError,
  readOnly = false,
  today,
}: {
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  assetId: string;
  /** Where the success and a refusal return: the tab the new row shows on. */
  currentUrl: string;
  formError: FormErrorContext | null;
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  today: string;
}) {
  const refusal = refusalFor(formError, ANCHOR_FORM_ID);
  const values = refusal ? refusal.values : { valuationDate: today };

  return (
    <form
      action={addValuationAnchorAction}
      aria-label="Registrar tasación"
      className="stackForm"
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="id" type="hidden" value={assetId} />
      <FormRefusal id={ANCHOR_ERROR_ID} refusal={refusal} />
      <AnchorFields
        errorId={refusal ? ANCHOR_ERROR_ID : undefined}
        max={today}
        values={values}
      />
      <PendingSubmit disabled={readOnly} pendingLabel="Registrando…">
        Registrar tasación
      </PendingSubmit>
    </form>
  );
}

/** Shared date / value / type fields for the add and edit anchor forms. */
function AnchorFields({
  errorId,
  max,
  values,
}: {
  /** The refusal printed above the fields, which the date and the value point at. */
  errorId?: string | undefined;
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha de la tasación
        <input
          {...refusalAria(errorId)}
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
          {...refusalAria(errorId)}
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

/** One anchor row: data + inline edit (<details suppressHydrationWarning>) + two-step delete (<details suppressHydrationWarning>). */
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
    // The row «Registrar tasación» just added is marked when the panel lands back
    // on this tab (#1847), as a new operation or cobro is (#1829).
    <FreshRow as="tr" list={APPRAISALS_ROW_LIST} rowKey={anchor.id}>
      <td>
        {anchor.valuationDate}
        <FreshMark list={APPRAISALS_ROW_LIST} rowKey={anchor.id} word="nueva" />
      </td>
      <td className="numCol">
        {formatMoneyMinorPrivacy(
          { amountMinor: anchor.valueMinor, currency: "EUR" },
          privacyMode,
        )}
      </td>
      <td>{anchorKindLabel(anchor)}</td>
      <td className="rowActions">
        <details suppressHydrationWarning className="anchorEdit" open={editing}>
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
        {anchor.kind !== "acquisition" ? (
          <form action={deleteValuationAnchorAction}>
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={assetId} />
            <input name="anchorId" type="hidden" value={anchor.id} />
            <details suppressHydrationWarning className="confirmDelete">
              <summary>Eliminar</summary>
              <button type="submit">Confirmar</button>
            </details>
          </form>
        ) : null}
      </td>
    </FreshRow>
  );
}
