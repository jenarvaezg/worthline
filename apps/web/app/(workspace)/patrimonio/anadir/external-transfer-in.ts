import { mapDomainViolation } from "@web/intake";
import {
  normalizeNonNegativeDecimalString,
  parseMoneyMinor,
} from "@web/intake-primitives";
import type { DecimalString } from "@worthline/domain";
import { formatUnits, planExternalTransferIn } from "@worthline/domain";

import {
  euros,
  latentPnlReading,
  readOpeningDate,
  resolveOpeningDate,
} from "./investment-units";

/**
 * The «viene traspasada de otra entidad» capture (#1541, S6 of PRD #1393): the third
 * way the alta can answer «cuánto tengo», beside «sé cuánto tengo hoy» and «tengo el
 * extracto del bróker».
 *
 * Why it is an ALTA and not the «Traspasar» screen of #1480. There is no origin in
 * this book — the outgoing half belongs to MyInvestor's ledger, or ING's — so there
 * is no ficha to start from and nothing to fold. What arrives is a first-class HALF
 * (ADR 0083, decision 7), not a degraded pair, and the engine for it has existed
 * since #1479 (`planExternalTransferIn` / `recordExternalTransferIn`) with no caller
 * outside `packages/db`. This module is the missing product path.
 *
 * Why it must not be a `buy`. Jorge did exactly this on 23-ene-2026 («Traer plan
 * desde otra entidad», 95,46 €) and will again; that row is in production and the
 * 19-ago retyping pass had to hand-write it. Recorded as a purchase it would eat a
 * year of contribution allowance (ADR 0080) for capital that merely moved — the very
 * miscount that printed «te has pasado 2.127 €» in his cupo panel.
 *
 * Why the preview runs the GATE's own plan. `planExternalTransferIn` is the function
 * behind the write, so the participaciones this pane prints are the participaciones
 * that get stored, cut at the same precision, and a figure it refuses is refused here
 * in the same words. A client-side lookalike is what #1438 measured (266 wrong
 * snapshots), and the sibling `transfer-form.ts` already resolves it this way.
 *
 * Pure and es-ES aware. Failures come back as Spanish messages the action redirects
 * with and the island shows while typing.
 */

/** The pane's four fields, exactly as posted. */
export interface ExternalTransferCaptureInput {
  /** The importe that ARRIVED, in euros as typed. */
  amountRaw: string;
  /** The acquisition cost those participaciones carry. Blank = the importe. */
  costRaw: string;
  /** The day the capital landed. Blank = today. */
  dateRaw: string;
  /** The destination's VL on that day. */
  priceRaw: string;
  today: string;
}

/** Everything `recordExternalTransferIn` needs, or the ONE message that refused it. */
export type ExternalTransferCaptureResult =
  | {
      ok: true;
      amountMinor: number;
      executedAt: string;
      inheritedCostMinor: number;
      pricePerUnit: DecimalString;
      /** Derived by the gate's own plan — what the row will actually hold. */
      units: DecimalString;
    }
  | { ok: false; error: string };

/**
 * The ids the PREVIEW hands the plan. They never reach a store: the plan needs a
 * destination and an operation id to shape the row it returns, and this module is
 * only ever asked for the figures inside it. The action mints the real ones (#1394).
 */
const PREVIEW_IDS = {
  destinationAssetId: "__external_transfer_preview_destination__",
  inOperationId: "__external_transfer_preview_operation__",
  transferId: "__external_transfer_preview__",
} as const;

const UNREADABLE_AMOUNT =
  "El importe que entró no se lee: escríbelo como 95,46 — es lo que llegó a la nueva entidad.";
const UNREADABLE_COST =
  "El coste de adquisición no se lee: escríbelo como 95,46 — o déjalo vacío si no lo sabes.";

/**
 * Resolve the pane into the entry that will be written, or the message refusing it.
 *
 * The order is deliberate. The DATE leads, because an impossible day must be caught
 * before anything else is judged (and because it is the field the copy leans on).
 * Then the two figures the plan cannot see as text — an importe or a cost that is not
 * a number at all — and finally the plan itself, which owns every refusal about the
 * VALUES: a non-positive importe, a VL of zero, a negative inherited cost. Those come
 * back in the gate's own words through `mapDomainViolation`, so the pane, the action
 * and the store can never disagree about why a traspaso was refused.
 */
export function resolveExternalTransferCapture(
  input: ExternalTransferCaptureInput,
): ExternalTransferCaptureResult {
  const date = resolveOpeningDate(input.dateRaw, input.today);
  if (!date.ok) {
    return { error: date.error, ok: false };
  }

  const amountMinor = parseMoneyMinor(input.amountRaw);
  if (amountMinor === null) {
    return { error: UNREADABLE_AMOUNT, ok: false };
  }

  const cost = resolveInheritedCost(input.costRaw);
  if (!cost.ok) {
    return { error: cost.error, ok: false };
  }

  // A VL that is not a number reaches the plan as "0", which it refuses with the
  // message about the valor liquidativo — the same one an actual zero earns. Two
  // messages for «no me has dado un VL» would be two answers to one question.
  const pricePerUnit = normalizeNonNegativeDecimalString(input.priceRaw) ?? "0";

  const plan = planExternalTransferIn({
    ...PREVIEW_IDS,
    amountMinor,
    currency: "EUR",
    destinationPricePerUnit: pricePerUnit as DecimalString,
    executedAt: date.date,
    ...(cost.inheritedCostMinor === undefined
      ? {}
      : { inheritedCostMinor: cost.inheritedCostMinor }),
  });

  if (!plan.ok) {
    return { error: mapDomainViolation(plan.violations[0]), ok: false };
  }

  // The plan already applied the default (the importe that arrived) and refused a
  // negative one, so this is the figure the row carries — never re-derived here, or
  // the default would have two homes. Its absence is a bug upstream, not a shape the
  // ledger supports (CONTEXT.md, «Inherited cost»), so it throws rather than guessing.
  const { transferCostMinor } = plan.value;
  if (transferCostMinor === undefined) {
    throw new Error(
      "planExternalTransferIn returned a transfer_in with no inherited cost.",
    );
  }

  return {
    amountMinor,
    executedAt: date.date,
    inheritedCostMinor: transferCostMinor,
    ok: true,
    pricePerUnit: plan.value.pricePerUnit,
    units: plan.value.units,
  };
}

/**
 * The declared inherited cost, or `undefined` for «no lo sé» — which is an answer,
 * not a hole: the plan then books the importe that arrived, so the entry carries no
 * latent gain nobody measured. Unlike the alta's «¿cuánto te costó?» (#1490) there is
 * no total-vs-unit choice to make: what the old provider states, and what the row
 * stores, is one total.
 */
function resolveInheritedCost(
  costRaw: string,
): { ok: true; inheritedCostMinor?: number } | { ok: false; error: string } {
  if (costRaw.trim() === "") {
    return { ok: true };
  }

  const costMinor = parseMoneyMinor(costRaw);
  if (costMinor === null) {
    return { error: UNREADABLE_COST, ok: false };
  }

  return { inheritedCostMinor: costMinor, ok: true };
}

/** What the pane says while you type it — the sibling of `openingCaptureCopy`. */
export interface ExternalTransferCaptureCopy {
  /** The live `≈ participaciones` reading, or the message refusing the capture. */
  hint: string;
  /** True when `hint` is a refusal — the island shows it as one. */
  refused: boolean;
  /**
   * What the cost field says, always: the latent P/L a declared cost reveals, what
   * leaving it empty MEANS (naming the figure it defaults to), or the refusal that
   * the submit would answer with — beside the field it is about.
   */
  costNote: string;
  /** True when `costNote` is a refusal. */
  costRefused: boolean;
}

/**
 * The pane's copy, derived from the same call the write makes, so it can never
 * promise an entry the action refuses.
 *
 * The two readings are independent on purpose: a cost that does not read must not
 * blank the participaciones above it, and a missing importe must not swallow the
 * explanation of what the cost field is for.
 */
export function externalTransferCaptureCopy(
  input: ExternalTransferCaptureInput,
): ExternalTransferCaptureCopy {
  const date = resolveOpeningDate(input.dateRaw, input.today);
  const backdatedTo =
    date.ok && date.date !== input.today ? readOpeningDate(date.date) : null;

  // The figures WITHOUT the cost: the participaciones and the default the cost note
  // has to name are facts of the importe and the VL alone, so an unreadable cost
  // still leaves both readable.
  const withoutCost = resolveExternalTransferCapture({ ...input, costRaw: "" });
  const costNote = readCostNote(input, withoutCost);

  if (!date.ok) {
    return { ...costNote, hint: date.error, refused: true };
  }

  if (input.amountRaw.trim() === "") {
    return {
      ...costNote,
      hint: "Escribe el importe que entró para ver las participaciones.",
      refused: false,
    };
  }

  if (!withoutCost.ok) {
    return { ...costNote, hint: withoutCost.error, refused: true };
  }

  const reading = `≈ ${formatUnits(withoutCost.units)} participaciones`;

  return {
    ...costNote,
    hint:
      backdatedTo === null
        ? `${reading}.`
        : `${reading} al ${backdatedTo} — reconstruiremos el histórico desde ese día.`,
    refused: false,
  };
}

type CostNote = Pick<ExternalTransferCaptureCopy, "costNote" | "costRefused">;

function readCostNote(
  input: ExternalTransferCaptureInput,
  withoutCost: ExternalTransferCaptureResult,
): CostNote {
  const cost = resolveInheritedCost(input.costRaw);
  if (!cost.ok) {
    return { costNote: cost.error, costRefused: true };
  }

  if (!withoutCost.ok) {
    // No readable importe yet, so there is no figure to compare a cost against and
    // no default to name. The field can only say what it is FOR; the submit still
    // refuses an unreadable cost, in the same words.
    return {
      costNote: "Lo que costaron en la entidad anterior. Vacío = el importe que entró.",
      costRefused: false,
    };
  }

  if (cost.inheritedCostMinor === undefined) {
    return {
      costNote: `Vacío: esas participaciones entran costando los ${euros(withoutCost.amountMinor)} que llegaron, sin plusvalía latente inventada.`,
      costRefused: false,
    };
  }

  const declared = resolveExternalTransferCapture(input);
  if (!declared.ok) {
    return { costNote: declared.error, costRefused: true };
  }

  return {
    costNote: `${euros(declared.inheritedCostMinor)} de coste heredado · ${latentPnlReading(
      declared.amountMinor,
      declared.inheritedCostMinor,
    )}.`,
    costRefused: false,
  };
}
