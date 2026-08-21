/**
 * The dictated traspaso, end to end (#1482, S5 of PRD #1393).
 *
 * What only this level can answer, and why the gate's own suite cannot. Both are
 * already covered elsewhere: `planTransfer`'s arithmetic and refusals in
 * `transfer-plan.test.ts`, «both or neither» in
 * `packages/db/src/commands/investment-transfer.test.ts`. What this drives is the
 * PRD's acceptance criterion for the slice — «un traspaso dictado termina en el mismo
 * par `transfer_id` que el flujo de S3, con los mismos invariantes (P/L quieto, coste
 * heredado, fecha única)» — plus the two things this lane owns alone: the figures come
 * from the user's message and not from the model's arguments, and a VL the message did
 * not give it comes from the app's own price with the card saying so — while a leg whose
 * participaciones WERE stated derives its VL and has nothing to caveat (#1544).
 *
 * Prior art: `transfer-action.test.ts` (the same traspaso through the screen) and
 * `early-repayment-proposal-action.test.ts` (the build → confirm shape).
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { derivePosition } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { confirmTransferProposalAction } from "./transfer-proposal-action";
import {
  buildTransferProposal,
  TRANSFER_DICTATED_DOCUMENT_NAME,
} from "./transfer-proposals";
import { parseTypedTransfer } from "./typed-transfer";

const ORIGIN = "origen";
const DESTINATION = "destino";
const TODAY = "2026-08-21";
const DATE = "2026-08-14";
const clock = { now: () => `${TODAY}T10:00:00.000Z`, today: () => TODAY };

/**
 * Jorge's shape of traspaso, the same fixture the screen's test uses: a plan holding
 * 100 participaciones bought at 10 € (1.000 € of cost), quoted at 12 € the day the
 * capital leaves, and a destination plan quoted at 14,50 € that day.
 */
async function seed({
  priceDestination = true,
  priceOrigin = true,
} = {}): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: ORIGIN,
    instrument: "pension_plan",
    liquidityTier: "term-locked",
    name: "Indexado PP",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: DESTINATION,
    instrument: "pension_plan",
    liquidityTier: "term-locked",
    name: "Cartera Permanente PP",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  await store.command.recordInvestmentOperation(
    {
      assetId: ORIGIN,
      currency: "EUR",
      executedAt: "2025-01-15",
      feesMinor: 0,
      id: "op_compra",
      kind: "buy",
      pricePerUnit: "10",
      units: "100",
    },
    { today: TODAY },
  );
  if (priceOrigin) await price(store, ORIGIN, "12");
  if (priceDestination) await price(store, DESTINATION, "14.50");
  return store;
}

/** A quoted price for the transfer's own day, so no provenance note is warranted. */
async function price(store: WorthlineStore, assetId: string, value: string) {
  await store.operations.upsertPrice({
    assetId,
    currency: "EUR",
    fetchedAt: `${DATE}T18:00:00.000Z`,
    freshnessState: "fresh",
    price: value,
    priceDate: DATE,
    source: "finect",
  });
}

/** The slice of the store the builder takes — the same four the chat tool hands it. */
function storeSlice(store: WorthlineStore) {
  return {
    agentView: store.agentView,
    assets: store.assets,
    assistantProposals: store.assistantProposals,
    operations: store.operations,
  };
}

/** Build the card from a message worthline parses, exactly as the tool does. */
async function draft(store: WorthlineStore, message: string) {
  const reading = parseTypedTransfer(message, TODAY);
  if (reading.status !== "read") {
    throw new Error(`the message was not read: ${JSON.stringify(reading)}`);
  }
  return buildTransferProposal(
    storeSlice(store),
    {
      destinationAssetId: DESTINATION,
      destinationHolding: "wl_hld_destino",
      originAssetId: ORIGIN,
      originHolding: "wl_hld_origen",
      transfer: reading.transfer,
    },
    TODAY,
  );
}

async function positionOf(store: WorthlineStore, assetId: string) {
  return derivePosition(await store.operations.readOperations(assetId), {
    assetId,
    currency: "EUR",
  });
}

const DICTATED = `El 14/08/2026 traspasé 739,22 € del Indexado al Cartera Permanente`;

describe("buildTransferProposal — the card of a dictated traspaso", () => {
  test("echoes what worthline read in the message, and both derived halves", async () => {
    const store = await seed();

    const built = await draft(store, DICTATED);
    if (!built.ok) throw new Error(built.error);

    // The ceremony of this lane: the importe and the date as PARSED, so a misread is
    // caught before two rows move real capital.
    expect(built.proposal.dictated).toBe("14/08/2026 · 739,22 €");
    // 739,22 € ÷ 12 € = 61,601667 participaciones out; ÷ 14,50 € = 50,98069 in. Two
    // unrelated figures, which is the instrument.
    expect(built.proposal.origin.movementLine).toContain("61,601667 part. × 12 €");
    expect(built.proposal.destination.movementLine).toContain("50,98069 part. × 14,5 €");
    expect(built.proposal.origin.positionLine).toBe(
      "Salen de «Indexado PP»: 100 → 38,398333 participaciones",
    );
    expect(built.proposal.destination.positionLine).toBe(
      "Entran en «Cartera Permanente PP»: 0 → 50,98069 participaciones",
    );
    // The cost that travels: 61,601667/100 of a 1.000 € basis.
    expect(built.proposal.inheritedCost).toContain("616,02");
    // The impact is around zero because a traspaso moves capital: it does not create
    // it. Never exactly zero — two VLs, six decimals.
    expect(Math.abs(built.proposal.impact.deltaMinor)).toBeLessThan(5);
    expect(built.proposal.notes[0]).toContain("no realiza plusvalía");
    store.close();
  });

  test("records the fact as backed by the USER's message, not by a document", async () => {
    const store = await seed();

    const built = await draft(store, DICTATED);
    if (!built.ok) throw new Error(built.error);

    // Provenance `user` and a name the app fixes: what grounds this write is the
    // person's own message (#1418's rule), and letting a document's name onto it would
    // claim paper that does not exist.
    const proposal = await store.assistantProposals.read(built.proposal.draft.proposalId);
    expect(proposal?.documents[0]?.document).toMatchObject({
      name: TRANSFER_DICTATED_DOCUMENT_NAME,
      provenance: "user",
    });
    // The INTENT is what is persisted — the pair is minted by the gate at confirm — so
    // the draft carries the portion as dictated and no derived participaciones.
    expect(proposal?.documents[0]?.facts[0]).toMatchObject({
      kind: "investment_transfer",
      row: { executedAt: DATE, portion: { amountMinor: 73922, kind: "amount" } },
    });
    store.close();
  });

  test("says which VL it borrowed when the price is not the transfer date's", async () => {
    const store = await seed();
    await store.operations.upsertPrice({
      assetId: ORIGIN,
      currency: "EUR",
      fetchedAt: `${TODAY}T18:00:00.000Z`,
      freshnessState: "fresh",
      price: "12",
      priceDate: TODAY,
      source: "finect",
    });

    const built = await draft(store, DICTATED);
    if (!built.ok) throw new Error(built.error);

    expect(built.proposal.notes.join(" ")).toContain("es del 21/08/2026");
    expect(built.proposal.notes.join(" ")).toContain("«Traspasar»");
    store.close();
  });

  test("refuses, naming the holding, when a side has no VL at all", async () => {
    const store = await seed({ priceDestination: false });

    const built = await draft(store, DICTATED);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("«Cartera Permanente PP»");
    expect(built.error).toContain("«Traspasar»");
    store.close();
  });

  test("dictated participaciones derive the VL, so there is nothing to caveat (#1544)", async () => {
    // The origin's cached price is from ANOTHER day, which is exactly the case that
    // used to earn a provenance note — the note existed because the model needed the
    // unstable datum. Stated participaciones remove the need for it entirely.
    const store = await seed();
    for (const [assetId, price] of [
      [ORIGIN, "13.40"],
      [DESTINATION, "15.10"],
    ] as const) {
      await store.operations.upsertPrice({
        assetId,
        currency: "EUR",
        fetchedAt: `${TODAY}T18:00:00.000Z`,
        freshnessState: "fresh",
        price,
        priceDate: TODAY,
        source: "finect",
      });
    }

    const built = await draft(
      store,
      "El 14/08/2026 traspasé 61,601667 participaciones (739,22 €) del Indexado al Cartera Permanente",
    );
    if (!built.ok) throw new Error(built.error);

    // Both figures echoed, because both were written.
    expect(built.proposal.dictated).toContain("61,601667 participaciones · ");
    expect(built.proposal.dictated).toContain("739,22");
    // The participaciones are the stated ones, and the VL is DERIVED from them and the
    // importe — 11,99999994 €, not the 13,40 € the app has cached. The trailing
    // decimals are the point rather than a wart: they are where the difference between
    // the user's two figures lands, instead of landing on the participaciones.
    expect(built.proposal.origin.movementLine).toContain("61,601667 part. × 11,99999994");
    expect(built.proposal.origin.positionLine).toBe(
      "Salen de «Indexado PP»: 100 → 38,398333 participaciones",
    );
    // No note about where the origin's VL came from: it came from the user's own two
    // figures. The DESTINATION's note survives, and that asymmetry is deliberate — a
    // dictated traspaso states one unit count, so the arriving half is still divided at
    // the app's price and still says so. Two counts route to the screen instead.
    const notes = built.proposal.notes.join(" ");
    expect(notes).not.toContain("VL de origen");
    expect(notes).toContain("VL de destino");
    store.close();
  });

  test("a traspaso stated in participaciones works even with no price for the origin", async () => {
    const store = await seed({ priceOrigin: false });

    const built = await draft(
      store,
      "El 14/08/2026 traspasé 61,601667 participaciones (739,22 €) del Indexado al Cartera Permanente",
    );

    // Before #1544 this was a dead end: no VL, no arithmetic. The figures the user
    // wrote are enough.
    expect(built.ok).toBe(true);
    store.close();
  });

  test("refuses an importe the position does not cover on that date", async () => {
    const store = await seed();

    const built = await draft(
      store,
      "El 14/08/2026 traspasé 5.000 € del Indexado al Cartera Permanente",
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("participaciones");
    store.close();
  });

  test("refuses a future date rather than dating a movement that has not happened", async () => {
    const store = await seed();

    const built = await draft(
      store,
      "El 30/08/2026 traspasé 739,22 € del Indexado al Cartera Permanente",
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("futuro");
    store.close();
  });

  test("refuses two ledgers in different currencies: the cost that travels has no rate", async () => {
    const store = await seed();
    await store.assets.createInvestmentAsset({
      currency: "USD",
      id: "dolares",
      instrument: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "14.50",
      name: "Vanguard USD",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    const reading = parseTypedTransfer(DICTATED, TODAY);
    if (reading.status !== "read") throw new Error("unreadable fixture");

    const built = await buildTransferProposal(
      storeSlice(store),
      {
        destinationAssetId: "dolares",
        destinationHolding: "wl_hld_dolares",
        originAssetId: ORIGIN,
        originHolding: "wl_hld_origen",
        transfer: reading.transfer,
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("no puedo traspasar entre divisas distintas");
    store.close();
  });

  test("refuses a side the sync owns, on EITHER leg (#1326)", async () => {
    for (const owned of [ORIGIN, DESTINATION]) {
      const store = await seed();
      const reading = parseTypedTransfer(DICTATED, TODAY);
      if (reading.status !== "read") throw new Error("unreadable fixture");

      // The guard reads the agent view's connected sources, so that read IS the seam:
      // a holding a source materializes has its position re-rolled by the next sync,
      // and the gate throws on one rather than answering.
      const built = await buildTransferProposal(
        {
          ...storeSlice(store),
          agentView: {
            ...store.agentView,
            readConnectedSources: async () => [
              {
                adapter: "binance",
                assetIds: [owned],
                id: "src",
                label: "Binance de Jorge",
                positionCount: 1,
              } as never,
            ],
          },
        },
        {
          destinationAssetId: DESTINATION,
          destinationHolding: "wl_hld_destino",
          originAssetId: ORIGIN,
          originHolding: "wl_hld_origen",
          transfer: reading.transfer,
        },
        TODAY,
      );

      expect(built.ok, owned).toBe(false);
      if (built.ok) return;
      expect(built.error, owned).toContain("Binance de Jorge");
      store.close();
    }
  });

  test("refuses a traspaso to the same holding", async () => {
    const store = await seed();
    const reading = parseTypedTransfer(DICTATED, TODAY);
    if (reading.status !== "read") throw new Error("unreadable fixture");

    const built = await buildTransferProposal(
      storeSlice(store),
      {
        destinationAssetId: ORIGIN,
        destinationHolding: "wl_hld_origen",
        originAssetId: ORIGIN,
        originHolding: "wl_hld_origen",
        transfer: reading.transfer,
      },
      TODAY,
    );

    expect(built.ok).toBe(false);
    store.close();
  });
});

describe("confirmTransferProposalAction — the pair the gate writes", () => {
  test("writes ONE pair tied by one transferId, with the cost inherited (#1393)", async () => {
    const store = await seed();
    const built = await draft(store, DICTATED);
    if (!built.ok) throw new Error(built.error);

    const result = await confirmTransferProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    const out = (await store.operations.readOperations(ORIGIN)).find(
      (operation) => operation.kind === "transfer_out",
    );
    const incoming = (await store.operations.readOperations(DESTINATION)).find(
      (operation) => operation.kind === "transfer_in",
    );
    expect(out?.transferId).toBeDefined();
    // The pair is ONE movement: same id, same date — the invariant of S1 (#1478).
    expect(incoming?.transferId).toBe(out?.transferId);
    expect(out?.executedAt.slice(0, 10)).toBe(DATE);
    expect(incoming?.executedAt.slice(0, 10)).toBe(DATE);
    // The acquisition cost travels on the incoming row, and the ledger says so.
    expect(incoming?.transferCostMinor).toBe(61602);
    expect(out?.source).toBe("agent");
    // No plusvalía is realized: the origin's realized P/L is untouched by a traspaso.
    const origin = await positionOf(store, ORIGIN);
    expect(origin.realizedPnl?.amountMinor ?? 0).toBe(0);
    expect(origin.currentUnits).toBe("38.398333");
    expect((await positionOf(store, DESTINATION)).currentUnits).toBe("50.98069");
    expect(
      await store.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({ status: "applied" });
    store.close();
  });

  test("«todo» liquidates the origin exactly, with no dust left behind", async () => {
    const store = await seed();
    const built = await draft(
      store,
      "El 14/08/2026 traspasé todo el Indexado al Cartera Permanente",
    );
    if (!built.ok) throw new Error(built.error);

    expect(
      await confirmTransferProposalAction(built.proposal.draft, store, clock),
    ).toEqual({ status: "applied" });

    expect((await positionOf(store, ORIGIN)).currentUnits).toBe("0");
    store.close();
  });

  test("re-projects against live data: a position that moved refuses, writing nothing", async () => {
    const store = await seed();
    const built = await draft(store, DICTATED);
    if (!built.ok) throw new Error(built.error);

    // Between arming the card and confirming it, the units leave by another door.
    await store.command.recordInvestmentOperation(
      {
        assetId: ORIGIN,
        currency: "EUR",
        executedAt: "2026-08-13",
        feesMinor: 0,
        id: "op_venta",
        kind: "sell",
        pricePerUnit: "12",
        units: "95",
      },
      { today: TODAY },
    );

    const result = await confirmTransferProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result.status).toBe("error");
    expect(
      (await store.operations.readOperations(ORIGIN)).some(
        (operation) => operation.kind === "transfer_out",
      ),
    ).toBe(false);
    expect(
      await store.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({ status: "draft" });
    store.close();
  });

  test("the same traspaso dictated twice is reported, not doubled", async () => {
    const store = await seed();
    const first = await draft(store, DICTATED);
    if (!first.ok) throw new Error(first.error);
    await confirmTransferProposalAction(first.proposal.draft, store, clock);

    const second = await draft(store, DICTATED);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("ya está anotado");
    store.close();
  });
});
