import type { AgentViewExposureDrift } from "./exposure";
import type { AgentViewFireScenario, AgentViewFireStatus } from "./fire";
import type { AgentViewMoney, AgentViewScope } from "./shared";

/**
 * A contribution amount, expressed either as a fixed money value or as a
 * units count (with an optional estimated money value) — the one shape both
 * `AgentViewPlannedContribution` and `AgentViewContributionOccurrence` quote,
 * so the two tools describing "amount" cannot diverge in silence.
 */
export type AgentViewContributionAmount =
  | { mode: "money"; value: AgentViewMoney }
  | { mode: "units"; value: string; estimatedValue?: AgentViewMoney };

/** A recurring planned contribution as forecast metadata (ADR 0041, PRD #553 S5). */
export interface AgentViewPlannedContribution {
  object: "planned_contribution";
  /** Opaque stable id (`wl_cpc_…`). */
  id: string;
  /** Destination holding public id (`wl_hld_…`). */
  destinationHolding: string;
  amount: AgentViewContributionAmount;
  cadence:
    | { kind: "weekly"; weekday: number }
    | { kind: "monthly"; dayOfMonth: number }
    | { kind: "quarterly" }
    | { kind: "annual" };
  startDate: string;
  endDate?: string;
  /** True when the contribution is in force today (started and not ended). */
  active: boolean;
}

/**
 * One destination's share of a month's planned capital allocation (forecast),
 * contrasted with the money explicitly confirmed against that month's
 * occurrences (S2). `plannedAmount` is null when a units occurrence lacks a
 * price — reported via `plannedUnits`, never guessed.
 */
export interface AgentViewMonthlyAllocationSlice {
  destinationHolding: string;
  plannedAmount: AgentViewMoney | null;
  /** Units-mode planned total for the month, for honest display when unpriced. */
  plannedUnits?: string;
  /** Money confirmed against this month's occurrences via explicit links. */
  executed: AgentViewMoney;
  occurrenceCount: number;
  /** Occurrences already closed (fulfilled or skipped). */
  closedCount: number;
  /** Share of the month's priceable planned total, as a `0..1` decimal string. */
  shareOfMonth: string;
}

/**
 * Where planned capital goes in one calendar month (ADR 0041, PRD #553 S3/S5).
 * Derived from the same seam the /objetivos view reads
 * (`computeMonthlyContributionAllocation`) — forecast only, never confirmed
 * truth. `totalPlanned` sums only priceable slices; unpriced destinations are
 * listed in `missingUnitPriceHoldings` rather than silently dropped.
 */
export interface AgentViewMonthlyAllocation {
  object: "monthly_allocation";
  /** `YYYY-MM` month key. */
  month: string;
  totalPlanned: AgentViewMoney;
  totalExecuted: AgentViewMoney;
  /** Destinations (`wl_hld_…`) whose units contributions lack a unit price. */
  missingUnitPriceHoldings: string[];
  slices: AgentViewMonthlyAllocationSlice[];
}

/** One forecast occurrence with its reconciliation status (ADR 0041, PRD #553 S2/S5). */
export interface AgentViewContributionOccurrence {
  object: "contribution_occurrence";
  id: string;
  plannedContributionId: string;
  destinationHolding: string;
  plannedDate: string;
  amount: AgentViewContributionAmount;
  state: "pending" | "partial" | "fulfilled" | "skipped";
  /** True when the planned date is before today and still open. */
  backlog: boolean;
  /** Public operation ids (`wl_op_…`) explicitly linked to this occurrence. */
  linkedOperations: string[];
  progress:
    | {
        mode: "money";
        planned: AgentViewMoney;
        executed: AgentViewMoney;
        delta: AgentViewMoney;
      }
    | {
        mode: "units";
        plannedUnits: string;
        executedUnits: string;
        deltaUnits: string;
        actualCash: AgentViewMoney;
      };
}

/** Pending/backlog reconciliation status for the contribution plan (forecast vs truth). */
export interface AgentViewContributionReconciliation {
  object: "contribution_reconciliation";
  /** The projected window: earliest plan start → `reconciliationWindowDays` ahead. */
  window: { from: string; to: string };
  pending: AgentViewContributionOccurrence[];
  backlog: AgentViewContributionOccurrence[];
  closed: AgentViewContributionOccurrence[];
}

/**
 * FIRE what-if under the contribution plan (ADR 0041, PRD #553 S4/S5): time-varying
 * planned contributions plus a growth assumption toggle. Forecast only — confirmed
 * operations remain truth via `get_operations`.
 */
export interface AgentViewContributionWhatIf {
  object: "contribution_what_if";
  growthAssumption: "flat" | "historical";
  /** Fallback annual return used when a holding lacks #547 history. */
  assumedAnnualReturn: string;
  status: AgentViewFireStatus;
  fireNumber?: AgentViewMoney;
  scenarios: AgentViewFireScenario[];
}

/**
 * A scope's contribution plan as `get_contribution_plan` exposes it (ADR 0041,
 * PRD #553 S5): the recurring plan, monthly allocation, pending/backlog status,
 * and what-if trajectory. The entire surface is forecast metadata — it never
 * enters net worth or snapshots. Confirmed movements remain truth via operations.
 */
export interface AgentViewContributionPlanContext {
  object: "contribution_plan_context";
  scope: AgentViewScope;
  /** Always true — labels the entire response as forecast, not executed truth. */
  forecast: true;
  truthNote: string;
  status: "empty" | "configured";
  contributions: AgentViewPlannedContribution[];
  /**
   * No `monthlySavingsCapacity` here on purpose (#1416, ADR 0074). This surface
   * used to report the FIRE savings capacity and where it came from, because the
   * plan overrode the user's declared scalar. It no longer does: the plan's own
   * monthly figure is `monthlyAllocation.totalPlanned`, and the capacity the FIRE
   * projection contributes is `get_fire_projection.monthlySavingsCapacity` — one
   * number per question, so the assistant cannot quote a subset as the total.
   */
  monthlyAllocation: AgentViewMonthlyAllocation;
  reconciliation: AgentViewContributionReconciliation;
  whatIf: AgentViewContributionWhatIf;
  exposureDrift: AgentViewExposureDrift;
}
