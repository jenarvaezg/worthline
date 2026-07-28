/**
 * The opening BUY of an investment alta (#1315) — the ONE place that turns what the
 * model declares (importe efectivo, precio, títulos, comisión) into the `opening`
 * of a {@link HoldingCreationPlan}. Pure: no store, no clock.
 *
 * The whole module is one invariant: `openingValueMinor = units × pricePerUnit +
 * feesMinor`. A broker confirmation states every term of it, so the alta solves for
 * whichever side is missing instead of guessing. Before #1315 only the value and
 * the price fit through the tool, and the units were ALWAYS derived — so «3 títulos
 * × 54,545 € + 1,00 € de comisión = 164,64 €» landed as 3,01814849 unidades with no
 * fee: units that are false forever (the position over-values as soon as a real
 * price arrives, and every later sale inherits the error) and a cost basis missing
 * the commission (inflated returns). With `units` declared they persist verbatim;
 * without them the derivation stays, now net of the commission.
 *
 * When both sides are declared and they disagree by more than a cent of rounding
 * the preview WARNS and still applies (the `observedMonthlyPaymentMinor` pattern of
 * `propose_early_repayment`): the figures are the user's, and a document that does
 * not add up is a fact about the document, not a reason to refuse the alta.
 *
 * Money arrives as integer minor units and a non-integer is REJECTED, never
 * rounded — `jsonSchema()` does not validate at runtime, so this is the real
 * frontier, and silently rounding would write a figure nobody read (ADR 0048).
 */

import { normalizeNonNegativeDecimalString } from "@web/intake";
import { deriveOpeningUnits } from "@web/patrimonio/anadir/investment-units";
import type { InvestmentHoldingCreationPlan } from "@worthline/db";
import { type DecimalString, multiplyToMinor } from "@worthline/domain";

export type OpeningPlan = NonNullable<InvestmentHoldingCreationPlan["opening"]>;

/** The four opening terms as the model may declare them (all optional). */
export interface OpeningDeclaration {
  /** The cash amount the document states, in minor units (títulos × precio + comisión). */
  openingValueMinor?: number;
  /** The unit price as an es-ES decimal string. */
  pricePerUnit?: string;
  /** The units the document states, as an es-ES decimal string. */
  units?: string;
  /** The broker commission in minor units. */
  feesMinor?: number;
}

export type OpeningResolution =
  | {
      ok: true;
      /** `null` when nothing was declared: the alta creates an empty container. */
      opening: OpeningPlan | null;
      /** Informative, never blocking: the declared terms do not add up. */
      mismatchWarning?: string;
    }
  | { ok: false; error: string };

/**
 * Cents of slack when reconciling `units × price + fees` against the declared
 * cash amount. One cent: the product is rounded to cents here (≤ ½ cent) and the
 * document's own total is likewise rounded (≤ ½ cent), so a coherent confirmation
 * — 3 × 54,545 € = 163,635 € → 163,64 € + 1,00 € vs the stated 164,64 € — always
 * lands inside it, and a real transcription error does not.
 */
const RECONCILIATION_TOLERANCE_MINOR = 1;

/** Cents-precise es-ES euros: a commission of 1,00 € may not read as «1 €». */
function euros(amountMinor: number): string {
  return new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

function positiveDecimal(raw: string): DecimalString | null {
  const normalized = normalizeNonNegativeDecimalString(raw);
  if (normalized === null || Number.parseFloat(normalized) === 0) return null;
  return normalized as DecimalString;
}

function isPositiveMinorInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

const MISSING_PRICE =
  "Necesito el precio por unidad para valorar la inversión, o créala sin apertura.";
const MISSING_VALUE =
  "Indica cuánto tienes hoy en euros, o crea la inversión sin apertura.";

/**
 * Resolve the declared terms into the plan's `opening`, or a Spanish rejection the
 * assistant can act on. Returns `opening: null` only when NOTHING was declared.
 */
export function resolveHoldingCreationOpening(
  declared: OpeningDeclaration,
): OpeningResolution {
  const { feesMinor, openingValueMinor, pricePerUnit, units } = declared;
  if (
    openingValueMinor === undefined &&
    pricePerUnit === undefined &&
    units === undefined &&
    feesMinor === undefined
  ) {
    return { ok: true, opening: null };
  }

  if (openingValueMinor !== undefined && !isPositiveMinorInteger(openingValueMinor)) {
    return {
      ok: false,
      error:
        "El importe de la apertura va en CÉNTIMOS enteros y positivos (164,64 € son 16464). No redondeo un importe con decimales: comprueba la cifra.",
    };
  }
  if (
    feesMinor !== undefined &&
    (!Number.isSafeInteger(feesMinor) || (feesMinor as number) < 0)
  ) {
    return {
      ok: false,
      error:
        "La comisión va en CÉNTIMOS enteros y no negativos (1,00 € son 100). No redondeo un importe con decimales.",
    };
  }
  // A declared 0 is «sin comisión», which is already the domain's default: carry
  // nothing rather than a fact that changes nothing.
  const fees = feesMinor !== undefined && feesMinor > 0 ? feesMinor : undefined;

  const price = positiveDecimal(pricePerUnit ?? "");
  if (price === null) return { ok: false, error: MISSING_PRICE };

  if (units !== undefined) {
    const declaredUnits = positiveDecimal(units);
    if (declaredUnits === null) {
      return {
        ok: false,
        error:
          "No entiendo los títulos de la apertura: pásalos como número positivo (3 o 3,01814849).",
      };
    }
    const valueMinor = multiplyToMinor(declaredUnits, price);
    const opening: OpeningPlan = {
      pricePerUnit: price,
      units: declaredUnits,
      valueMinor,
      ...(fees === undefined ? {} : { feesMinor: fees }),
    };
    if (openingValueMinor === undefined) return { ok: true, opening };
    const computedMinor = valueMinor + (fees ?? 0);
    if (Math.abs(openingValueMinor - computedMinor) <= RECONCILIATION_TOLERANCE_MINOR) {
      return { ok: true, opening };
    }
    return {
      ok: true,
      opening,
      mismatchWarning: `El documento dice ${euros(openingValueMinor)}, pero ${formatUnits(declaredUnits)} × ${formatPrice(price)}${
        fees === undefined ? "" : ` + ${euros(fees)} de comisión`
      } son ${euros(computedMinor)}. Doy de alta los títulos, el precio y la comisión tal cual: revisa la cifra si no cuadra.`,
    };
  }

  // No units declared: derive them from the cash amount NET of the commission, the
  // same invariant read backwards, so the fee stops inflating the unit count.
  if (openingValueMinor === undefined) return { ok: false, error: MISSING_VALUE };
  const netMinor = openingValueMinor - (fees ?? 0);
  if (netMinor <= 0) {
    return {
      ok: false,
      error:
        "La comisión no puede igualar ni superar el importe de la apertura: comprueba las dos cifras.",
    };
  }
  const derived = deriveOpeningUnits({
    priceRaw: price,
    saldoRaw: (netMinor / 100).toString(),
  });
  // Unreachable with a validated positive price and net, but the shared seam
  // answers with a result type: never assume ok, and never invent units.
  if (!derived.ok) return { ok: false, error: MISSING_VALUE };
  return {
    ok: true,
    opening: {
      pricePerUnit: derived.price,
      units: derived.units,
      valueMinor: netMinor,
      ...(fees === undefined ? {} : { feesMinor: fees }),
    },
  };
}

/** es-ES units for the card, capped at the 6 decimals the import preview uses. */
function formatUnits(units: string): string {
  const value = Number(units);
  if (!Number.isFinite(value)) return units;
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 6 }).format(value);
}

/** es-ES unit price for the card: a NAV keeps its decimals (54,545 €). */
function formatPrice(price: string): string {
  const value = Number(price);
  if (!Number.isFinite(value)) return `${price} €`;
  return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 6 }).format(value)} €`;
}

export interface OpeningCardBreakdown {
  units: string;
  pricePerUnit: string;
  fees?: string;
}

/**
 * The display-ready breakdown the alta card shows next to the value, so the user
 * confirms the títulos and the comisión that will be persisted — the derived-units
 * case included, where seeing «3,018148 uds.» is exactly what reveals #1315.
 */
export function openingCardBreakdown(opening: OpeningPlan): OpeningCardBreakdown {
  return {
    pricePerUnit: formatPrice(opening.pricePerUnit),
    units: formatUnits(opening.units),
    ...(opening.feesMinor === undefined ? {} : { fees: euros(opening.feesMinor) }),
  };
}
