/**
 * Payouts agent-view wiring (#659): the read builders attach payouts through the
 * real store, so a regression that dropped the attachment (or wired the wrong
 * scope resolution / public-id path) is caught. Seeded like chat-tools.test.ts —
 * in-memory store, familia persona, driven through the actual `AgentViewReadStore`
 * (so the `packages/db` port wiring is exercised too). A payout touches no figure
 * (ADR 0054), so seeding one perturbs no other seeded assertion.
 */

import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, it } from "vitest";

import { buildFinancialContext } from "./financial-context";
import { buildHoldingDetail } from "./holding-detail";
import { publicIdMap } from "./scope-resolution";
import { bindScope } from "./scoped-read";
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
    const context = await buildFinancialContext(bindScope(store.agentView, scope.id), {
      asOf: AS_OF,
    });
    expect(context.passiveIncome.hasPayouts).toBe(true);
    expect(context.passiveIncome.total.amountMinor).toBeGreaterThan(0);
    expect(context.passiveIncome.months).toBe(12);
    expect(context.passiveIncome.windowEnd).toBe(AS_OF);
  }, 15_000);

  /**
   * #1627: the SAME pass that builds the detail's payouts block feeds its returns
   * fold. Before this, `buildHoldingReturns` never saw a payout, so the ficha said
   * «no están modelados» about the very dividend printed two blocks above it —
   * and contradicted both the board's row and the context's own cartera block.
   */
  it("folds the same recorded payouts into the holding's returns", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, FAMILIA_SPEC, AS_OF);

    const assets = await store.agentView.readAssets();
    const invested = (
      await Promise.all(
        assets
          .filter((asset) => asset.type === "investment")
          .map(async (asset) => ({
            asset,
            operations: await store.agentView.readOperations(asset.id),
          })),
      )
    ).find((entry) => entry.operations.length > 0);
    if (!invested) throw new Error("seed has no investment holding with operations");

    const holdingPublicId = publicIdMap(
      await store.agentView.readPublicIds(),
      "holding",
    ).get(invested.asset.id);
    if (!holdingPublicId) throw new Error("seeded asset has no public id");

    const before = await buildHoldingDetail(store.agentView, holdingPublicId);
    expect(before.returns).not.toBeNull();
    expect(before.returns?.qualitySignals.map((signal) => signal.code)).toContain(
      "DISTRIBUTIONS_NOT_CAPTURED",
    );

    await store.payouts.createPayout({
      holdingId: invested.asset.id,
      dateISO: "2026-03-01",
      amountMinor: 250_000,
      note: "Dividendo",
    });

    const after = await buildHoldingDetail(store.agentView, holdingPublicId);
    const codes = after.returns?.qualitySignals.map((signal) => signal.code) ?? [];
    expect(codes).toContain("DISTRIBUTIONS_NOT_IN_TWR");
    expect(codes).not.toContain("DISTRIBUTIONS_NOT_CAPTURED");
    // The dividend lands in the simple gain, cent for cent...
    expect(after.returns!.simple.totalGain.amountMinor).toBe(
      before.returns!.simple.totalGain.amountMinor + 250_000,
    );
    // ...without pretending more capital went in, and without touching the TWR,
    // which keeps measuring price alone (ADR 0040).
    expect(after.returns!.simple.totalInvested).toEqual(
      before.returns!.simple.totalInvested,
    );
    expect(after.returns!.timeWeighted).toEqual(before.returns!.timeWeighted);
  }, 15_000);
});
