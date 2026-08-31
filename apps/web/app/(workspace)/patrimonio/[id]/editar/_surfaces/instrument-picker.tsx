/**
 * The ficha's instrument-correction picker (#1512, ADR 0098).
 *
 * One component for both «Lo básico» surfaces — the hand-valued asset and the
 * investment — because the correction is the same gesture with the same gate; only
 * the list of offers differs, and `assignableInstruments` already derives that from
 * the holding.
 *
 * The consequence it prints is COMPUTED, not written: `instrumentPickerImpact`
 * reads the holding's own declared rung and answers which of the offers would move
 * it across the sellable ↔ immobilized frontier of the FIRE capital split (#1447,
 * ADR 0078). So a flat on `illiquid` is told nothing crosses, a pension on
 * `term-locked` is told exactly what would, and no tier rate is repeated here as a
 * literal that can drift from `TIER_REAL_RETURN_DEFAULTS`.
 *
 * Server-rendered, no client JS (ADR 0009): the note is about the holding in front
 * of the user, not about the option under the cursor.
 */

import type { Instrument, LiquidityTier } from "@worthline/domain";
import {
  assignableInstrumentsForHolding,
  instrumentLabelEs,
  instrumentPickerImpact,
} from "@worthline/domain";

export function InstrumentPicker({
  connectedSourceId,
  currentInstrument,
  liquidityTier,
  values,
}: {
  /**
   * The source that owns this holding's identity, when one does (#1691). A synced
   * holding is read-only here whatever its instrument column says — the column can
   * be wrong (the v14 backfill), and letting the picker trust it turned a
   * mislabelled row into the ONE row the app offered to relabel.
   */
  connectedSourceId?: string | null;
  /** What the holding is today — the select's own value and the offer list's source. */
  currentInstrument: Instrument;
  /** The rung the holding DECLARES; the correction never re-applies a default one. */
  liquidityTier: LiquidityTier;
  values: Record<string, string>;
}) {
  const assignable = assignableInstrumentsForHolding({
    connectedSourceId: connectedSourceId ?? null,
    instrument: currentInstrument,
  });

  // Nothing to offer: state what the holding is and who decides it, rather than
  // rendering an empty select. No `name="instrument"` is posted, so the correction
  // parser reads «sin cambio» — the read-only surface and the action agree.
  if (assignable.length === 0) {
    return (
      <p className="infoNote">
        Instrumento: <strong>{instrumentLabelEs(currentInstrument)}</strong>. Lo decide la
        fuente conectada que sincroniza este holding, así que no se corrige a mano.
      </p>
    );
  }

  const impact = instrumentPickerImpact({
    current: currentInstrument,
    liquidityTier,
  });

  return (
    <>
      <label>
        Instrumento
        <select
          defaultValue={values["instrument"] ?? currentInstrument}
          name="instrument"
        >
          {assignable.map((option) => (
            <option key={option} value={option}>
              {instrumentLabelEs(option)}
            </option>
          ))}
        </select>
      </label>

      <p className="infoNote">
        El instrumento decide dónde pesa este holding: su tramo y el retorno que se le
        supone. Cambiarlo no toca el valor declarado, ni la disponibilidad, ni el
        proveedor de precios, ni los cobros ya anotados.
        {impact.crossing.length > 0 ? (
          <>
            {" "}
            Hoy cuenta en el{" "}
            <strong>
              {impact.currentSide === "immobilized"
                ? "lado inmovilizado"
                : "lado vendible"}
            </strong>{" "}
            del capital FIRE; con {impact.crossing.map(instrumentLabelEs).join(", ")}{" "}
            pasaría al otro lado.
          </>
        ) : null}
      </p>
    </>
  );
}
