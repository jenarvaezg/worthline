import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { confirmPropertyValuationProposalAction } from "./property-valuation-proposal-action";
import { buildPropertyValuationProposal } from "./property-valuation-proposals";

async function propertyStore() {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    id: "home",
    name: "Casa",
    type: "real_estate",
    currency: "EUR",
    currentValueMinor: 300_000_00,
    liquidityTier: "housing",
    isPrimaryResidence: true,
    ownership: [{ memberId: "m", shareBps: 10_000 }],
  });
  return store;
}

describe("property valuation assistant proposal (#769)", () => {
  test("persists a typed date+value fact and returns an unverified curve preview", async () => {
    const store = await propertyStore();
    const built = await buildPropertyValuationProposal(
      store,
      {
        assetId: "home",
        documentName: "tasacion.pdf",
        documentSha256: "a".repeat(64),
        valuationDate: "2020-06-15",
        valueMinor: 220_000_00,
      },
      "2026-07-12",
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal).toMatchObject({
      anchor: { valuationDate: "2020-06-15", valueMinor: 220_000_00 },
      trust: { tier: "unverified", requiresReview: true },
    });
    expect(built.proposal.curve[0]).toEqual({
      date: "2020-06-15",
      valueMinor: 220_000_00,
    });
    expect(
      await store.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({
      kind: "property_valuation_anchor",
      documents: [
        { facts: [{ kind: "property_valuation_anchor", row: { assetId: "home" } }] },
      ],
    });
  });

  test("confirmation adds a market anchor through ripple with agent provenance", async () => {
    const store = await propertyStore();
    const built = await buildPropertyValuationProposal(
      store,
      {
        assetId: "home",
        documentName: "tasacion.pdf",
        documentSha256: "b".repeat(64),
        valuationDate: "2020-06-15",
        valueMinor: 220_000_00,
      },
      "2026-07-12",
    );
    if (!built.ok) throw new Error(built.error);
    const result = await confirmPropertyValuationProposalAction(
      built.proposal.draft,
      store,
      { today: () => "2026-07-12" },
    );
    expect(result).toEqual({ status: "applied" });
    expect(await store.assets.readValuationAnchors("home")).toMatchObject([
      {
        adjustsPriorCurve: true,
        source: "agent",
        valuationDate: "2020-06-15",
        valueMinor: 220_000_00,
      },
    ]);
  });
});
