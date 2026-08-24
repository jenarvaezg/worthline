import { isDateKeyShaped } from "./dates";
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
export function assertManagedPortfolioWitnessInput(
  witness: ManagedPortfolioWitness,
): void {
  const amountMinor = witness.declaredValue.amountMinor;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("El saldo declarado tiene que ser un importe positivo.");
  }
  if (!isDateKeyShaped(witness.declaredDate)) {
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

/**
 * How the aggregate member is called: the portfolio's own name plus the label
 * that says what it is not — a detailed composition (#1551).
 *
 * The name is the whole signal on the patrimonio board, where the aggregate
 * renders as an ordinary stored holding: nobody reading "Cartera Indexada Metal
 * (sin detallar)" mistakes it for a fund the owner enumerated.
 */
export const UNDETAILED_MEMBER_SUFFIX = "(sin detallar)";

export function undetailedMemberName(portfolioName: string): string {
  return `${portfolioName.trim()} ${UNDETAILED_MEMBER_SUFFIX}`;
}

/** What each member of a portfolio IS, resolved from the live holdings. */
export interface ManagedPortfolioMemberRoles {
  /** The auto-created cash sibling — the container's casilla (ADR 0085). */
  cashHoldingId: string | null;
  /**
   * The "(sin detallar)" aggregate the alta creates when nobody enumerated the
   * composition (#1551), or null when the portfolio was born detailed. The
   * FIRST such member: the alta is the only door that creates one and the
   * member chips only ever offer investments, so a second one cannot be
   * assigned — and if one ever existed it would still render as an ordinary row
   * of the composition, only without the substitution block.
   */
  undetailedHoldingId: string | null;
  /** The funds the owner enumerated — what the witness is careed against. */
  investmentHoldingIds: string[];
  /** Members whose holding is no longer live (trashed or hard-gone). */
  unknownHoldingIds: string[];
}

/**
 * Classify a portfolio's membership by what each member IS — never by a stored
 * pointer (ADR 0085: the cash sibling is identified the same way).
 *
 * The three roles are mutually exclusive and cover everything: `cash` is the
 * container's box, `investment` is a fund the owner typed, and anything else
 * that is live is the stored aggregate — the only non-cash, non-investment
 * member any door in the app can create. One home for the rule so the ficha, the
 * store's member-preservation and the careo cannot come to different answers.
 */
export function managedPortfolioMemberRoles(
  holdingIds: readonly string[],
  typeByHoldingId: ReadonlyMap<string, string>,
): ManagedPortfolioMemberRoles {
  const roles: ManagedPortfolioMemberRoles = {
    cashHoldingId: null,
    investmentHoldingIds: [],
    undetailedHoldingId: null,
    unknownHoldingIds: [],
  };

  for (const holdingId of holdingIds) {
    const type = typeByHoldingId.get(holdingId);
    if (type === undefined) {
      roles.unknownHoldingIds.push(holdingId);
    } else if (type === "cash") {
      roles.cashHoldingId ??= holdingId;
    } else if (type === "investment") {
      roles.investmentHoldingIds.push(holdingId);
    } else {
      roles.undetailedHoldingId ??= holdingId;
    }
  }

  return roles;
}

/**
 * What the aggregate should be left at once some of the composition is detailed
 * (#1551): the declared balance minus the funds already typed.
 *
 * Only INVESTMENT members are subtracted. If the container's cash entered the
 * subtraction the aggregate would come out short by the balance waiting to be
 * invested and the gross patrimonio would drop for no reason (the 23-08 note on
 * #1551) — the declared balance is the market value of the funds, and the cash
 * has never been part of it. The aggregate itself is not subtracted either: it IS
 * the figure being replaced.
 *
 * Clamped at zero: detailing past the declared balance means there is nothing
 * left to stand for, and a negative holding is not a thing. Null without a
 * witness — a suggestion needs a declared total to be a share of.
 */
export function undetailedRemainderMinor(input: {
  declaredMinor: number | null;
  detailedInvestmentMinor: number;
}): number | null {
  if (input.declaredMinor === null) return null;
  return Math.max(0, input.declaredMinor - input.detailedInvestmentMinor);
}
