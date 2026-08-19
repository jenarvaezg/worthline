import { normalizeNonNegativeDecimalString } from "@web/intake-primitives";
import {
  CONVERTED_PRICE_DECIMALS,
  type DecimalString,
  divideUnits,
  formatMoneyMinorExact,
  formatUnits,
  multiplyToMinor,
  UNITS_READBACK_DECIMALS,
} from "@worthline/domain";

/**
 * The "saldo de hoy" capture (#597, PRD #593 S2): a user who only knows what an
 * investment is *worth* enters a euro balance + the unit price; the units are
 * `saldo ÷ precio`. The single source of that math, shared by the server action
 * (which records the opening BUY from it) and the client island — so the preview
 * can never drift from what gets persisted.
 *
 * Since #1395 the module owns the other two facts of the same capture: the
 * precision the derived units are cut at, and the DATE the saldo is read at
 * («Fecha del saldo», optional, today by default). All three live here because the
 * island's hint and the action's write must agree about all three, and a second
 * home for any of them is a second answer.
 *
 * Since #1490 it owns the fourth: the **coste de adquisición**. What an alta declares
 * is a position that ALREADY EXISTED, and the capture used to state only what it is
 * worth — so the opening BUY was written at today's price and dated today. Jorge's 27
 * uds of the SXR1 landed as «comprado hoy por 5.865,75 €»: his 865,89 € of latent
 * gain vanished, and August grew a 5.865,75 € contribution he never made. The two
 * figures are now asked for separately and mean different things:
 *
 * - the **saldo and the price are today's** — they are what the position is WORTH, and
 *   they are what the units come from (they always were);
 * - the **coste** is what it COST, and it is the price the opening operation carries;
 * - the **date** is since when it is held, so the ripple rebuilds the history from
 *   there (ADR 0020) instead of pretending the position was born on the day it was
 *   typed.
 *
 * A cost nobody knows stays EMPTY (ADR 0048): the opening then falls back to today's
 * price, exactly as before — but as something the user chose after being asked, with
 * the pane saying out loud that there will be no plusvalía. Never a cost invented for
 * him.
 *
 * Pure and es-ES aware (reuses the intake money normalization). Failures come back
 * as Spanish messages the action redirects with and the island shows while typing.
 */

/**
 * Decimals a derived unit count is cut at (#1395) — this capture's name for the app's
 * units reading voice, `UNITS_READBACK_DECIMALS`. `divideUnits` takes an explicit
 * scale: `PRICE_READBACK_DECIMALS` for a derived NAV (ADR 0018, #1467), this six for
 * participaciones. A fund balance over a 319,59 € NAV used to land as
 * `3,40996276479239025001` (#1393), a precision no bank publishes and that the app
 * itself cannot read back (`formatUnits` renders at most six decimals). Six is that
 * reading voice, so what the hint shows IS what gets stored.
 *
 * The cut is not free: it moves the position by up to half a millionth of a unit,
 * which at a five-figure unit price is a few cents (1.234,56 € of BTC at 100.000 €
 * folds back as 1.234,60 €). Bounded, one-off, and against a live quote that moves
 * more than that by the minute — but it must never be SILENT: any consumer that
 * shows a value next to these units derives it from them (see the derived branch of
 * `asistente/holding-creation-opening.ts`), never from the amount that was typed.
 */
export const OPENING_UNITS_DECIMALS = UNITS_READBACK_DECIMALS;

export interface OpeningUnitsInput {
  saldoRaw: string;
  priceRaw: string;
}

export type OpeningUnitsResult =
  | { ok: true; units: DecimalString; price: DecimalString }
  | { ok: false; reason: "saldo" | "price" };

/** The resolved «¿Desde cuándo la tienes?», or the Spanish message refusing it. */
export type OpeningDateResult = { ok: true; date: string } | { ok: false; error: string };

/**
 * How the user states the acquisition cost (#1490). Both are the same fact seen from
 * two sides, and a broker states one or the other: DEGIRO prints a «precio medio»,
 * a bank statement prints the total paid. Neither is derivable from the app's own
 * data, so both are accepted and the pane echoes the other one back.
 */
export type OpeningCostMode = "total" | "unit";

/** The resolved acquisition cost: absent, declared, or refused. */
export type OpeningCostResult =
  | { ok: true; declared: false }
  | { ok: true; declared: true; pricePerUnit: DecimalString; costMinor: number }
  | { ok: false; error: string };

/** Everything the opening BUY needs, or the ONE message that refused the capture. */
export type OpeningCaptureResult =
  | { ok: true; units: DecimalString; price: DecimalString; executedAt: string }
  | { ok: false; error: string };

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

const INVALID_DATE = "La fecha de la posición no es válida: elígela en el calendario.";
const FUTURE_DATE = "No puedes tener la posición desde una fecha futura.";
const INVALID_COST =
  "El coste de adquisición no se lee: escríbelo como 4.999,86 — o déjalo vacío si no lo sabes.";

function positiveDecimal(raw: string): DecimalString | null {
  const normalized = normalizeNonNegativeDecimalString(raw);
  if (normalized === null || Number.parseFloat(normalized) === 0) {
    return null;
  }
  return normalized as DecimalString;
}

export function deriveOpeningUnits({
  priceRaw,
  saldoRaw,
}: OpeningUnitsInput): OpeningUnitsResult {
  const price = positiveDecimal(priceRaw);
  if (price === null) {
    return { ok: false, reason: "price" };
  }

  const saldo = positiveDecimal(saldoRaw);
  if (saldo === null) {
    return { ok: false, reason: "saldo" };
  }

  return {
    ok: true,
    price,
    units: divideUnits(saldo, price, OPENING_UNITS_DECIMALS) as DecimalString,
  };
}

/** The Spanish guidance for a derivation that lacks a price or a saldo (#597). */
export function openingUnitsErrorMessage(reason: "saldo" | "price"): string {
  return reason === "price"
    ? "Necesito el precio por unidad para calcular las participaciones. Búscalo o escríbelo a mano."
    : "Indica cuánto tienes hoy en euros.";
}

/**
 * The date the opening BUY is stamped with (#1395). Blank means today — the
 * pre-#1395 behavior, byte for byte — so the field can stay optional. A past date
 * is what the alta is FOR: a traspaso executed weeks ago used to land dated today,
 * leaving the net worth with a hole between the exit and the re-entry; the
 * backdated operation makes the ripple rebuild the history from that day (ADR
 * 0020). A future date is refused: a saldo you have not had yet is not history, and
 * the ripple would have nothing to reconstruct.
 *
 * The calendar is checked, not just the shape: `2026-02-30` passes any `\d{4}-\d{2}
 * -\d{2}` regex and is lexicographically ≤ today, yet it is not a day — it would
 * land as an `executed_at` (and a snapshot `dateKey`) that no calendar can read
 * back, while the hint next to it said «2 mar». The round-trip through `Date` is the
 * repo's established test for a real day (`import-balance-history.ts`).
 */
export function resolveOpeningDate(dateRaw: string, today: string): OpeningDateResult {
  const raw = dateRaw.trim();
  if (raw === "") {
    return { ok: true, date: today };
  }

  if (!ISO_DATE_SHAPE.test(raw)) {
    return { ok: false, error: INVALID_DATE };
  }

  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return { ok: false, error: INVALID_DATE };
  }

  return raw > today ? { ok: false, error: FUTURE_DATE } : { ok: true, date: raw };
}

/** The form's cost mode, read closed — anything unrecognized is the total (#1490). */
export function parseOpeningCostMode(raw: string): OpeningCostMode {
  return raw.trim() === "unit" ? "unit" : "total";
}

/**
 * The acquisition cost as a unit price — the figure the opening BUY carries (#1490).
 *
 * Blank is the honest answer, not a hole to fill: it comes back `declared: false` and
 * the caller falls back to today's price. Whatever arrives is checked, never rounded
 * into shape; a cost that does not read is refused so the correction happens before
 * anything is written (ADR 0048).
 *
 * A **total** is divided by the units at {@link CONVERTED_PRICE_DECIMALS} — the same
 * eight decimals a converted price is cut at, and the scale every provider quote is
 * already rounded to. The cut has to be finer than the units' six: `units × price` is
 * what the ficha re-reads as the cost basis, and cutting the price at six decimals
 * would move a four-figure cost by a cent for no reason. A **unit** price is stored as
 * typed, and the total is then whatever it multiplies out to — the user's own figure,
 * not one the app re-derived.
 */
export function resolveOpeningCost({
  costMode,
  costRaw,
  units,
}: {
  costMode: OpeningCostMode;
  costRaw: string;
  units: DecimalString;
}): OpeningCostResult {
  if (costRaw.trim() === "") {
    return { declared: false, ok: true };
  }

  const cost = positiveDecimal(costRaw);
  if (cost === null) {
    return { error: INVALID_COST, ok: false };
  }

  const pricePerUnit =
    costMode === "unit"
      ? cost
      : (divideUnits(cost, units, CONVERTED_PRICE_DECIMALS) as DecimalString);

  if (Number.parseFloat(pricePerUnit) === 0) {
    // A cost so small next to the units that it folds to a zero price is not a cost
    // the book can hold: an operation at 0 € would read as a gift, not as a purchase.
    return { error: INVALID_COST, ok: false };
  }

  return {
    costMinor: multiplyToMinor(units, pricePerUnit),
    declared: true,
    ok: true,
    pricePerUnit,
  };
}

/**
 * The whole capture resolved in ONE call — units, the price the opening is written at
 * and the date it is stamped with — so the action has a single failure to redirect
 * with instead of three results to keep in step. Nothing is persisted before this
 * answers.
 *
 * The price it returns is the **cost** price when one was declared (#1490) and today's
 * price otherwise. The units never change: they come from what the position is worth
 * today, which is the only figure that fixes how many participaciones there are.
 */
export function resolveOpeningCapture({
  costMode,
  costRaw,
  dateRaw,
  priceRaw,
  saldoRaw,
  today,
}: {
  costMode: OpeningCostMode;
  costRaw: string;
  dateRaw: string;
  priceRaw: string;
  saldoRaw: string;
  today: string;
}): OpeningCaptureResult {
  const units = deriveOpeningUnits({ priceRaw, saldoRaw });
  if (!units.ok) {
    return { ok: false, error: openingUnitsErrorMessage(units.reason) };
  }

  const date = resolveOpeningDate(dateRaw, today);
  if (!date.ok) {
    return { ok: false, error: date.error };
  }

  const cost = resolveOpeningCost({ costMode, costRaw, units: units.units });
  if (!cost.ok) {
    return { ok: false, error: cost.error };
  }

  return {
    ok: true,
    executedAt: date.date,
    price: cost.declared ? cost.pricePerUnit : units.price,
    units: units.units,
  };
}

/** es-ES reading of a saldo date for the pane's copy: "31 jul 2026". */
function readOpeningDate(dateKey: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${dateKey}T00:00:00.000Z`));
}

/** What the saldo pane says while you type it (#1395). */
export interface OpeningCaptureCopy {
  /** The live `≈ participaciones` reading, or the message refusing the capture. */
  hint: string;
  /** True when `hint` is a refusal — the island shows it as one. */
  refused: boolean;
  /**
   * The es-ES reading of the date the position is held since, when it is a valid PAST
   * one, else null. The pane reads it back so the user sees that a backdated alta
   * rebuilds the history from that day instead of starting today (#1395, ADR 0020).
   */
  backdatedTo: string | null;
  /**
   * What the declared cost means, in euros, or null while there are no units to
   * spread it over. The one thing that turns #1490 from a field into an answer: it
   * echoes the OTHER side of the cost (a total read back as a unit price, or the
   * reverse) and the latent gain the position has been carrying unseen. Empty says
   * so too — a cost nobody knows is a state to name, not a blank.
   */
  costNote: string | null;
}

/** Cents-precise es-ES euros: a cost of 4.999,86 € may not read as «5.000 €». */
function euros(amountMinor: number): string {
  return formatMoneyMinorExact({ amountMinor, currency: "EUR" });
}

/**
 * The latent P/L the declared cost reveals, as the ficha will show it: today's value
 * (units × the price the user typed, the SAME figures the write uses — #1422) minus
 * what the position cost. Signed the way the repo signs a delta: `+` when it is a
 * gain, the formatter's own `-` when it is a loss.
 */
function latentPnlReading(valueMinor: number, costMinor: number): string {
  const pnlMinor = valueMinor - costMinor;
  if (pnlMinor === 0) return "ni plusvalía ni minusvalía: vale justo lo que costó";
  const label = pnlMinor > 0 ? "plusvalía" : "minusvalía";
  const amount = pnlMinor > 0 ? `+${euros(pnlMinor)}` : euros(pnlMinor);
  return `${label} latente ${amount}`;
}

/**
 * The pane's copy, derived from the same helpers the action writes with: the units
 * exactly as they will be persisted, the date they are stamped with, and what the
 * declared cost adds up to. A date or a cost the action would refuse takes the hint
 * over with that refusal's own message, so the correction happens before the submit
 * instead of after a round-trip.
 */
export function openingCaptureCopy({
  costMode,
  costRaw,
  dateRaw,
  priceRaw,
  saldoRaw,
  today,
}: {
  costMode: OpeningCostMode;
  costRaw: string;
  dateRaw: string;
  priceRaw: string;
  saldoRaw: string;
  today: string;
}): OpeningCaptureCopy {
  // The date leads: it decides whether the alta rebuilds history, so a refusal here
  // has to surface even before there is a saldo to derive from. The action reads
  // them the other way round (money first) because there the missing figure is the
  // one that blocks the alta; both refuse the same captures, and each names the
  // field the user is looking at.
  const date = resolveOpeningDate(dateRaw, today);
  if (!date.ok) {
    return { backdatedTo: null, costNote: null, hint: date.error, refused: true };
  }

  const backdatedTo = date.date === today ? null : readOpeningDate(date.date);
  const units = deriveOpeningUnits({ priceRaw, saldoRaw });

  if (!units.ok) {
    // No units yet: a cost cannot be spread over them, and inviting the saldo is the
    // one instruction that unblocks everything else. A cost typed first is neither
    // read back nor refused here — the submit still refuses it, in the same words.
    return {
      backdatedTo,
      costNote: null,
      hint: "Escribe el saldo para ver las participaciones.",
      refused: false,
    };
  }

  const cost = resolveOpeningCost({ costMode, costRaw, units: units.units });
  if (!cost.ok) {
    return { backdatedTo, costNote: null, hint: cost.error, refused: true };
  }

  const reading = `≈ ${formatUnits(units.units)} participaciones`;

  return {
    backdatedTo,
    costNote: cost.declared
      ? `${
          costMode === "unit"
            ? `${euros(cost.costMinor)} de coste total`
            : `${euros(multiplyToMinor("1" as DecimalString, cost.pricePerUnit))} por participación`
        } · ${latentPnlReading(multiplyToMinor(units.units, units.price), cost.costMinor)}.`
      : backdatedTo === null
        ? "Sin coste no habrá plusvalía: la posición nace valiendo lo que vale hoy."
        : `Sin coste no habrá plusvalía, y el histórico desde el ${backdatedTo} se reconstruye al precio de hoy.`,
    hint:
      backdatedTo === null
        ? `${reading}.`
        : `${reading} al ${backdatedTo} — reconstruiremos el histórico desde ese día.`,
    refused: false,
  };
}
