import type { FireScenario } from "@worthline/domain";
import { monthlySavingsCapacityForFire, projectFireFromContext } from "@worthline/domain";

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
 *
 * The savings capacity is the declared scalar and only that (#1416, ADR 0074):
 * the scope's contribution plan no longer overrides it, so `get_fire_projection`
 * and `get_fire_context` report the same monthly figure by construction.
 */
export async function buildFireProjection(
  scoped: ScopedAgentView,
): Promise<AgentViewFireProjection> {
  const { scope, fire } = await resolveFire(scoped);

  if (fire.config === undefined || fire.result === undefined) {
    return { object: "fire_projection", scope, status: "unconfigured", scenarios: [] };
  }

  const result = fire.result;
  const currency = fire.currency;
  const monthlyContributionMinor = monthlySavingsCapacityForFire(fire.config);

  // #1026: the resolved rate, FIRE number and age all ride in the context, so
  // this projection is coherent with coast + levels by construction.
  const projection = projectFireFromContext(result.context, {
    monthlyContributionMinor,
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
