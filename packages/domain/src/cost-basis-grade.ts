/**
 * How honest an operation's price is AS A COST (#1505, ADR 0048).
 *
 * An alta declares a position that already existed. Since #1490 it ASKS what the
 * position cost and says out loud what an empty answer means («sin coste no habrá
 * plusvalía»), but the answer died with the submit: an apertura written at today's
 * price is byte for byte a purchase made today —
 *
 *   2026-08-19  buy  27 uds @ 217,25  (source: opening)
 *
 * — so the ficha printed «P/L latente 0,00 €» as a fact, the salud de datos could
 * not point at the position, and nobody could ask for the cost again because
 * nothing said it was missing.
 *
 * The grade is what survives the submit. It rides the OPERATION rather than the
 * holding, the way `transferCostMinor` does (#1393, ADR 0082): the cost basis is
 * folded from a ledger, so the fact about how trustworthy that cost is has to
 * travel on the rows it is folded from — a column on the holding would go stale
 * the moment a real buy is added on top.
 *
 * Two values, and a THIRD state that is the absence of both:
 *
 * - absent → the price is the row's own fact: a real dated movement (a buy, a
 *   sell, a statement order). ADR 0048 calls that grade `movements`. It is also
 *   what every row written before #1505 carries, including the aperturas whose
 *   cost nobody knows — see the v65 migration for why none of them is guessed at.
 * - `declared_cost` → somebody stated this cost. The alta asked and was answered.
 * - `value_only` → NOBODY stated it. The price is what the position is WORTH
 *   today, standing in for a cost, and every figure derived from it (plusvalía
 *   latente, ganancia simple, IRR) is arithmetic over a number nobody declared.
 *
 * Pure: a vocabulary, its es-ES reading, and the ranking `derivePosition` folds
 * with. No store, no clock.
 */

/** The grade of a stated cost; `undefined` is the third state — see the module docs. */
export type CostBasisGrade = "declared_cost" | "value_only";

/**
 * The es-ES mark, the SAME words the reconcile row already speaks (`reconcileFidelityMark`,
 * decisión #1090): a user must not meet two names for one idea because one lives in
 * the chat and the other on the ficha.
 */
export function costBasisGradeMark(grade: CostBasisGrade): string {
  return grade === "declared_cost" ? "coste declarado" : "sin coste real";
}

/**
 * What the ficha says INSTEAD of a latent P/L when no cost was ever declared.
 *
 * It replaces the figure rather than annotating it: «0,00 €» with a footnote is
 * still a claim that the position has neither gained nor lost, which is precisely
 * the thing that is not known.
 */
export const VALUE_ONLY_PNL_NOTICE =
  "Sin coste real: el alta se escribió al valor de ese día porque nadie declaró lo que costó. " +
  "No hay plusvalía latente que calcular, y las demás medidas se apoyan en ese mismo coste.";

/**
 * Worst-first ranking. `value_only` beats `declared_cost` beats absent, because a
 * cost basis is only as honest as its least honest contribution: one apertura
 * without a cost taints the average the whole position is measured against.
 */
const GRADE_RANK: Record<CostBasisGrade, number> = {
  declared_cost: 1,
  value_only: 2,
};

/** The less honest of two grades — the fold's accumulator step. */
export function worseCostBasisGrade(
  left: CostBasisGrade | undefined,
  right: CostBasisGrade | undefined,
): CostBasisGrade | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return GRADE_RANK[left] >= GRADE_RANK[right] ? left : right;
}
