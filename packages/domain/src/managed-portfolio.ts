import type { ManagedPortfolioWitness } from "./managed-portfolio-reconciliation";

/**
 * Managed portfolio (cartera gestionada) — ADR 0085 / #1399, S1 (#1547).
 *
 * A roboadvisor portfolio is a **grouping entity**, never a holding and never a
 * parent in a hierarchy: its members stay first-class holdings that keep
 * summing into net worth exactly as before. The portfolio's own value is
 * derived (members + the auto-created cash sibling), so nothing here stores a
 * figure of its own — a stored total would drift the moment a member moved.
 *
 * Everything the entity stores is typed by somebody: the name, an optional
 * provider label, and — since S4 (#1550) — the LAST declared balance read in the
 * manager's app. That balance is a reconciliation witness, never a figure the
 * book adopts: the careo itself lives in `managed-portfolio-reconciliation.ts`,
 * where the rule that it excludes the container's cash is documented.
 */

export interface ManagedPortfolio {
  id: string;
  scopeId: string;
  /** What the owner calls it — "Cartera Indexada Metal". */
  name: string;
  /** The manager behind it ("Indexa", "MyInvestor"), when the owner says one. */
  provider: string | null;
  /**
   * The live holdings that are members, including the auto-created cash
   * sibling. Membership is EXCLUSIVE (unique index on the holding): a position
   * lives physically inside one portfolio, so overlap would be a data error —
   * this deliberately differs from goals and allowances, where overlap is a
   * legitimate view.
   */
  holdingIds: string[];
  /**
   * The last balance the owner declared from the manager's app, or null while
   * nobody has typed one. Only the latest: the historical series waits for a
   * connector that can produce it honestly (ADR 0085).
   */
  witness: ManagedPortfolioWitness | null;
}

/** One member's contribution to the portfolio's derived value. */
export interface ManagedPortfolioMemberFigure {
  holdingId: string;
  valueMinor: number;
}

/** One row of the composition: a member, its value, and its weight of the total. */
export interface ManagedPortfolioSlice {
  holdingId: string;
  valueMinor: number;
  /** `value / total` as a 0..1 ratio; null while the total is zero. */
  weight: number | null;
}

export interface ManagedPortfolioFigures {
  totalMinor: number;
  /** Ordered by value, largest first (ties broken by holding id). */
  slices: ManagedPortfolioSlice[];
}

/**
 * The name is the only datum the alta requires; a blank name would leave the
 * portfolio unnameable everywhere it renders (list header, ficha, agent view).
 */
export function assertManagedPortfolioInput(input: { name: string }): void {
  if (!input.name.trim()) {
    throw new Error("La cartera necesita un nombre.");
  }
}

/**
 * A declared balance is only worth storing if it can be careed: a non-positive
 * one has no relative drift to measure against, and the way to say "I have no
 * witness" is to remove it, not to declare zero.
 */
export function assertManagedPortfolioWitnessInput(input: {
  declaredValueMinor: number;
  declaredDate: string;
}): void {
  if (!Number.isInteger(input.declaredValueMinor) || input.declaredValueMinor <= 0) {
    throw new Error("El saldo declarado tiene que ser un importe positivo.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.declaredDate)) {
    throw new Error("El saldo declarado necesita la fecha en la que lo leíste.");
  }
}

/**
 * Derive the portfolio's figures from its members' values. Pure arithmetic:
 * the total is the sum and each weight is the member's share of it — the same
 * Σ filas = total invariant the board holds to, with no plug row anywhere.
 */
export function computeManagedPortfolioFigures(input: {
  members: readonly ManagedPortfolioMemberFigure[];
}): ManagedPortfolioFigures {
  const totalMinor = input.members.reduce((sum, member) => sum + member.valueMinor, 0);

  const slices = [...input.members]
    .sort((a, b) => b.valueMinor - a.valueMinor || a.holdingId.localeCompare(b.holdingId))
    .map((member) => ({
      holdingId: member.holdingId,
      valueMinor: member.valueMinor,
      weight: totalMinor > 0 ? member.valueMinor / totalMinor : null,
    }));

  return { slices, totalMinor };
}
