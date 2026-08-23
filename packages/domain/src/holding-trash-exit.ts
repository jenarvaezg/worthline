/**
 * The generic trash gate (#1549, ADR 0085) — pure rule, one place.
 *
 * Sending a holding to the Papelera is a soft delete, and the app frames it as
 * reversible. For a position that still holds units it is not: the next capture
 * stops counting it, the curve drops by its value, and the histórico records no
 * sale, no traspaso, and no deposit into any account. That is not a hypothesis —
 * it is the Groupama episode (#1365): 7.642 € left a real patrimonio that way, and
 * the rest of the book had no idea where they went.
 *
 * ADR 0085 rejected a «bridge fund» type as the fix, because nobody knew Groupama
 * was a vehicle of transit until it was too late: a type is metadata the owner
 * cannot set a priori. So the protection is GENERIC — every holding with money
 * inside must say where the money went before it can be archived.
 *
 * The door offers three exits, and this module is the arbiter of which one
 * actually unlocks it:
 *
 * - **«Lo vendí»** and **«Lo traspasé a…»** are not keys. They are exits that write
 *   the movement FIRST (a sell, or a #1393 `transfer_out`/`transfer_in` pair), which
 *   leaves the position at zero — and a position at zero was never gated. They are
 *   recorded on the row for the Papelera to say how the holding left, and they open
 *   nothing on their own: a caller that hands us `sold` over a live position is
 *   claiming a sale the ledger does not have.
 * - **«Error de registro»** is the only declaration that archives money still
 *   inside, and it says the value was never real. It is a statement about the book,
 *   so it is stored on the row rather than inferred.
 *
 * There is a second, unrelated reason a holding cannot be trashed, and it lives
 * here because the door is one door: a managed portfolio's CASH sibling (ADR 0085)
 * is the container's own casilla, auto-created by the alta and never a position the
 * owner manages. Its balance is real money (a Metal-sized cartera holds up to
 * 150 € + 0,5 % of its value before investing it), so deleting it in silence is the
 * Groupama shape with another instrument label. It goes away when the portfolio
 * does, not before.
 */

import type { DecimalString } from "./decimal";
import { unitsReadAsClosed } from "./warnings";

/** How a holding left the book, as the trash door recorded it. */
export type TrashExit = "sold" | "transferred" | "mis_entry";

const TRASH_EXITS: readonly string[] = ["sold", "transferred", "mis_entry"];

/**
 * Why the door refused. Two reasons, each with the one fact its message needs —
 * the units still inside, or the portfolio that owns the cash box.
 */
export type HoldingTrashRefusal =
  | { reason: "needs_exit"; netUnits: DecimalString }
  | { reason: "portfolio_cash"; portfolioName: string };

export interface HoldingTrashGateInput {
  /**
   * Net units the holding's ledger folds to today, or `null` when it keeps no
   * ledger at all (a cash account, a flat). `null` is silence, not zero: a holding
   * with no operations says nothing about units and is never gated on them.
   */
  netUnits: DecimalString | null;
  /** The exit the caller declared, if any. */
  exit: TrashExit | null;
  /** Name of the managed portfolio whose cash sibling this is, when it is one. */
  containerPortfolio: string | null;
}

/**
 * The refusal, or `null` when the trash may proceed.
 *
 * The container rule is checked FIRST and no exit overrides it: while the cartera
 * lives, its cash box is not the owner's to archive, and offering him three exits
 * for a row he never created would be three wrong answers instead of one right one.
 */
export function checkHoldingTrashGate({
  containerPortfolio,
  exit,
  netUnits,
}: HoldingTrashGateInput): HoldingTrashRefusal | null {
  if (containerPortfolio) {
    return { portfolioName: containerPortfolio, reason: "portfolio_cash" };
  }

  if (netUnits === null || unitsReadAsClosed(netUnits)) {
    return null;
  }

  return exit === "mis_entry" ? null : { netUnits, reason: "needs_exit" };
}

/** Read an exit off untrusted input (a form field, a JSON payload). */
export function parseTrashExit(value: unknown): TrashExit | null {
  return typeof value === "string" && TRASH_EXITS.includes(value)
    ? (value as TrashExit)
    : null;
}

/** How the Papelera names the exit a trashed row left by. */
export function trashExitLabel(exit: TrashExit): string {
  switch (exit) {
    case "sold":
      return "vendido";
    case "transferred":
      return "traspasado";
    case "mis_entry":
      return "error de registro";
  }
}
