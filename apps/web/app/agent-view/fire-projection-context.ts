import type { FireScenario } from "@worthline/domain";
import {
  projectFire,
  resolveMonthlySavingsCapacityForFire,
  unitPriceMajorByHoldingId,
} from "@worthline/domain";

import type {
  AgentViewFireProjection,
  AgentViewFireScenario,
  AgentViewMoney,
} from "./contract";
import { resolveFire } from "./fire-context";
import type { ScopedAgentView } from "./scoped-read";

/**
 * Build the FIRE projection for a scope (PRD #421, #427): optimistic/base/
 * pessimistic scenarios over the scope's FIRE number, starting from its
 * goal-reservation-adjusted eligible assets (#426) and contributing its
 * configured monthly savings capacity (#425). Reads only.
 *
 * Resolution is shared with `get_fire_context` via `resolveFire`, so the
 * projection starts from exactly the eligible total the FIRE context reports —
 * reservations and exclusions already applied. `unconfigured` when the scope has
 * no FIRE config; no figures are fabricated.
 */
export async function buildFireProjection(
  scoped: ScopedAgentView,
): Promise<AgentViewFireProjection> {
  const { store } = scoped;
  const { scope, fire } = await resolveFire(scoped);

  if (fire.config === undefined || fire.result === undefined) {
    return { object: "fire_projection", scope, status: "unconfigured", scenarios: [] };
  }

  const config = fire.config;
  const result = fire.result;
  const currency = fire.currency;
  const internalScopeId = await scoped.internalScopeId();
  const contributionPlan = await store.readContributionPlan(internalScopeId);
  const priceCache = await store.readAllPriceCacheEntries();
  const today = new Date().toISOString().slice(0, 10);
  const monthlyContributionMinor = resolveMonthlySavingsCapacityForFire(
    contributionPlan,
    config,
    today,
    unitPriceMajorByHoldingId(priceCache),
  ).capacityMinor;

  // N3 (#515): use result.realReturnUsed (the single resolved rate) — not
  // config.expectedRealReturn directly — so projection is coherent with coast.
  const projection = projectFire({
    startingEligibleMinor: result.eligibleAssets.amountMinor,
    monthlyContributionMinor,
    expectedRealReturn: result.realReturnUsed ?? config.expectedRealReturn ?? 0.05,
    fireNumberMinor: result.fireNumber.amountMinor,
    ...(config.currentAge === undefined ? {} : { currentAge: config.currentAge }),
  });

  return {
    object: "fire_projection",
    scope,
    status: "configured",
    fireNumber: { amountMinor: result.fireNumber.amountMinor, currency },
    monthlySavingsCapacity: {
      amountMinor: monthlyContributionMinor,
      currency,
    },
    scenarios: projection.scenarios.map((scenario) => toScenario(scenario, currency)),
  };
}

function toScenario(scenario: FireScenario, currency: string): AgentViewFireScenario {
  const money = (amountMinor: number): AgentViewMoney => ({ amountMinor, currency });

  return {
    label: scenario.label,
    annualReturn: scenario.annualReturn.toString(),
    yearsToFire: scenario.yearsToFire,
    ageAtFire: scenario.ageAtFire,
    finalEligible: money(scenario.finalEligibleMinor),
    totalContributed: money(scenario.totalContributedMinor),
    trajectory: scenario.trajectory.map((point) => ({
      year: point.year,
      eligible: money(point.eligibleMinor),
    })),
  };
}
