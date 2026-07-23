import type { EntitlementPlan } from "@worthline/db";

/**
 * The AI token metering policy (PRD #1160 S3, #1163) — the third of the three
 * launch fuses (plan §4.2, alongside one-trial-per-identity and the daily
 * provisioning cap). Two independent limits, both counted per UTC day in the
 * control plane (`recordAiTokenUsage`), both checked BEFORE a turn reaches the
 * model:
 *
 *  1. A per-plan WORKSPACE budget — generous for `trial`/`premium`. `free` has
 *     no token budget here: its bound is the S2 monthly courtesy quota (turns,
 *     not tokens), so `dailyTokenBudgetForPlan("free")` is null and this gate
 *     never bites a free workspace.
 *  2. A GLOBAL daily fuse over every workspace's shared spend — the backstop
 *     against a runaway or an abuse spike, coarser than the Gateway money
 *     ceiling (ADR 0050) and denominated in tokens, not euros.
 *
 * When either is spent the assistant says so honestly (an honest paywall part,
 * never a silent failure) and the eager extractor degrades the same way — the
 * pre-call gate returns before any extraction runs.
 *
 * Pure policy: the counter lives in the control plane; this module is the
 * window + threshold half, so it unit-tests without a database. Recording is
 * post-hoc (the token count is only known once a turn finishes), so a single
 * turn may overshoot before the next is refused — the same increment-then-check
 * tolerance as the ADR 0051 rate limit.
 *
 * Figures (plan de salida comercial §4.2): a premium user costs ~$0.10–0.50 of
 * tokens a MONTH (~a few M tokens), and the one-shot onboarding wizard is
 * ~100–300k tokens. 2M tokens/workspace/day is therefore very generous headroom
 * for a heavy day, and a 20M global daily fuse sits far above the expected
 * beta-scale aggregate while still capping catastrophe. Both are operational
 * anti-abuse backstops, not pricing — safe to tune here.
 */

/** Per-workspace daily token budget for the paid plans (trial + premium). */
export const TRIAL_PREMIUM_DAILY_TOKEN_BUDGET = 2_000_000;

/** The shared daily fuse: total tokens across every workspace before the assistant pauses. */
export const GLOBAL_DAILY_TOKEN_FUSE = 20_000_000;

/** The ISO timestamp's UTC calendar-day bucket, e.g. "2026-07-22". */
export function tokenDayWindow(nowIso: string): string {
  return nowIso.slice(0, 10);
}

/**
 * This plan's per-workspace daily token budget, or null when the plan is not
 * metered by tokens. `free` returns null — it is bounded by the monthly courtesy
 * quota (S2), not a token budget — so the workspace token gate is a no-op for it.
 */
export function dailyTokenBudgetForPlan(plan: EntitlementPlan): number | null {
  return plan === "free" ? null : TRIAL_PREMIUM_DAILY_TOKEN_BUDGET;
}

/**
 * Has this workspace spent its plan's daily token budget? Compares the tokens
 * ALREADY recorded from prior turns against the budget: once cumulative usage
 * reaches the budget, the next turn is refused (the crossing turn is allowed to
 * finish — recording is post-hoc). Always false for a plan with no token budget.
 */
export function isWorkspaceTokenBudgetExhausted(
  usedTokens: number,
  plan: EntitlementPlan,
): boolean {
  const budget = dailyTokenBudgetForPlan(plan);
  return budget !== null && usedTokens >= budget;
}

/** Has the shared global daily fuse blown? Applies to every plan. */
export function isGlobalTokenFuseBlown(globalTokens: number): boolean {
  return globalTokens >= GLOBAL_DAILY_TOKEN_FUSE;
}
