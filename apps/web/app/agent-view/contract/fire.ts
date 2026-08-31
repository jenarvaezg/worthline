import type { AgentViewMoney, AgentViewObjectReference, AgentViewScope } from "./shared";

/** Whether a scope has a FIRE configuration (PRD #328, #340). */
export type AgentViewFireStatus = "configured" | "unconfigured";

/**
 * The FIRE assumptions a scope's figures rest on (PRD #328, #340). Rates are
 * `0..1` decimal strings (e.g. `"0.04"`); `monthlySpending` is the configured
 * monthly drawdown as money.
 */
export interface AgentViewFireAssumptions {
  safeWithdrawalRate: string;
  expectedRealReturn: string;
  monthlySpending: AgentViewMoney;
}

/**
 * The compact FIRE summary folded into the main financial context (PRD #328,
 * #340). When `status` is `unconfigured` only the status is present — no figures
 * are fabricated. When `configured`, `progressRatio` is `eligibleAssets /
 * fireNumber` as a non-negative decimal string (exceeds `1` once over-funded)
 * and `gap` is `fireNumber − eligibleAssets` (signed: negative once over-funded).
 */
export interface AgentViewFireSummary {
  status: AgentViewFireStatus;
  /** Present only when configured: `eligibleAssets / fireNumber` as a non-negative decimal string (`>1` once over-funded). */
  progressRatio?: string;
  /** Present only when configured. */
  fireNumber?: AgentViewMoney;
  /** Present only when configured: the scope-weighted FIRE-eligible total. */
  eligibleAssets?: AgentViewMoney;
  /** Present only when configured: `fireNumber − eligibleAssets`, signed. */
  gap?: AgentViewMoney;
  /** Present only when configured. */
  assumptions?: AgentViewFireAssumptions;
}

/**
 * One asset held out of a scope's FIRE-eligible total (PRD #328, #340). The
 * `holding` reference carries the registry `wl_hld_` id; `reason` is the asset's
 * own primary-residence flag or a manual exclusion in the FIRE config.
 */
export interface AgentViewFireExcludedAsset {
  holding: AgentViewObjectReference;
  reason: "primary_residence" | "manual";
}

/** A scope's stored FIRE configuration (PRD #328, #340). */
export interface AgentViewFireConfig {
  monthlySpending: AgentViewMoney;
  safeWithdrawalRate: string;
  expectedRealReturn: string;
  /**
   * The reference age, DERIVED from the scope members' birth dates on read
   * (#1415) — not a stored scalar. Absent when no member of the scope has a
   * birth year and no pre-#1415 config left a typed age behind; the coast
   * figures are then absent too.
   */
  currentAge?: number;
  targetRetirementAge?: number;
  /**
   * Editable monthly savings capacity (PRD #421, #425): the contribution the
   * FIRE projection assumes. Present only when the user has set it; absent means
   * the projection treats it as zero (the UI offers a history-based suggestion).
   */
  monthlySavingsCapacity?: AgentViewMoney;
  /**
   * Whether the scope counts its IMMOBILIZED capital — non-primary property,
   * collections — as FIRE capital (#1460, ADR 0078). Always present, because when it
   * is `false` every figure in `result` is measured over the sellable side alone, and
   * the excluded brick appears in NO other field: it is not an `excludedAssets` entry
   * (nothing excluded it as an asset) and the eligible total simply does not contain
   * it. An assistant quoting the FIRE number has to be able to say which of the two
   * measures it is quoting.
   */
  immobilizedCountsAsFireCapital: boolean;
  /**
   * What the user DECLARED their plan to be (#1428, ADR 0081): `ordinary` = an
   * ordinary retirement, `early` = FIRE. Absent when they have not been asked or have
   * not answered. It changes no figure — but with `ordinary` the honest headline for
   * this scope is `result.sustainableSpending`, not the funded percentage: quoting
   * "you are 31,5 % short" at someone whose plan is an ordinary retirement answers a
   * question they did not ask.
   */
  retirementPlan?: "ordinary" | "early";
  /**
   * The age at or above which retiring is no longer *early* (#1428) — the threshold the
   * profile signal is measured against. A user datum with a neutral default of 65,
   * never legislation: the ordinary age depends on country and year.
   */
  ordinaryRetirementAge: number;
  /**
   * The **final age**: how long the capital must last, if the user said (#1428). Present
   * only when they did — no actuarial table is assumed on their behalf, and without it
   * the sustainable-spending answer has only its perpetual half. Deliberately not called
   * a life expectancy: it is a declaration, not an estimate.
   */
  capitalLastsUntilAge?: number;
}

/**
 * The computed FIRE result for a scope (PRD #328, #340). `progressRatio` is
 * `eligibleAssets / fireNumber` as a non-negative decimal string (`>1` once
 * over-funded); `gap` is `fireNumber − eligibleAssets` (signed). Coast-FIRE facts appear only when the config
 * carries an age (so they can be computed honestly).
 */
export interface AgentViewFireResult {
  fireNumber: AgentViewMoney;
  eligibleAssets: AgentViewMoney;
  gap: AgentViewMoney;
  progressRatio: string;
  /**
   * Capital reserved for goals due before FIRE (PRD #421, #426), already
   * subtracted from `eligibleAssets`. Present only when it is non-zero — it
   * affects FIRE only, never gross assets / net worth / liquid net worth.
   */
  reservedForGoals?: AgentViewMoney;
  /** Present only when the config carries an age. */
  coastFireRequired?: AgentViewMoney;
  /**
   * The age today's capital would reach the FULL FIRE number at **if contributions
   * stopped right now** (#1425). It was called `coastFireAge`, which promised the age
   * Coast is reached at — a different question, answered by `coastArrival` below. This
   * one assumes ZERO contributions, so quoting it as a coast age contradicts the
   * premise of `coastFireRequired` beside it. Present only when it can be derived (a
   * compounding rate, some capital, and the FIRE number not yet reached).
   */
  fireAgeIfContributionsStop?: number;
  /**
   * When the scope reaches the coast requirement projecting WITH its declared savings
   * (#1425) — the figure the coast tick on screen implies and nothing computed before.
   * `reached` means the requirement is already met (so `isAlreadyAtCoastFire` is true
   * and no age applies); `unreachable` means the declared savings never cross it inside
   * the projection horizon. Present only when the config carries an age.
   */
  coastArrival?:
    | { kind: "reached" }
    | { kind: "eta"; years: number; age: number }
    | { kind: "unreachable" };
  /** Present only when the config carries an age. */
  isAlreadyAtCoastFire?: boolean;
  /**
   * Whether this scope's plan reads as FIRE or as an ordinary retirement (#1428, ADR
   * 0081), and why. `state` is `ordinary` ONLY when the user declared it; `offer` means
   * the app has signals but has not been answered, and `fire` is everything else. The
   * signals are named so an assistant can say what they rest on instead of concluding
   * "you will not reach FIRE" from a threshold the user can move.
   */
  retirementProfile: {
    state: "fire" | "offer" | "ordinary";
    signals: ("target_age_is_ordinary" | "regular_unreachable")[];
  };
  /**
   * "How much can I spend without depleting my capital?" — the inverse of the FIRE
   * formula (#1428, ADR 0081), and the honest headline for an ordinary-retirement plan.
   *
   * Two halves, never summed into one opaque figure: `rents` is the scope's declared NET
   * rent, and `capitalMonthly` is what the SELLABLE side supports at the withdrawal rate
   * (the immobilized side is not in it — a withdrawal rate assumes capital sold in
   * slices). `depletionMonthly` is the same capital annuitized to `capitalLastsUntilAge`,
   * present only when that age is declared. Absent when there is no withdrawal rate.
   */
  sustainableSpending?: {
    /** `rents` + what the sellable capital supports, perpetually. */
    totalMonthly: AgentViewMoney;
    capitalMonthly: AgentViewMoney;
    /** Declared net rent, monthly. Absent when the scope declares none. */
    rentsMonthly?: AgentViewMoney;
    /** Perpetual + depleting the principal by `untilAge`. Absent without that age. */
    depletionMonthly?: AgentViewMoney;
    untilAge?: number;
  };
}

/**
 * A data-quality-style signal on a FIRE-context read (PRD #328, #340). The full
 * taxonomy is issue #341; here it surfaces the one honest signal this endpoint
 * can raise — a scope with no FIRE configuration.
 */
export interface AgentViewFireQualitySignal {
  category: "missing_configuration";
  message: string;
}

/**
 * The full FIRE context for a scope (PRD #328, #340). When `status` is
 * `unconfigured`, `config`/`result` are absent and a `missing_configuration`
 * quality signal is raised; nothing is invented. Historical FIRE is unsupported
 * — any dated request is a documented `422`.
 */
export interface AgentViewFireContext {
  scope: AgentViewScope;
  status: AgentViewFireStatus;
  /** Present only when configured. */
  config?: AgentViewFireConfig;
  /** Present only when configured. */
  result?: AgentViewFireResult;
  /** The scope-weighted FIRE-eligible total (0 when unconfigured). */
  eligibleAssetsTotal: AgentViewMoney;
  /** Assets excluded from the eligible total, with their reason. */
  excludedAssets: AgentViewFireExcludedAsset[];
  /** Present only when configured. */
  assumptions?: AgentViewFireAssumptions;
  /** Honest signals about the read (e.g. a scope with no FIRE config). */
  qualitySignals: AgentViewFireQualitySignal[];
}

/** One point of a FIRE projection's year-by-year capital trajectory (PRD #421, #427). */
export interface AgentViewFireTrajectoryPoint {
  /** Years from today (0 = today). */
  year: number;
  eligible: AgentViewMoney;
}

/**
 * One FIRE projection scenario as `get_fire_projection` exposes it (PRD #421,
 * #427). `annualReturn` is a decimal string (e.g. `"0.065"`). `yearsToFire` /
 * `ageAtFire` are `null` when FIRE is not reached within the horizon (or no age
 * is configured).
 */
export interface AgentViewFireScenario {
  label: "optimistic" | "base" | "pessimistic";
  annualReturn: string;
  yearsToFire: number | null;
  ageAtFire: number | null;
  finalEligible: AgentViewMoney;
  totalContributed: AgentViewMoney;
  trajectory: AgentViewFireTrajectoryPoint[];
}

/**
 * A scope's FIRE projection as `get_fire_projection` exposes it (PRD #421,
 * #427): optimistic/base/pessimistic scenarios over the FIRE number, using the
 * configured monthly savings capacity and the goal-reservation-adjusted eligible
 * assets. Goal reservations only subtract FIRE-eligible assigned holdings.
 * `unconfigured` when the scope has no FIRE config — no figures invented.
 */
export interface AgentViewFireProjection {
  object: "fire_projection";
  scope: AgentViewScope;
  status: AgentViewFireStatus;
  /** Present only when configured. */
  fireNumber?: AgentViewMoney;
  /** The monthly contribution assumed; present only when set on the config. */
  monthlySavingsCapacity?: AgentViewMoney;
  /** `[optimistic, base, pessimistic]` when configured; empty when not. */
  scenarios: AgentViewFireScenario[];
}
