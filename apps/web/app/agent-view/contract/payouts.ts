import type { PayoutCadence } from "@worthline/domain";

import type { AgentViewMoney } from "./shared";

/**
 * One recorded payout — a dividend, interest, or rent a holding paid its owner
 * (PRD #652, ADR 0054). A pure attribution record, never a figure: reading it
 * touches no net worth, holding value, snapshot, or ripple. `id` is an opaque,
 * export/import-stable drilldown id (`wl_pay_…`) derived from the payout's stable
 * internal id — no registry write, exactly like an operation's id (ADR 0023).
 */
export interface AgentViewPayout {
  id: string;
  object: "payout";
  date: string;
  amount: AgentViewMoney;
  note?: string;
}

/**
 * A declared payout schedule — a fixed recurrence like rent (PRD #652, ADR 0054).
 * Only the DECLARATION is exposed (amount, cadence, start, optional inclusive end,
 * per-occurrence exclusions); occurrences are derived on read by the domain and are
 * never materialized, so none are surfaced here. `id` is an opaque, stable
 * drilldown id (`wl_psc_…`) derived from the schedule's internal id.
 */
export interface AgentViewPayoutSchedule {
  id: string;
  object: "payout_schedule";
  label: string;
  cadence: PayoutCadence;
  amount: AgentViewMoney;
  startDate: string;
  /** Inclusive end date, or null for an open-ended schedule. */
  endDate: string | null;
  /** ISO dates removed one by one (an unpaid month). */
  exclusions: string[];
  /**
   * Declared expenses per occurrence — SAME cadence as `amount` (#1448, ADR 0076),
   * or null when none are declared. The null is the load-bearing part (#1524): the
   * trailing window's `expenses` sums undeclared as zero, so a rent with no expenses
   * and a rent with 0 € of expenses read identically there — and they are not the
   * same thing at all. Undeclared means the FIRE engine DISCARDS this rent's return
   * and falls back to its tramo's default, which is precisely the question a user
   * asking «¿dónde introduzco los gastos?» needs answered about their own property.
   */
  expenses: AgentViewMoney | null;
}

/**
 * A trailing-window passive-income aggregate (PRD #652). Honest by construction:
 * the sum of every payout dated inside the window — one-offs plus each schedule's
 * derived occurrences — with the window bounds and the occurrence count stated, and
 * nothing annualized. The lower bound is exclusive and the upper (today) inclusive.
 */
export interface AgentViewPassiveIncomeWindow {
  /** Gross sum of the window's payouts — what arrived. */
  total: AgentViewMoney;
  /** Declared expenses of the window's occurrences (#1463); zero where undeclared. */
  expenses: AgentViewMoney;
  /** total − expenses: what the owner lives on. The headline figure on screen. */
  net: AgentViewMoney;
  count: number;
  windowStart: string;
  windowEnd: string;
  months: number;
}

/**
 * A holding's payouts as the agent view sees them (PRD #652, #659): its recorded
 * one-off payouts, its declared schedules, and a trailing-12-month aggregate. Full
 * (household) amounts — NOT scope-weighted — matching the holding detail's
 * `currentValue`, which is the full household value. Present only when the holding
 * has at least one payout or schedule; otherwise the block is null.
 */
export interface AgentViewHoldingPayouts {
  recorded: AgentViewPayout[];
  schedules: AgentViewPayoutSchedule[];
  trailing12m: AgentViewPassiveIncomeWindow;
}

/**
 * A scope's passive-income lens (PRD #652, #658/#659): the selected scope's
 * trailing-12-month payouts weighted by its ownership share, and coverage against
 * declared spending. Mirrors the /objetivos "renta pasiva" lens (`scopePassiveIncome`).
 * `annualSpending`/`coverageRatio` are null when spending is unknown — coverage is
 * never fabricated, and a partial-window payout is summed as-is, never annualized.
 */
export interface AgentViewScopePassiveIncome {
  /** Gross sum — what arrived. The screens headline `net` instead (#1463). */
  total: AgentViewMoney;
  /** Declared expenses of the window's occurrences; zero where undeclared. */
  expenses: AgentViewMoney;
  /** total − expenses: what the scope lives on. */
  net: AgentViewMoney;
  count: number;
  windowStart: string;
  windowEnd: string;
  months: number;
  /** Declared annual spending (monthly × 12) as money, or null when unknown. */
  annualSpending: AgentViewMoney | null;
  /** `net / annualSpending` (#1463) as a decimal string, or null when spending is unknown. */
  coverageRatio: string | null;
  /** Whether the scope has any recorded payout at all (drives an empty state). */
  hasPayouts: boolean;
}
