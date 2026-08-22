/**
 * Managed portfolio (cartera gestionada) — ADR 0085 / #1399, S1 (#1547).
 *
 * A roboadvisor portfolio is a **grouping entity**, never a holding and never a
 * parent in a hierarchy: its members stay first-class holdings that keep
 * summing into net worth exactly as before. The portfolio's own value is
 * derived (members + the auto-created cash sibling), so nothing here stores a
 * figure of its own — a stored total would drift the moment a member moved.
 *
 * The declared balance read in the manager's app is a reconciliation witness,
 * which arrives in S4; until then the entity carries only what somebody typed:
 * the name and an optional provider label.
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
