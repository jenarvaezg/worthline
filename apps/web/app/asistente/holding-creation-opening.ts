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
 * A VALUE-ONLY declaration (#1325) — «tengo 574,48 € en este fondo», no units, no
 * NAV, the one thing a managed-portfolio statement states per fund — resolves as
 * **1 participación × the declared value**, the same encoding a wizard user reaches by
 * typing the total as the price (ADR 0006: an investment is always units × price,
 * so updating the value later is editing that price). It is gated by the CALLER on
 * the alta having no `providerSymbol`: the moment a real quote can arrive, the fake
 * unit would revalue to one share's NAV, so a symbol-ful alta derives its units
 * from a live quote instead (the builder's job) or fails honestly. Before this,
 * the tool rejected the declaration and the model fell back to an EMPTY container
 * while its prose promised the value — seven 0 € cards in one real transcript.
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

import { normalizeNonNegativeDecimalString } from "@web/intake-primitives";
import { deriveOpeningUnits } from "@web/patrimonio/anadir/investment-units";
import type { InvestmentHoldingCreationPlan } from "@worthline/db";
import {
  type DecimalString,
  formatMoneyMinorExact,
  multiplyToMinor,
} from "@worthline/domain";

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

export interface OpeningResolutionOptions {
  /**
   * Whether a value-only declaration (amount, no price, no units) may resolve as
   * 1 participación × the declared value (#1325). The builder passes `true` only
   * for an alta WITHOUT `providerSymbol` — with one, a real quote would revalue
   * the fake unit to a single share's NAV, so the units must come from that quote
   * instead.
   */
  allowValueOnly?: boolean;
  /**
   * Whether `openingValueMinor` is a BALANCE («tengo 574,48 € hoy») rather than an
   * order's cash out (#1329). The builder sets it for the symbol-ful value-only
   * alta, where it filled `pricePerUnit` from a live quote: the user declared the
   * same sentence as the symbol-less case, so the commission must not shrink the
   * figure in one and not the other.
   */
  valueIsBalance?: boolean;
}

export type OpeningResolution =
  | {
      ok: true;
      /** `null` when nothing was declared: the alta creates an empty container. */
      opening: OpeningPlan | null;
      /** Informative, never blocking: the declared terms do not add up. */
      mismatchWarning?: string;
      /**
       * Set when the opening is the 1-participación encoding of a value-only
       * declaration (#1325) — the card's tracking warning must then STOP inviting
       * the user to assign a symbol, because a real quote would revalue the fake
       * unit to a single share's NAV.
       */
      valueOnly?: true;
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
  return formatMoneyMinorExact({ amountMinor, currency: "EUR" });
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
  options: OpeningResolutionOptions = {},
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

  // Value-only (#1325): nothing but the cash amount (and maybe a commission) was
  // declared, and the caller allows it — 1 participación at the declared value.
  // Gated on `pricePerUnit === undefined`, not on it failing to parse: a declared
  // price that does not read is a transcription problem to surface, never to
  // paper over.
  //
  // The commission does NOT come off the value here (#1329, the explicit decision
  // the #1328 review asked for), and this is the ONE branch where it doesn't. The
  // other branches read an ORDER — «pagué 164,64 € por 3 títulos» — where the cash
  // out includes the fee, so the position is worth the amount net of it. A
  // value-only declaration is a BALANCE: «tengo 574,48 € hoy en este fondo», a
  // figure the user is reading off a statement, and any commission was already
  // paid before that number existed. Carving it out would make the app disagree
  // with the document by a euro — the worst possible lie, because it is small
  // enough to look like the app's own arithmetic. The fee still rides on the
  // operation, so the cost basis (units × price + fees) keeps it and the return
  // shows the euro as what it is: a cost, not a shrunken position.
  if (
    options.allowValueOnly === true &&
    pricePerUnit === undefined &&
    units === undefined &&
    openingValueMinor !== undefined
  ) {
    const valueAsPrice = positiveDecimal((openingValueMinor / 100).toString());
    // Unreachable with a validated positive amount, but never assume a parse.
    if (valueAsPrice === null) return { ok: false, error: MISSING_VALUE };
    return {
      ok: true,
      opening: {
        pricePerUnit: valueAsPrice,
        units: "1",
        valueMinor: openingValueMinor,
        ...(fees === undefined ? {} : { feesMinor: fees }),
      },
      valueOnly: true,
      ...oversizedFeeWarning(openingValueMinor, fees),
    };
  }

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

  // No units declared: derive them from the cash amount. For an ORDER the amount
  // includes the commission, so the derivation nets it out and the fee stops
  // inflating the unit count. For a BALANCE (the symbol-ful value-only alta, whose
  // price the builder filled from a live quote) it does not: the same sentence must
  // not mean 574,48 € without a symbol and 573,48 € with one (#1329).
  if (openingValueMinor === undefined) return { ok: false, error: MISSING_VALUE };
  const netMinor =
    options.valueIsBalance === true ? openingValueMinor : openingValueMinor - (fees ?? 0);
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
      // The value of the position the operation WRITES — units × price, from the
      // same engine, not the amount that was declared. Since #1395 the derived
      // units are cut at six decimals, so at a five-figure unit price the two
      // differ by a few cents; carrying the declared amount here would make the
      // impact card promise a figure the persisted operation does not add up to
      // (the #1422 rule: two figures side by side come from the SAME engine).
      // Deliberately silent: the gap this can open is rounding-scale by
      // construction (half a millionth of a unit), so warning about it on every
      // high-priced alta would be noise. A real disagreement between declared
      // terms still gets its `mismatchWarning` — that is the units-declared
      // branch above, where the two figures come from the document itself.
      valueMinor: multiplyToMinor(derived.units, derived.price),
      ...(fees === undefined ? {} : { feesMinor: fees }),
    },
    ...(options.valueIsBalance === true
      ? oversizedFeeWarning(openingValueMinor, fees)
      : {}),
  };
}

/**
 * The tripwire the balance reading would otherwise lose (#1329): under the order
 * reading a commission ≥ the amount was arithmetically impossible and got
 * rejected, which is what caught a euros-for-cents transcription («600» read as
 * 600,00 € next to a 574,48 € balance). A balance cannot be contradicted by a
 * fee, so the alta APPLIES — but it says so, the same way a mismatch does.
 */
function oversizedFeeWarning(
  valueMinor: number,
  fees: number | undefined,
): { mismatchWarning?: string } {
  if (fees === undefined || fees < valueMinor) return {};
  return {
    mismatchWarning: `La comisión (${euros(fees)}) iguala o supera el valor declarado (${euros(valueMinor)}). Doy de alta las dos cifras tal cual, pero comprueba si la comisión venía en céntimos.`,
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
