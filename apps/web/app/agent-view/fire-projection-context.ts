import type { AgentViewReadStore } from "@worthline/db";
import type { FireScenario } from "@worthline/domain";
import { projectFire } from "@worthline/domain";

import type {
  AgentViewFireProjection,
  AgentViewFireScenario,
  AgentViewMoney,
} from "./contract";
import { resolveFire } from "./fire-context";

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
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<AgentViewFireProjection> {
  const { scope, fire } = await resolveFire(store, publicScopeId);

  if (fire.config === undefined || fire.result === undefined) {
    return { object: "fire_projection", scope, status: "unconfigured", scenarios: [] };
  }

  const config = fire.config;
  const result = fire.result;
  const currency = fire.currency;

  // N3 (#515): use result.realReturnUsed (the single resolved rate) — not
  // config.expectedRealReturn directly — so projection is coherent with coast.
  const projection = projectFire({
    startingEligibleMinor: result.eligibleAssets.amountMinor,
    monthlyContributionMinor: config.monthlySavingsCapacityMinor ?? 0,
    expectedRealReturn: result.realReturnUsed ?? config.expectedRealReturn ?? 0.05,
    fireNumberMinor: result.fireNumber.amountMinor,
    ...(config.currentAge === undefined ? {} : { currentAge: config.currentAge }),
  });

  return {
    object: "fire_projection",
    scope,
    status: "configured",
    fireNumber: { amountMinor: result.fireNumber.amountMinor, currency },
    ...(config.monthlySavingsCapacityMinor === undefined
      ? {}
      : {
          monthlySavingsCapacity: {
            amountMinor: config.monthlySavingsCapacityMinor,
            currency,
          },
        }),
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
