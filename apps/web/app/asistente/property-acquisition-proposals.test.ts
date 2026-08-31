/**
 * The acquisition anchor proposed by chat (#1563, hija de #1437).
 *
 * The date and the price of an acquisition are the ALLOWED side of the
 * unvalidated-evidence frontier (#1248): a single fact verifiable at a glance —
 * a deed, a note, the user's own Excel — never a figure that needs research. So
 * these tests pin two things: that the lane refuses everything that is not that
 * single fact, and that a confirmation lands on the SAME anchor the ficha edits,
 * through the deterministic ripple, without ever minting a second one.
 */

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  confirmPropertyAcquisitionProposalAction,
  discardPropertyAcquisitionProposalAction,
} from "./property-acquisition-proposal-action";
import {
  buildPropertyAcquisitionProposal,
  projectPropertyAcquisitionProposal,
} from "./property-acquisition-proposals";

const TODAY = "2026-08-26";

/** Jorge's flat as worthline holds it today: acquired «the day he typed it». */
async function propertyStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 233_000_00,
    id: "piso",
    isPrimaryResidence: true,
    liquidityTier: "housing",
    name: "Piso de Plasencia",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "real_estate",
  });
  await store.command.addValuationAnchor(
    {
      adjustsPriorCurve: true,
      assetId: "piso",
      id: "anchor_piso_acquisition",
      kind: "acquisition",
      valuationDate: "2026-07-02",
      valueMinor: 210_000_00,
    },
    { today: TODAY },
  );
  return store;
}

/** The real ask: 19 May 2004, 150.253,03 € — both figures are in his Excel. */
const JORGE = {
  acquisitionDate: "2004-05-19",
  acquisitionValueMinor: 150_253_03,
  assetId: "piso",
};

describe("property acquisition assistant proposal (#1563)", () => {
  test("previews the move as a before → after over the SAME anchor", async () => {
    const store = await propertyStore();
    const built = await buildPropertyAcquisitionProposal(store, JORGE, TODAY);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal).toMatchObject({
      property: { id: "piso", name: "Piso de Plasencia" },
      proposalType: "property_acquisition",
      summary: "Adquisición de «Piso de Plasencia»: 19/05/2004 · 150.253,03\u00a0€",
    });
    // The pair of figures the user is confirming, both sides rendered es-ES: a
    // card that showed only the new values would be asking him to confirm a
    // rewrite of 22 years without showing what it replaces.
    expect(built.proposal.rows).toEqual([
      { after: "19/05/2004", before: "02/07/2026", label: "Fecha de adquisición" },
      {
        after: "150.253,03\u00a0€",
        before: "210.000,00\u00a0€",
        label: "Valor en la fecha de compra",
      },
    ]);
    // The curve now starts where the acquisition does — the whole point of the
    // ticket: with it dated 2026 his 2004 mortgage had no property to hang on.
    // Valued by the domain preview of #1562, so the card and the ficha's own
    // ceremony draw the same two curves.
    expect(built.proposal.points[0]).toMatchObject({
      afterMinor: 150_253_03,
      dateKey: "2004-05-19",
      role: "acquisition_new",
    });
    // And the stretch the rewrite redraws is SAMPLED, not just its endpoints: a
    // price-only change would otherwise show one row moving.
    expect(built.proposal.points.length).toBeGreaterThan(3);
    expect(built.proposal.points.at(-1)).toMatchObject({ dateKey: TODAY });
    // And the fact is persisted TYPED, as an edit of the acquisition and not as
    // one more tasación.
    expect(
      await store.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({
      documents: [
        {
          facts: [
            {
              kind: "property_acquisition",
              row: {
                assetId: "piso",
                valuationDate: "2004-05-19",
                valueMinor: 150_253_03,
              },
            },
          ],
        },
      ],
      kind: "property_acquisition",
      status: "draft",
    });
  });

  test("says the history will start there when the date moves back", async () => {
    const store = await propertyStore();
    const built = await buildPropertyAcquisitionProposal(store, JORGE, TODAY);
    if (!built.ok) throw new Error(built.error);

    expect(built.proposal.notes.join(" ")).toMatch(/19\/05\/2004/);
  });

  test("refuses a property with no acquisition anchor, routing to its ficha", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000_00,
      id: "trastero",
      liquidityTier: "housing",
      name: "Trastero",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "real_estate",
    });

    const built = await buildPropertyAcquisitionProposal(
      store,
      { ...JORGE, assetId: "trastero" },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/adquisici/i);
    expect(built.error).toMatch(/patrimonio/i);
  });

  test("refuses an asset that is not a property", async () => {
    const store = await propertyStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 2_500_00,
      id: "cuenta",
      instrument: "current_account",
      liquidityTier: "cash",
      name: "Cuenta BBVA",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "cash",
    });

    const built = await buildPropertyAcquisitionProposal(
      store,
      { ...JORGE, assetId: "cuenta" },
      TODAY,
    );
    expect(built.ok).toBe(false);
  });

  test("refuses a future date and a value that is not integer cents", async () => {
    const store = await propertyStore();

    const future = await buildPropertyAcquisitionProposal(
      store,
      { ...JORGE, acquisitionDate: "2027-01-01" },
      TODAY,
    );
    expect(future.ok).toBe(false);

    // 150253.03 € typed as if it were cents: rounding it would write a figure
    // nobody read, so it is refused like the early repayment's amount (#1245).
    const euros = await buildPropertyAcquisitionProposal(
      store,
      { ...JORGE, acquisitionValueMinor: 150_253.03 },
      TODAY,
    );
    expect(euros.ok).toBe(false);

    const zero = await buildPropertyAcquisitionProposal(
      store,
      { ...JORGE, acquisitionValueMinor: 0 },
      TODAY,
    );
    expect(zero.ok).toBe(false);

    // Nothing was persisted by any of the three.
    expect(await store.assets.readValuationAnchors("piso")).toHaveLength(1);
  });

  test("refuses a proposal that changes nothing", async () => {
    const store = await propertyStore();
    const built = await buildPropertyAcquisitionProposal(
      store,
      {
        acquisitionDate: "2026-07-02",
        acquisitionValueMinor: 210_000_00,
        assetId: "piso",
      },
      TODAY,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/ya/i);
  });

  test("refuses a date another tasación already occupies", async () => {
    const store = await propertyStore();
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "anchor_piso_2026",
        valuationDate: "2026-07-09",
        valueMinor: 233_000_00,
      },
      { today: TODAY },
    );

    const built = await buildPropertyAcquisitionProposal(
      store,
      { ...JORGE, acquisitionDate: "2026-07-09" },
      TODAY,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/fecha/i);
  });

  test("previews and writes a legacy demoted anchor as the appraisal it is", async () => {
    // A live workspace can hold an acquisition stored as an IMPROVEMENT: until
    // #1562 the ficha's own form posted no `adjustsPriorCurve` and demoted it on
    // every save. The invariant now lives in `updateValuationAnchorAndRipple`
    // (moved down there in #1563 because this proposal's confirm reaches that seam
    // without passing through the web command), so the write repairs the row — and
    // the preview has to be drawn by that same rule, or the card would show a
    // curve nobody is about to write (#1438).
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 233_000_00,
      id: "piso",
      liquidityTier: "housing",
      name: "Piso",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: false,
        assetId: "piso",
        id: "anchor_piso_acquisition",
        kind: "acquisition",
        valuationDate: "2026-07-02",
        valueMinor: 210_000_00,
      },
      { today: TODAY },
    );

    const built = await buildPropertyAcquisitionProposal(store, JORGE, TODAY);
    if (!built.ok) throw new Error(built.error);
    const preview = built.proposal.points;

    await confirmPropertyAcquisitionProposalAction(built.proposal.draft, store, {
      now: () => `${TODAY}T00:00:00.000Z`,
      today: () => TODAY,
    });
    // Repaired by the write, not preserved: an acquisition is a market appraisal.
    const anchors = await store.assets.readValuationAnchors("piso");
    expect(anchors).toMatchObject([
      { adjustsPriorCurve: true, kind: "acquisition", valuationDate: "2004-05-19" },
    ]);

    // The price anchors the curve, so the point on its date IS the price — the
    // reading an increment would not give (it would leave the interpolated
    // 233.000,00 € there and add the purchase price on top).
    expect(preview[0]).toMatchObject({
      afterMinor: 150_253_03,
      dateKey: "2004-05-19",
    });

    // And a second projection over the applied state refuses as a no-op, which is
    // the proof the write landed on exactly the previewed pair.
    const written = await projectPropertyAcquisitionProposal(
      store,
      { assetId: "piso", valuationDate: "2004-05-19", valueMinor: 150_253_03 },
      TODAY,
    );
    expect(written.ok).toBe(false);
  });

  test("confirmation moves the acquisition through the deterministic ripple", async () => {
    const store = await propertyStore();
    const built = await buildPropertyAcquisitionProposal(store, JORGE, TODAY);
    if (!built.ok) throw new Error(built.error);

    const result = await confirmPropertyAcquisitionProposalAction(
      built.proposal.draft,
      store,
      { today: () => TODAY, now: () => `${TODAY}T00:00:00.000Z` },
    );

    expect(result).toEqual({ status: "applied" });
    // ONE anchor, still the acquisition, with the new pair: an edit, never an add.
    expect(await store.assets.readValuationAnchors("piso")).toMatchObject([
      {
        id: "anchor_piso_acquisition",
        kind: "acquisition",
        valuationDate: "2004-05-19",
        valueMinor: 150_253_03,
      },
    ]);
    expect(
      await store.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({ status: "applied" });
  });

  test("a confirmed proposal cannot be applied twice", async () => {
    const store = await propertyStore();
    const built = await buildPropertyAcquisitionProposal(store, JORGE, TODAY);
    if (!built.ok) throw new Error(built.error);
    const clock = { now: () => `${TODAY}T00:00:00.000Z`, today: () => TODAY };

    await confirmPropertyAcquisitionProposalAction(built.proposal.draft, store, clock);
    const again = await confirmPropertyAcquisitionProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(again.status).toBe("error");
  });

  test("discarding resolves the draft and writes nothing", async () => {
    const store = await propertyStore();
    const built = await buildPropertyAcquisitionProposal(store, JORGE, TODAY);
    if (!built.ok) throw new Error(built.error);

    const result = await discardPropertyAcquisitionProposalAction(
      built.proposal.draft,
      store,
      { today: () => TODAY, now: () => `${TODAY}T00:00:00.000Z` },
    );

    expect(result).toEqual({ status: "discarded" });
    expect(await store.assets.readValuationAnchors("piso")).toMatchObject([
      { valuationDate: "2026-07-02", valueMinor: 210_000_00 },
    ]);
  });
});
