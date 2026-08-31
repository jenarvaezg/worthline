import type { AgentViewReadStore } from "@worthline/db";
import type {
  CurrencyCode,
  DatedAmount,
  DatedPayout,
  OwnershipShare,
  PassiveIncomeWindow,
  Payout,
  PayoutSchedule,
  Workspace,
} from "@worthline/domain";
import {
  collectHoldingPayouts,
  passiveIncomeTrailing,
  resolveScopeMemberIds,
  scopePassiveIncome,
} from "@worthline/domain";

import type {
  AgentViewHoldingPayouts,
  AgentViewMoney,
  AgentViewPassiveIncomeWindow,
  AgentViewPayout,
  AgentViewPayoutSchedule,
  AgentViewScopePassiveIncome,
} from "./contract";
import { derivePublicId } from "./derived-id";
import { moneyOf } from "./money";

/**
 * Payouts as the agent view sees them (PRD #652, #659, ADR 0054). Two read-only
 * surfaces that follow the returns prior art (#550/#552): a holding's payouts +
 * schedules ride on its detail, and the scope's passive income rides on the
 * compact financial context. Pure reads — a payout touches no figure, snapshot,
 * or ripple, so surfacing one can never mutate state. Schedule occurrences are
 * derived in domain code (`collectHoldingPayouts`); no consumer re-derives them.
 */

const TRAILING_MONTHS = 12;

/**
 * What one pass over a holding's payouts yields: the block the detail publishes,
 * and the very same collected series as the dated flows the return engine folds
 * (#1627). Both come out of ONE read and ONE collection on purpose — a detail
 * whose returns re-read the payouts could print a gain that contradicts the
 * payout list two blocks above it (#1422).
 */
export interface HoldingPayoutsRead {
  /** Null when the holding has neither a payout nor a schedule (#659). */
  block: AgentViewHoldingPayouts | null;
  /** The collected series (one-offs + derived occurrences ≤ today) as flows. */
  flows: readonly DatedPayout[];
}

/**
 * One holding's payouts: its recorded one-offs, its declared schedules, and a
 * trailing-12-month aggregate. Full (household) amounts — NOT scope-weighted —
 * matching the holding detail's `currentValue`. The block is null when the holding
 * has neither a payout nor a schedule, so it honestly signals "no income here".
 */
export async function buildHoldingPayouts(input: {
  store: AgentViewReadStore;
  assetId: string;
  currency: CurrencyCode;
  todayISO: string;
}): Promise<HoldingPayoutsRead> {
  const [recorded, schedules] = await Promise.all([
    input.store.readPayoutsForHolding(input.assetId),
    input.store.readPayoutSchedulesForHolding(input.assetId),
  ]);

  if (recorded.length === 0 && schedules.length === 0) {
    return { block: null, flows: [] };
  }

  // One-offs (dated ≤ today) + each schedule's derived occurrences, from the single
  // canonical collector — the trailing window and the returns fold both read that
  // one dated series.
  const dated =
    collectHoldingPayouts(recorded, schedules, input.todayISO).get(input.assetId) ?? [];

  return {
    block: {
      recorded: recorded.map((payout) => toPayout(payout, input.currency)),
      schedules: schedules.map((schedule) => toSchedule(schedule, input.currency)),
      trailing12m: toWindow(
        passiveIncomeTrailing(dated, input.todayISO, TRAILING_MONTHS),
        input.currency,
      ),
    },
    flows: payoutFlows(dated),
  };
}

/** A collected payout series as the dated FLOWS the return engine folds (#657). */
export function payoutFlows(rows: readonly DatedAmount[]): readonly DatedPayout[] {
  return rows.map((row) => ({ amountMinor: row.amountMinor, date: row.dateISO }));
}

/**
 * The selected scope's passive-income lens: trailing-12-month payouts weighted by
 * the scope's ownership share, with honest coverage against declared spending
 * (null when unknown). Mirrors the /objetivos "renta pasiva" lens — the
 * weighting/coverage math is the shared domain `scopePassiveIncome`, so the two
 * surfaces agree. Caller-resolved like `buildPortfolioReturns`: the workspace,
 * internal scope id, holdings AND the collected payouts come from
 * `buildFinancialContext` (which already loaded them), so this reads only what's
 * new — the FIRE config. The payouts arrive collected rather than read here
 * because the returns block folds the very same series (#1593): one read, one
 * collection, so the two blocks of a context cannot disagree about what was
 * received.
 */
export async function buildScopePassiveIncome(input: {
  store: AgentViewReadStore;
  workspace: Workspace;
  internalScopeId: string;
  holdings: readonly { id: string; ownership: OwnershipShare[] }[];
  /** Recorded payouts up to `todayISO`, keyed by holding (`collectHoldingPayouts`). */
  payoutsByHolding: ReadonlyMap<string, readonly DatedAmount[]>;
  todayISO: string;
}): Promise<AgentViewScopePassiveIncome> {
  const fireConfig = await input.store.readFireConfig(input.todayISO);

  const lens = scopePassiveIncome({
    payoutsByHolding: input.payoutsByHolding,
    holdings: input.holdings,
    scopeMemberIds: new Set(
      resolveScopeMemberIds(input.workspace, input.internalScopeId),
    ),
    monthlySpendingMinor: fireConfig[input.internalScopeId]?.monthlySpendingMinor ?? null,
    todayISO: input.todayISO,
    months: TRAILING_MONTHS,
  });

  const currency = input.workspace.baseCurrency;
  return {
    total: moneyOf(lens.totalMinor, currency),
    expenses: moneyOf(lens.expensesMinor, currency),
    net: moneyOf(lens.netMinor, currency),
    count: lens.count,
    windowStart: lens.windowStartISO,
    windowEnd: lens.windowEndISO,
    months: TRAILING_MONTHS,
    annualSpending:
      lens.annualSpendingMinor === null
        ? null
        : moneyOf(lens.annualSpendingMinor, currency),
    coverageRatio: lens.coverageRatio === null ? null : lens.coverageRatio.toString(),
    hasPayouts: lens.hasPayouts,
  };
}

function toPayout(payout: Payout, currency: CurrencyCode): AgentViewPayout {
  return {
    id: derivePublicId("pay", payout.id),
    object: "payout",
    date: payout.dateISO,
    amount: moneyOf(payout.amountMinor, currency),
    ...(payout.note === undefined ? {} : { note: payout.note }),
  };
}

function toSchedule(
  schedule: PayoutSchedule,
  currency: CurrencyCode,
): AgentViewPayoutSchedule {
  return {
    id: derivePublicId("psc", schedule.id),
    object: "payout_schedule",
    label: schedule.label,
    cadence: schedule.cadence,
    amount: moneyOf(schedule.amountMinor, currency),
    startDate: schedule.startISO,
    endDate: schedule.endISO,
    exclusions: schedule.exclusions,
    // `== null` on purpose: the store's absent and its explicit NULL are the same
    // fact — nobody declared expenses — and the engine treats them the same way.
    expenses:
      schedule.expensesMinor == null ? null : moneyOf(schedule.expensesMinor, currency),
  };
}

function toWindow(
  window: PassiveIncomeWindow,
  currency: CurrencyCode,
): AgentViewPassiveIncomeWindow {
  return {
    total: moneyOf(window.totalMinor, currency),
    expenses: moneyOf(window.expensesMinor, currency),
    net: moneyOf(window.netMinor, currency),
    count: window.count,
    windowStart: window.windowStartISO,
    windowEnd: window.windowEndISO,
    months: TRAILING_MONTHS,
  };
}
