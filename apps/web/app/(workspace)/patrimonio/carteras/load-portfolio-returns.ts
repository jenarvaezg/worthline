import type { WorthlineStore } from "@web/store";
import type { CurrencyCode, DatedPayout, ManagedPortfolio } from "@worthline/domain";
import { collectHoldingPayouts, monthlyCloseValuesByHolding } from "@worthline/domain";
import type { PortfolioReturnView } from "./carteras-returns-view";
import { portfolioReturnView } from "./carteras-returns-view";
import type { PortfolioWitnessView } from "./carteras-view";
import type { CarterasReadModel } from "./load-carteras";

/**
 * The I/O behind the ficha's return block (#1552): the two things the portfolio's
 * members need beyond what {@link CarterasReadModel} already holds — their frozen
 * monthly closes (for the TWR) and their recorded payouts (#657) — read the same
 * way the /patrimonio board reads them, so the cartera's figure and the board's
 * per-holding figures come from one set of inputs.
 *
 * It reads NOTHING when no member has a ledger to measure: a cartera registered
 * with a "(sin detallar)" aggregate and nothing else pays no query for a block it
 * will not render.
 */
export async function loadPortfolioReturns(input: {
  store: WorthlineStore;
  model: CarterasReadModel;
  portfolio: ManagedPortfolio;
  /** The careo the ficha already performed — the return reads its split (#1550). */
  witness: PortfolioWitnessView;
  baseCurrency: CurrencyCode;
  today: string;
}): Promise<PortfolioReturnView | null> {
  const { baseCurrency, model, portfolio, store, today, witness } = input;

  const measurableIds = new Set(
    portfolio.holdingIds.filter(
      (holdingId) => (model.operationsByHoldingId.get(holdingId)?.length ?? 0) > 0,
    ),
  );
  if (measurableIds.size === 0) {
    return null;
  }

  const [snapshotRows, payoutRecords, payoutSchedules] = await Promise.all([
    // Household rows, parent holdings only: the monthly closes are derived from
    // the frozen values (ADR 0008), and the per-position children the default
    // read attaches are of no use here (#1235).
    store.snapshots.readSnapshotHoldings({
      includePositions: false,
      kind: "asset",
      scopeId: "household",
    }),
    store.payouts.readPayouts(),
    store.payouts.readPayoutSchedules(),
  ]);

  const monthlyClosesByHoldingId = monthlyCloseValuesByHolding(
    snapshotRows,
    measurableIds,
  );

  const payoutsByHoldingId = new Map<string, readonly DatedPayout[]>(
    [...collectHoldingPayouts(payoutRecords, payoutSchedules, today)]
      .filter(([holdingId]) => measurableIds.has(holdingId))
      .map(([holdingId, rows]) => [
        holdingId,
        rows.map((row) => ({ amountMinor: row.amountMinor, date: row.dateISO })),
      ]),
  );

  return portfolioReturnView({
    baseCurrency,
    monthlyClosesByHoldingId,
    moneyByHoldingId: model.moneyByHoldingId,
    operationsByHoldingId: model.operationsByHoldingId,
    payoutsByHoldingId,
    portfolio,
    today,
    typeByHoldingId: model.typeByHoldingId,
    witness,
  });
}
