/**
 * Payouts agent-view wiring (#659): the read builders attach payouts through the
 * real store, so a regression that dropped the attachment (or wired the wrong
 * scope resolution / public-id path) is caught. Seeded like chat-tools.test.ts —
 * in-memory store, familia persona, driven through the actual `AgentViewReadStore`
 * (so the `packages/db` port wiring is exercised too). A payout touches no figure
 * (ADR 0054), so seeding one perturbs no other seeded assertion.
 */
import { describe, expect, it } from "vitest";

import { createInMemoryStore } from "@worthline/db";

import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";

import { buildFinancialContext } from "./financial-context";
import { buildHoldingDetail } from "./holding-detail";
import { publicIdMap } from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

const AS_OF = "2026-06-19";

describe("agent-view payouts wiring", () => {
  it("attaches a holding's payouts to its detail and the scope's passive income to the context", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, FAMILIA_SPEC, AS_OF);

    const [asset] = await store.agentView.readAssets();
    if (!asset) throw new Error("seed has no asset holding");
    await store.payouts.createPayout({
      holdingId: asset.id,
      dateISO: "2026-03-01",
      amountMinor: 250_000,
      note: "Dividendo",
    });

    const holdingPublicId = publicIdMap(
      await store.agentView.readPublicIds(),
      "holding",
    ).get(asset.id);
    if (!holdingPublicId) throw new Error("seeded asset has no public id");

    // Holding detail: the recorded payout rides on the detail with a derived id.
    const detail = await buildHoldingDetail(store.agentView, holdingPublicId);
    expect(detail.payouts).not.toBeNull();
    expect(
      detail.payouts?.recorded.some((payout) => payout.amount.amountMinor === 250_000),
    ).toBe(true);
    expect(detail.payouts?.recorded[0]?.id).toMatch(/^wl_pay_/);

    // Financial context: the scope's passive income reflects the payout, weighted
    // by the household scope (which owns the seeded holding).
    const scopes = await listAgentViewScopes(store.agentView);
    const scope = scopes.find((candidate) => candidate.isDefault) ?? scopes[0];
    if (!scope) throw new Error("seed has no scope");
    const context = await buildFinancialContext(store.agentView, {
      scopeId: scope.id,
      asOf: AS_OF,
    });
    expect(context.passiveIncome.hasPayouts).toBe(true);
    expect(context.passiveIncome.total.amountMinor).toBeGreaterThan(0);
    expect(context.passiveIncome.months).toBe(12);
    expect(context.passiveIncome.windowEnd).toBe(AS_OF);
  }, 15_000);
});
