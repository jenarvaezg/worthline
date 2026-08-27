/**
 * Acquisition-cost editor — the property's OTHER figure (#1441).
 *
 * A property has two numbers on the day it is bought, and until this surface
 * existed the app asked for one and stored it as the other: «Precio de
 * adquisición» went straight into `asset_valuations` as a market appraisal. Yeles
 * makes the gap concrete — 48.000 € on the escritura, 53.354,55 € actually
 * disbursed: an 11,2 % that vanishes at instant zero, and measuring return
 * against the price inflates it exactly where the entry costs are largest.
 *
 * So the cost lives here, beside the valuation surface and deliberately NOT
 * inside it: everything in `HousingValuationSection` feeds the curve, and nothing
 * on this one does. Saving a cost re-derives no snapshot, moves no equity and
 * leaves the implied LTV alone — the action it posts to says so, and the store
 * seam under it is the only housing write with no ripple.
 *
 * The fiscal boundary is stated in words rather than in more inputs: a breakdown
 * (ITP / notaría / registro) is another ticket, and financing cost is not a third
 * category — mixing it in breaks both comparability and the art. 35 LIRPF base.
 */

import type { FormErrorContext } from "@web/intake";
import { setHousingAcquisitionCostAction } from "@web/patrimonio/actions";
import type { CurrencyCode } from "@worthline/domain";
import { formatMoneyInput, formatMoneyMinorPrivacy, moneySign } from "@worthline/domain";

export function AcquisitionCostSection({
  acquisitionCostMinor,
  assetId,
  currency,
  currentUrl,
  currentValueMinor,
  formError,
  privacyMode = false,
}: {
  /** The stored cost in minor units, or null when nobody has typed one yet. */
  acquisitionCostMinor: number | null;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  assetId: string;
  currency: CurrencyCode;
  /** The holding's own public `wl_hld_…` URL, where the form returns. */
  currentUrl: string;
  /** Today's value of the property, the other half of the result line. */
  currentValueMinor: number;
  formError: FormErrorContext | null;
  privacyMode?: boolean;
}) {
  const values = formError?.formId === "acquisitionCost" ? formError.values : {};
  // Without a cost there is no return to show, and a 0 % would be an invention:
  // the four properties on the book start here on purpose (no backfill from the
  // mixed anchor), and the line simply stays away until someone reads the
  // escritura.
  const result =
    acquisitionCostMinor === null
      ? null
      : { amountMinor: currentValueMinor - acquisitionCostMinor, currency };

  return (
    <section className="housingCost" aria-label="Coste de adquisición">
      <h3>Coste de adquisición</h3>

      <form action={setHousingAcquisitionCostAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={assetId} />
        <label>
          Coste de adquisición (EUR)
          <input
            aria-label="Coste de adquisición en EUR"
            defaultValue={
              values["acquisitionCost"] ??
              (acquisitionCostMinor === null
                ? ""
                : formatMoneyInput(acquisitionCostMinor))
            }
            inputMode="decimal"
            min="0"
            name="acquisitionCost"
            placeholder="194.400,00"
          />
        </label>
        <p className="infoNote">
          ITP, notaría, registro y gestoría. No la hipoteca ni sus comisiones.
        </p>
        <button type="submit">Guardar coste</button>
      </form>

      {result !== null ? (
        <p className="acquisitionCostResult">
          <span>Resultado frente al coste</span>{" "}
          {/* `<output>` and not a bolded span: this IS the result of a calculation,
              and its role is the one that actually accepts the accessible name a
              screen reader needs to hear beside the figure. A `<strong>` carries
              role `strong`, which prohibits naming (biome a11y). */}
          <output
            aria-label="Resultado frente al coste de adquisición"
            className={moneySign(result)}
          >
            {result.amountMinor > 0 ? "+" : ""}
            {formatMoneyMinorPrivacy(result, privacyMode)}
          </output>
        </p>
      ) : null}
    </section>
  );
}
