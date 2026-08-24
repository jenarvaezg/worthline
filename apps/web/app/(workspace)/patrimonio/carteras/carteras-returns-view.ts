import type {
  CurrencyCode,
  DatedPayout,
  HoldingReturnsView,
  InvestmentOperation,
  ManagedPortfolio,
  MoneyMinor,
  MonthlyCloseValue,
  SubsetReturnsSlice,
} from "@worthline/domain";
import {
  buildPortfolioReturnsView,
  formatMoneyMinor,
  managedPortfolioMemberRoles,
  managedPortfolioMemberValues,
  reconcileManagedPortfolio,
  subsetReturns,
} from "@worthline/domain";

/**
 * The return of a managed portfolio (#1552, ADR 0085) — the «+11,32 %» the owner
 * reads in the manager's app, measured by the SAME engine every other return in
 * the app rides (`subsetReturns`, the one the per-class decomposition uses).
 *
 * Nothing here computes a rate: this module decides WHICH members are measured
 * and hands the engine their ledgers, their values and their monthly closes. The
 * two rules it owns:
 *
 * - **The cash box is outside the return.** It is inside the portfolio's VALUE (a
 *   member is a member) but it has no cost of acquisition and does not quote:
 *   inside a TWR it is pure drag, and variable drag at that — the container
 *   accumulates cash up to `150 € + 0,5 %` and empties it at every contribution.
 *   The manager's own figure excludes it, so including it would make the careo of
 *   the two numbers meaningless (ADR 0085's 23-08 amendment).
 * - **What cannot be measured is NAMED, never quietly folded in.** A member with
 *   no operations — the "(sin detallar)" aggregate of #1551 is a stored-valuation
 *   holding, so it has none — has no ledger to derive a return from; it stays in
 *   the portfolio's value and out of this figure, and the block says how much of
 *   the cartera that leaves unmeasured. Same for a member held in another
 *   currency, which the careo excludes for the same reason (#1401).
 *
 * The traspasos between two members cancel inside the engine, on their own date
 * (ADR 0082): moving money from one fund of the cartera to another is not capital
 * the cartera received, and counting it as such would halve the return ratio.
 */

export interface PortfolioReturnView {
  /** The measures themselves: simple gain, IRR and TWR, with their caveats. */
  view: HoldingReturnsView;
  /** What the measured members cost — the «invertido» the manager's app prints. */
  investedMinor: number;
  /** The gain in money — the «plusvalía» beside it. */
  gainMinor: number;
  /** Today's value of the members that ARE measured. */
  coveredMinor: number;
  /**
   * The invested value that is NOT measured: the "(sin detallar)" aggregate, or a
   * member with no operations. It counts in the cartera's value, not in the rate.
   */
  uncoveredMinor: number;
  /** The container's cash — in the value, out of the return. */
  cashMinor: number;
  /** How many members the figure is built from. */
  measuredCount: number;
  /** Members left out because they hold no honest value in the base currency. */
  excludedForeignCount: number;
  /**
   * What past sells returned to the pocket. Non-zero means the rate below and
   * the one the manager's app prints are answering slightly different questions
   * — see {@link returnMessage}.
   */
  proceedsMinor: number;
  /** The sentence under the figures: what was measured, and what was left out. */
  message: string;
}

export function portfolioReturnView(input: {
  portfolio: ManagedPortfolio;
  /** Live holdings' values in the currency they are HELD in (never converted). */
  moneyByHoldingId: ReadonlyMap<string, MoneyMinor>;
  /** Live holdings' types, keyed by id — absent means "not live any more". */
  typeByHoldingId: ReadonlyMap<string, string>;
  operationsByHoldingId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  monthlyClosesByHoldingId: ReadonlyMap<string, readonly MonthlyCloseValue[]>;
  payoutsByHoldingId?: ReadonlyMap<string, readonly DatedPayout[]> | undefined;
  baseCurrency: CurrencyCode;
  /** "Today" as YYYY-MM-DD — the date the terminal value is dated at. */
  today: string;
}): PortfolioReturnView | null {
  const {
    baseCurrency,
    monthlyClosesByHoldingId,
    moneyByHoldingId,
    operationsByHoldingId,
    payoutsByHoldingId,
    portfolio,
    today,
    typeByHoldingId,
  } = input;

  const roles = managedPortfolioMemberRoles(portfolio.holdingIds, typeByHoldingId);

  // The investment/cash split is READ FROM THE CAREO, not summed again here: the
  // ficha already prints those two figures, and a second sum of the same money is
  // how a surface ends up quoting a coverage its own witness block contradicts
  // (#1422). Unconverted money for the same reason the careo uses it.
  const reconciliation = reconcileManagedPortfolio({
    baseCurrency,
    members: managedPortfolioMemberValues(
      portfolio.holdingIds,
      new Map(
        [...typeByHoldingId].map(([holdingId, type]) => [
          holdingId,
          { type, value: moneyByHoldingId.get(holdingId) ?? null },
        ]),
      ),
    ),
    witness: portfolio.witness,
  });

  const slices: SubsetReturnsSlice[] = [];
  let coveredMinor = 0;
  let excludedForeignCount = 0;

  for (const holdingId of roles.detailedHoldingIds) {
    const operations = operationsByHoldingId.get(holdingId) ?? [];
    if (operations.length === 0) {
      // No ledger, no return: an investment with no operations is worth nothing
      // yet (ADR 0006), so it costs the coverage nothing either.
      continue;
    }
    const value = moneyByHoldingId.get(holdingId) ?? null;
    if (value === null || value.currency !== baseCurrency) {
      excludedForeignCount += 1;
      continue;
    }
    const payouts = payoutsByHoldingId?.get(holdingId);
    coveredMinor += value.amountMinor;
    slices.push({
      marketValueMinor: value.amountMinor,
      monthlyCloses: monthlyClosesByHoldingId.get(holdingId) ?? [],
      operations,
      ...(payouts === undefined ? {} : { payouts }),
    });
  }

  if (slices.length === 0) {
    return null;
  }

  const returns = subsetReturns({
    currency: baseCurrency,
    slices,
    valuationDate: today,
  });
  const view = buildPortfolioReturnsView(
    returns.simpleGain,
    returns.irr,
    returns.twr,
    returns.payoutsIncluded,
  );

  // What came back out along the way (sells): gain = proceeds + value − invested,
  // so the stream's proceeds are recoverable from the three figures without a
  // second fold over the flows.
  const proceedsMinor = Math.max(
    0,
    returns.simpleGain.totalGain.amountMinor +
      returns.simpleGain.totalInvestedMinor -
      returns.marketValueMinor,
  );

  const cashMinor = reconciliation.cashValue.amountMinor;
  const uncoveredMinor = Math.max(
    0,
    reconciliation.investmentValue.amountMinor - coveredMinor,
  );

  return {
    cashMinor,
    coveredMinor,
    excludedForeignCount,
    gainMinor: returns.simpleGain.totalGain.amountMinor,
    investedMinor: returns.simpleGain.totalInvestedMinor,
    measuredCount: slices.length,
    message: returnMessage({
      baseCurrency,
      cashMinor,
      excludedForeignCount,
      hasUndetailed: roles.undetailedHoldingId !== null,
      measuredCount: slices.length,
      proceedsMinor,
      uncoveredMinor,
    }),
    proceedsMinor,
    uncoveredMinor,
    view,
  };
}

/**
 * The sentence under the figures. It always says what the rate was measured ON,
 * because a percentage the reader tries to check against the cartera's total will
 * not come out — the cash is missing from it by design, and so is whatever the
 * cartera has not detailed yet.
 */
function returnMessage(input: {
  baseCurrency: CurrencyCode;
  cashMinor: number;
  excludedForeignCount: number;
  hasUndetailed: boolean;
  measuredCount: number;
  proceedsMinor: number;
  uncoveredMinor: number;
}): string {
  const {
    baseCurrency,
    cashMinor,
    excludedForeignCount,
    measuredCount,
    proceedsMinor,
    uncoveredMinor,
  } = input;
  const amount = (amountMinor: number) =>
    formatMoneyMinor({ amountMinor, currency: baseCurrency });

  const parts = [
    `Medida sobre ${measuredCount === 1 ? "el fondo" : `los ${measuredCount} fondos`} ` +
      "de la cartera, nunca sobre su efectivo: la caja " +
      `(${amount(cashMinor)}) no cotiza ni tiene coste de adquisición, así que ` +
      "entra en el valor de la cartera y no en su rentabilidad — igual que en la " +
      "app de tu gestor. Los traspasos entre fondos de la cartera se cancelan en " +
      "su fecha: mover dinero de uno a otro no es capital nuevo.",
  ];

  if (uncoveredMinor > 0) {
    parts.push(
      input.hasUndetailed
        ? `Quedan ${amount(uncoveredMinor)} sin medir: la parte sin detallar no ` +
            "tiene operaciones de las que derivar un retorno. Suma al valor de la " +
            "cartera, no a esta cifra — detállala y entrará."
        : `Quedan ${amount(uncoveredMinor)} sin medir: algún miembro no tiene ` +
            "operaciones de las que derivar un retorno. Suma al valor de la cartera, " +
            "no a esta cifra.",
    );
  }

  if (proceedsMinor > 0) {
    parts.push(
      `Ha habido reembolsos (${amount(proceedsMinor)} devueltos por ventas): esta ` +
        "cifra es la ganancia TOTAL sobre todo lo que aportaste, con lo ya vendido " +
        "dentro. Tu gestor suele enseñar solo la plusvalía de las participaciones " +
        "que aún tienes sobre lo que ésas costaron, así que las dos cifras no tienen " +
        "por qué coincidir — y ninguna está mal.",
    );
  }

  if (excludedForeignCount > 0) {
    parts.push(
      `${excludedForeignCount} ${excludedForeignCount === 1 ? "fondo" : "fondos"} ` +
        `en otra divisa sin cambio honesto hoy no ${
          excludedForeignCount === 1 ? "entra" : "entran"
        } en la medida.`,
    );
  }

  return parts.join(" ");
}
