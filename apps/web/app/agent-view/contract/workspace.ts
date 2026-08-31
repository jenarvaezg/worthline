import type { GoalPriority, RiskTolerance, WorkspaceMode } from "@worthline/domain";

import type { AgentViewMoney } from "./shared";

/**
 * The workspace's settings as `get_workspace` exposes them (#467, PRD #417 S3):
 * its mode (individual vs household) and base currency, so the assistant matches
 * the workspace instead of assuming household/EUR. Both are null until the
 * workspace is provisioned — a documented uninitialized shape, never a guess.
 */
export interface AgentViewWorkspaceInfo {
  object: "workspace";
  mode: WorkspaceMode | null;
  baseCurrency: string | null;
}

/**
 * A member's profile as `get_member_profile` exposes it (PRD #421, #423): the
 * public member ID, name, and the optional profile fields used to personalize
 * advice. Each field is `null` until set. This is the only surface these PII
 * fields reach — they are never in a public endpoint.
 */
export interface AgentViewMemberProfile {
  object: "member_profile";
  id: string;
  name: string;
  /** Reference year of birth; the projection derives age from it (#1415). */
  birthYear: number | null;
  /** Reference month of birth (1-12), when known: sharpens the derived age. */
  birthMonth: number | null;
  /** ISO 3166-1 alpha-2 fiscal country (e.g. "ES"), for tax-aware suggestions. */
  fiscalCountry: string | null;
  riskTolerance: RiskTolerance | null;
}

/**
 * An intermediate goal as `list_goals` exposes it (PRD #421, #424): its target,
 * deadline, priority, the public ids of the assigned holdings, the capital
 * currently reserved (scope-weighted `min(target, assigned value)`), and the
 * funded ratio (`reserved / target`, 0..1, capped). FIRE tools subtract only
 * future in-horizon reservations backed by FIRE-eligible assigned holdings.
 */
export interface AgentViewGoal {
  object: "goal";
  id: string;
  name: string;
  targetAmount: AgentViewMoney;
  /** ISO date (YYYY-MM-DD). */
  deadline: string;
  priority: GoalPriority;
  /** Public holding ids (wl_hld_…) assigned to the goal. */
  assignedHoldings: string[];
  /** Scope-weighted reserved capital: `min(target, value of assigned holdings)`. */
  reservedAmount: AgentViewMoney;
  /** `reserved / target` as a non-negative decimal string, capped at `"1"`. */
  fundedRatio: string;
}
