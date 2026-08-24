/**
 * The membership of a managed portfolio: what each member IS, and the arithmetic
 * of the "(sin detallar)" aggregate (ADR 0085, #1551).
 *
 * Its own module because it is the ONE home of a rule three surfaces would
 * otherwise re-derive — the ficha, the store's member preservation, and the
 * careo, which imports it from here rather than classifying types again.
 */

/**
 * How the aggregate member is called: the portfolio's own name plus the label
 * that says what it is not — a detailed composition.
 *
 * The name is the whole signal on the patrimonio board, where the aggregate
 * renders as an ordinary stored holding: nobody reading "Cartera Indexada Metal
 * (sin detallar)" mistakes it for a fund the owner enumerated.
 */
const UNDETAILED_MEMBER_SUFFIX = "(sin detallar)";

export function undetailedMemberName(portfolioName: string): string {
  return `${portfolioName.trim()} ${UNDETAILED_MEMBER_SUFFIX}`;
}

/**
 * An aggregate is only worth creating if it stands for money: a non-positive one
 * represents nothing, and the way to say "there is nothing left undetailed" is to
 * retire it, not to leave a 0 € row inside a live cartera.
 *
 * The domain owns the invariant so every writer meets it (the store calls it at
 * its door); an intake still owns its own parse message, which can say things the
 * invariant cannot — like "or leave it blank and add its funds later".
 */
export function assertUndetailedValueInput(amountMinor: number): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("La parte sin detallar tiene que ser un importe positivo.");
  }
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
  /**
   * The funds the owner enumerated. Called DETAILED, not "investment", on
   * purpose: the careo's `investmentValue` deliberately INCLUDES the aggregate
   * (it is invested money), so one word for two different sets is how a reader
   * ends up subtracting the wrong one.
   */
  detailedHoldingIds: string[];
  /** Members whose holding is no longer live (trashed or hard-gone). */
  unknownHoldingIds: string[];
}

/**
 * Classify a portfolio's membership by what each member IS — never by a stored
 * pointer (ADR 0085: the cash sibling is identified the same way).
 *
 * The roles are mutually exclusive and cover everything: `cash` is the
 * container's box, `investment` is a fund the owner typed, anything else that is
 * live is the stored aggregate — the only non-cash, non-investment member any
 * door in the app can create — and a member with no live holding behind it is
 * named rather than silently dropped.
 */
export function managedPortfolioMemberRoles(
  holdingIds: readonly string[],
  typeByHoldingId: ReadonlyMap<string, string>,
): ManagedPortfolioMemberRoles {
  const roles: ManagedPortfolioMemberRoles = {
    cashHoldingId: null,
    detailedHoldingIds: [],
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
      roles.detailedHoldingIds.push(holdingId);
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
 * Only DETAILED members are subtracted. If the container's cash entered the
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
