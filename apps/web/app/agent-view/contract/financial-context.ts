import type { AgentViewDataQualitySummary, AgentViewVsInflation } from "./data-quality";
import type { AgentViewExposure } from "./exposure";
import type { AgentViewFireSummary } from "./fire";
import type {
  AgentViewConnectedSourceSummary,
  AgentViewHoldingsBlock,
  AgentViewManagedPortfolioSummary,
} from "./holdings";
import type { AgentViewScopePassiveIncome } from "./payouts";
import type { AgentViewReturns } from "./returns";
import type {
  AgentViewFinancialSummary,
  AgentViewLiquidityRung,
  AgentViewScope,
} from "./shared";

/** Compact current-state package for a selected scope (PRD #328, #335). */
export interface AgentViewFinancialContext {
  scope: AgentViewScope;
  asOf: string;
  baseCurrency: string;
  summary: AgentViewFinancialSummary;
  liquidityBreakdown: AgentViewLiquidityRung[];
  exposure: AgentViewExposure;
  /** Present-time investment returns for operation-bearing market holdings. */
  returns: AgentViewReturns | null;
  vsInflation: AgentViewVsInflation;
  /** The scope's trailing-12m passive income (renta pasiva), scope-weighted (#659). */
  passiveIncome: AgentViewScopePassiveIncome;
  holdings: AgentViewHoldingsBlock;
  connectedSources: AgentViewConnectedSourceSummary[];
  /** The scope's managed portfolios with their members (ADR 0085, #1547). */
  managedPortfolios: AgentViewManagedPortfolioSummary[];
  /** The scope's FIRE progress summary; status-only when unconfigured (#340). */
  fire: AgentViewFireSummary;
  /** The scope's data-quality summary: counts + the top signals (#341). */
  dataQuality: AgentViewDataQualitySummary;
  /** Drilldown endpoints for deeper facts (snapshots, FIRE, data quality, trash). */
  links: Record<string, string>;
}
