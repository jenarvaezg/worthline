import type { AgentViewReadStore } from "@worthline/db";
import {
  collectHoldingPayouts,
  passiveIncomeTrailing,
  resolveScopeMemberIds,
  scopePassiveIncome,
} from "@worthline/domain";
import type {
  CurrencyCode,
  OwnershipShare,
  PassiveIncomeWindow,
  Payout,
  PayoutSchedule,
  Workspace,
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
 * One holding's payouts: its recorded one-offs, its declared schedules, and a
 * trailing-12-month aggregate. Full (household) amounts — NOT scope-weighted —
 * matching the holding detail's `currentValue`. Null when the holding has neither
 * a payout nor a schedule, so the block honestly signals "no income here".
 */
export async function buildHoldingPayouts(input: {
  store: AgentViewReadStore;
  assetId: string;
  currency: CurrencyCode;
  todayISO: string;
}): Promise<AgentViewHoldingPayouts | null> {
  const [recorded, schedules] = await Promise.all([
    input.store.readPayoutsForHolding(input.assetId),
    input.store.readPayoutSchedulesForHolding(input.assetId),
  ]);

  if (recorded.length === 0 && schedules.length === 0) {
    return null;
  }

  // One-offs (dated ≤ today) + each schedule's derived occurrences, from the single
  // canonical collector — the trailing window then reads that one dated series.
  const dated = collectHoldingPayouts(recorded, schedules, input.todayISO).get(
    input.assetId,
  );

  return {
    recorded: recorded.map((payout) => toPayout(payout, input.currency)),
    schedules: schedules.map((schedule) => toSchedule(schedule, input.currency)),
    trailing12m: toWindow(
      passiveIncomeTrailing(dated ?? [], input.todayISO, TRAILING_MONTHS),
      input.currency,
    ),
  };
}

/**
 * The selected scope's passive-income lens: trailing-12-month payouts weighted by
 * the scope's ownership share, with honest coverage against declared spending
 * (null when unknown). Mirrors the /objetivos "renta pasiva" lens — the
 * weighting/coverage math is the shared domain `scopePassiveIncome`, so the two
 * surfaces agree. Caller-resolved like `buildPortfolioReturns`: the workspace,
 * internal scope id, and holdings come from `buildFinancialContext` (which already
 * loaded them), so this reads only what's new — payouts, schedules, FIRE config.
 */
export async function buildScopePassiveIncome(input: {
  store: AgentViewReadStore;
  workspace: Workspace;
  internalScopeId: string;
  holdings: readonly { id: string; ownership: OwnershipShare[] }[];
  todayISO: string;
}): Promise<AgentViewScopePassiveIncome> {
  const [recorded, schedules, fireConfig] = await Promise.all([
    input.store.readPayouts(),
    input.store.readPayoutSchedules(),
    input.store.readFireConfig(),
  ]);

  const lens = scopePassiveIncome({
    payoutsByHolding: collectHoldingPayouts(recorded, schedules, input.todayISO),
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
  };
}

function toWindow(
  window: PassiveIncomeWindow,
  currency: CurrencyCode,
): AgentViewPassiveIncomeWindow {
  return {
    total: moneyOf(window.totalMinor, currency),
    count: window.count,
    windowStart: window.windowStartISO,
    windowEnd: window.windowEndISO,
    months: TRAILING_MONTHS,
  };
}

function moneyOf(amountMinor: number, currency: CurrencyCode): AgentViewMoney {
  return { amountMinor, currency };
}
