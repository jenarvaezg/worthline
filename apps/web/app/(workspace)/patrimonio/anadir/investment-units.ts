import { normalizeNonNegativeDecimalString } from "@web/intake-primitives";
import {
  type DecimalString,
  divideUnits,
  formatUnits,
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
 * Pure and es-ES aware (reuses the intake money normalization). Failures come back
 * as Spanish messages the action redirects with and the island shows while typing.
 */

/**
 * Decimals a derived unit count is cut at (#1395) — this capture's name for the app's
 * units reading voice, `UNITS_READBACK_DECIMALS`. `divideUnits` defaults to 20 —
 * right for recovering a NAV from an amount (ADR 0018), wrong for participaciones:
 * a fund balance over a 319,59 € NAV landed as `3,40996276479239025001` (#1393), a
 * precision no bank publishes and that the app itself cannot read back
 * (`formatUnits` renders at most six decimals). Six is that reading voice, so what
 * the hint shows IS what gets stored.
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

/** The resolved «Fecha del saldo», or the Spanish message refusing it. */
export type OpeningDateResult = { ok: true; date: string } | { ok: false; error: string };

/** Everything the opening BUY needs, or the ONE message that refused the capture. */
export type OpeningCaptureResult =
  | { ok: true; units: DecimalString; price: DecimalString; executedAt: string }
  | { ok: false; error: string };

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

const INVALID_DATE = "La fecha del saldo no es válida: elígela en el calendario.";
const FUTURE_DATE = "La fecha del saldo no puede ser futura.";

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

/**
 * The whole capture resolved in ONE call — units, price and the date they are
 * stamped with — so the action has a single failure to redirect with instead of
 * two results to keep in step. Nothing is persisted before this answers.
 */
export function resolveOpeningCapture({
  dateRaw,
  priceRaw,
  saldoRaw,
  today,
}: {
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

  return { ok: true, executedAt: date.date, price: units.price, units: units.units };
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
   * The es-ES reading of the saldo date when it is a valid PAST one, else null. The
   * pane re-labels itself off this: a backdated saldo is a balance at that date, so
   * the price it is divided by is that date's NAV — not the live quote the field
   * was prefilled with. Saying it is the whole guard: nothing else can tell the two
   * apart, and dividing an old balance by today's price writes a unit count that is
   * wrong forever.
   */
  backdatedTo: string | null;
  /**
   * What to say under the price field instead of its usual hint, or null to keep
   * that hint. Non-null only for a backdated saldo — and it CHECKS rather than
   * warns: when the price still is, character for character, the live quote the
   * field was prefilled with, it says so, because that is the exact state in which
   * the units come out wrong.
   */
  priceNote: string | null;
}

/**
 * The pane's copy, derived from the same helpers the action writes with: the units
 * exactly as they will be persisted, and — when the saldo is dated in the past —
 * every label re-read against that date. A date the action would refuse takes the
 * hint over with that refusal's own message, so the correction happens before the
 * submit instead of after a round-trip.
 */
export function openingCaptureCopy({
  dateRaw,
  livePriceRaw,
  priceRaw,
  saldoRaw,
  today,
}: {
  dateRaw: string;
  /** The provider quote the price field was prefilled with, when there was one. */
  livePriceRaw?: string | undefined;
  priceRaw: string;
  saldoRaw: string;
  today: string;
}): OpeningCaptureCopy {
  // The date leads: it changes what the two money fields MEAN, so a refusal here
  // has to surface even before there is a saldo to derive from. The action reads
  // them the other way round (money first) because there the missing figure is the
  // one that blocks the alta; both refuse the same captures, and each names the
  // field the user is looking at.
  const date = resolveOpeningDate(dateRaw, today);
  if (!date.ok) {
    return { backdatedTo: null, hint: date.error, priceNote: null, refused: true };
  }

  const backdatedTo = date.date === today ? null : readOpeningDate(date.date);
  const priceNote =
    backdatedTo === null
      ? null
      : (livePriceRaw ?? "").trim() !== "" && priceRaw.trim() === livePriceRaw?.trim()
        ? `Ese precio es el de HOY, en vivo: cámbialo por el valor liquidativo del ${backdatedTo}.`
        : `Pon el valor liquidativo del ${backdatedTo}, no el de hoy: de ahí salen las participaciones.`;
  const units = deriveOpeningUnits({ priceRaw, saldoRaw });

  if (!units.ok) {
    return {
      backdatedTo,
      hint: "Escribe el saldo para ver las participaciones.",
      priceNote,
      refused: false,
    };
  }

  const reading = `≈ ${formatUnits(units.units)} participaciones`;

  return {
    backdatedTo,
    hint:
      backdatedTo === null
        ? `${reading}.`
        : `${reading} al ${backdatedTo} — reconstruiremos el histórico desde ese día.`,
    priceNote,
    refused: false,
  };
}
