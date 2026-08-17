/**
 * Reconstruction correction builder + confirm (#1053, PRD #1048 S5): the
 * "Reconstruir historia" depth. The builder persists a `correction` proposal
 * carrying the raw dated balance series and before-values, and the confirm
 * re-projects the (possibly point-edited) series against live data before
 * applying it as ONE atomic batch. Exercised through the same seams as #983.
 */

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { fixedClock } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  confirmCorrectionProposalAction,
  discardCorrectionProposalAction,
} from "./correction-proposal-action";
import { RECONSTRUCTION_AMENDMENT_MESSAGES } from "./reconstruction-amendment";
import {
  buildReconstructionAmendment,
  buildReconstructionProposal,
  RECONSTRUCTION_AMENDMENT_UNAVAILABLE,
} from "./reconstruction-proposals";

const TODAY = "2026-07-12";
const clock = fixedClock(`${TODAY}T00:00:00.000Z`);

async function seedMortgage(
  debtModel: "amortizable" | "revolving" = "amortizable",
): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 140_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", debtModel);
  if (debtModel === "amortizable") {
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        disbursementDate: "2026-01-15",
        firstPaymentDate: "2026-02-15",
        id: "plan",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        termMonths: 240,
      },
      { today: TODAY },
    );
  }
  return store;
}

function args(rows: Array<{ date: string; balanceMinor: number }>) {
  return {
    documentName: "cuadro.pdf",
    liabilityId: "mortgage",
    publicHoldingId: "wl_hld_mortgage",
    rows,
  };
}

/** Una serie con cola: los dos últimos puntos son los «estimados» del caso real. */
const SERIES = [
  { balanceMinor: 148_000_00, date: "2026-04-12" },
  { balanceMinor: 145_000_00, date: "2026-05-12" },
  { balanceMinor: 142_000_00, date: "2026-06-12" },
  { balanceMinor: 140_000_00, date: TODAY },
];

describe("buildReconstructionProposal (#1053)", () => {
  test("builds a superficie-C reconstruct proposal reconciled to the anchor", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([
        { balanceMinor: 145_000_00, date: "2026-04-12" },
        { balanceMinor: 140_000_00, date: TODAY },
      ]),
      TODAY,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.proposalType).toBe("correction");
    expect(built.proposal.mode).toBe("reconstruir");
    expect(built.proposal.anchorMinor).toBe(140_000_00);
    expect(built.proposal.guarantee).toEqual({
      anchorMinor: 140_000_00,
      resultingMinor: 140_000_00,
      state: "reconciled",
    });
    expect(built.proposal.curve.length).toBeGreaterThan(0);
    expect(built.proposal.series.every((point) => point.origin === "assistant")).toBe(
      true,
    );
    store.close();
  });

  test("persists a reconstruct correction fact with the raw series and before-values", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);
    const stored = await store.assistantProposals.read(built.proposal.draft.proposalId);
    expect(stored?.kind).toBe("correction");
    const fact = stored?.documents.flatMap((doc) => doc.facts)[0];
    expect(fact?.kind).toBe("holding_correction");
    if (fact?.kind === "holding_correction" && fact.row.mode === "reconstruct") {
      expect(fact.row.liabilityId).toBe("mortgage");
      expect(fact.row.observations).toEqual([{ balanceMinor: 140_000_00, date: TODAY }]);
      expect(fact.row.before).toEqual({ balanceMinor: 140_000_00 });
    } else {
      throw new Error("expected a reconstruct holding_correction fact");
    }
    expect(JSON.stringify(stored)).not.toContain("rawText");
    store.close();
  });

  test("marks a series that does not reconcile as a mismatch", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 130_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);
    expect(built.proposal.guarantee.state).toBe("mismatch");
    store.close();
  });

  test("rejects a non-amortizable debt instead of guessing", async () => {
    const store = await seedMortgage("revolving");
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    expect(built).toEqual({
      error: "La deuda no existe o no es amortizable.",
      ok: false,
    });
    store.close();
  });
});

describe("buildReconstructionAmendment (#1423)", () => {
  async function openReconstruction(store: WorthlineStore) {
    const built = await buildReconstructionProposal(store, args(SERIES), TODAY);
    if (!built.ok) throw new Error(built.error);
    return built.proposal;
  }

  test("«quita los puntos estimados» es una llamada de dos campos, no 49 filas", async () => {
    const store = await seedMortgage();
    const open = await openReconstruction(store);

    const amended = await buildReconstructionAmendment(
      store,
      {
        operations: [{ action: "exclude", from: "2026-06-12" }],
        proposalId: open.draft.proposalId,
      },
      TODAY,
    );

    expect(amended.ok).toBe(true);
    if (!amended.ok) return;
    expect(amended.proposal.mode).toBe("reconstruir");
    expect(amended.proposal.summary).toContain("(enmendada)");
    // La tarjeta sigue mostrando los cuatro puntos: los quitados, con su casilla
    // marcada y el motivo, para que desmarcarlos sea un clic.
    expect(
      amended.proposal.series.map((point) => [point.date, point.excluded ?? false]),
    ).toEqual([
      ["2026-04-12", false],
      ["2026-05-12", false],
      ["2026-06-12", true],
      [TODAY, true],
    ]);
    expect(amended.proposal.series.at(-1)?.reason).toBe("Excluido a tu petición");
    store.close();
  });

  test("persiste la enmienda COMO CAPA: la serie observada sigue siendo la del documento", async () => {
    const store = await seedMortgage();
    const open = await openReconstruction(store);

    const amended = await buildReconstructionAmendment(
      store,
      {
        operations: [
          { action: "exclude", from: "2026-06-12" },
          { action: "set_balance", balanceMinor: 147_500_00, date: "2026-04-12" },
        ],
        proposalId: open.draft.proposalId,
      },
      TODAY,
    );
    if (!amended.ok) throw new Error(amended.error);

    const stored = await store.assistantProposals.read(amended.proposal.draft.proposalId);
    const fact = stored?.documents.flatMap((doc) => doc.facts).at(-1);
    if (fact?.kind !== "holding_correction" || fact.row.mode !== "reconstruct") {
      throw new Error("expected a reconstruct holding_correction fact");
    }
    expect(fact.row.observations).toEqual(SERIES);
    expect(fact.row.amendments).toEqual([
      { balanceMinor: 147_500_00, date: "2026-04-12" },
      { date: "2026-06-12", excluded: true },
      { date: TODAY, excluded: true },
    ]);
    expect(fact.row.amendedFrom).toBe(open.draft.proposalId);
    // El importe corregido se pinta como tuyo, igual que si lo hubieras teclado.
    expect(amended.proposal.series[0]).toMatchObject({
      balanceMinor: 147_500_00,
      origin: "user",
    });
    store.close();
  });

  test("descarta la propuesta enmendada: su tarjeta ya no puede aplicar la serie vieja", async () => {
    const store = await seedMortgage();
    const open = await openReconstruction(store);

    const amended = await buildReconstructionAmendment(
      store,
      {
        operations: [{ action: "exclude", date: TODAY }],
        proposalId: open.draft.proposalId,
      },
      TODAY,
    );
    if (!amended.ok) throw new Error(amended.error);

    expect((await store.assistantProposals.read(open.draft.proposalId))?.status).toBe(
      "discarded",
    );
    // Y el botón de la tarjeta vieja lo dice en vez de escribir.
    expect(await confirmCorrectionProposalAction(open.draft, store, clock)).toEqual({
      message: "La propuesta ya no está disponible.",
      status: "error",
    });
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    store.close();
  });

  test("se puede enmendar la enmienda: la cadena reincluye lo que quitó", async () => {
    const store = await seedMortgage();
    const open = await openReconstruction(store);
    const first = await buildReconstructionAmendment(
      store,
      {
        operations: [{ action: "exclude", from: "2026-06-12" }],
        proposalId: open.draft.proposalId,
      },
      TODAY,
    );
    if (!first.ok) throw new Error(first.error);

    const second = await buildReconstructionAmendment(
      store,
      {
        operations: [{ action: "include", date: TODAY }],
        proposalId: first.proposal.draft.proposalId,
      },
      TODAY,
    );
    if (!second.ok) throw new Error(second.error);

    expect(
      second.proposal.series.filter((point) => point.excluded).map((point) => point.date),
    ).toEqual(["2026-06-12"]);
    store.close();
  });

  test("una enmienda que no toca nada deja la propuesta original en pie", async () => {
    const store = await seedMortgage();
    const open = await openReconstruction(store);

    const amended = await buildReconstructionAmendment(
      store,
      {
        operations: [{ action: "exclude", from: "2027-01-01" }],
        proposalId: open.draft.proposalId,
      },
      TODAY,
    );

    expect(amended).toEqual({
      error: RECONSTRUCTION_AMENDMENT_MESSAGES.emptySelection,
      ok: false,
    });
    expect((await store.assistantProposals.read(open.draft.proposalId))?.status).toBe(
      "draft",
    );
    store.close();
  });

  test("no enmienda una propuesta que ya no está abierta, y lo dice", async () => {
    const store = await seedMortgage();
    const open = await openReconstruction(store);
    await discardCorrectionProposalAction(open.draft, store, clock);

    const amended = await buildReconstructionAmendment(
      store,
      {
        operations: [{ action: "exclude", date: TODAY }],
        proposalId: open.draft.proposalId,
      },
      TODAY,
    );

    expect(amended).toEqual({ error: RECONSTRUCTION_AMENDMENT_UNAVAILABLE, ok: false });
    store.close();
  });

  test("no enmienda una propuesta que no es una reconstrucción", async () => {
    const store = await seedMortgage();
    const proposal = await store.assistantProposals.create({ kind: "correction" });

    const amended = await buildReconstructionAmendment(
      store,
      { operations: [{ action: "exclude", date: TODAY }], proposalId: proposal.id },
      TODAY,
    );

    expect(amended).toEqual({ error: RECONSTRUCTION_AMENDMENT_UNAVAILABLE, ok: false });
    store.close();
  });
});

describe("confirmCorrectionProposalAction · reconstruct depth (#1053)", () => {
  test("re-projects and applies the reconstructed series as agent re-baselines", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([
        { balanceMinor: 145_000_00, date: "2026-04-12" },
        { balanceMinor: 140_000_00, date: TODAY },
      ]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await confirmCorrectionProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines.length).toBeGreaterThan(0);
    expect(rebaselines.every((row) => row.source === "agent")).toBe(true);
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("applied");
    store.close();
  });

  test("honours an edited series that drops a point but still reconciles", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([
        { balanceMinor: 145_000_00, date: "2026-04-12" },
        { balanceMinor: 140_000_00, date: TODAY },
      ]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    // The user excludes the historical point, keeping only the reconciling anchor.
    const result = await confirmCorrectionProposalAction(
      built.proposal.draft,
      [{ balanceMinor: 140_000_00, date: TODAY }],
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("applied");
    store.close();
  });

  /**
   * #1422: esta prueba decía lo contrario. Rechazaba toda serie cuyo extremo no
   * igualase AL CÉNTIMO el saldo tecleado a mano, y como la tarjeta encendía el
   * botón en cuanto se editaba un punto, el usuario recibía «la serie YA NO
   * reconcilia» —culpándole de romper algo que nunca cuadró— después de pulsar.
   * Hoy el descuadre se dice antes de confirmar y confirmar lo aplica.
   */
  test("aplica una serie que no reconcilia y re-deriva el saldo declarado (#1422)", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await confirmCorrectionProposalAction(
      built.proposal.draft,
      [{ balanceMinor: 130_000_00, date: TODAY }],
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(1);
    // El ancla deja de mentir: pasa a ser lo que dice la curva aceptada.
    const [liability] = await store.liabilities.readLiabilities();
    expect(liability?.currentBalance.amountMinor).toBe(130_000_00);
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("applied");
    store.close();
  });

  test("una serie sin ningún saldo aplicable sigue siendo un error honesto", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await confirmCorrectionProposalAction(
      built.proposal.draft,
      [{ balanceMinor: 130_000_00, date: "2027-01-01" }],
      store,
      clock,
    );

    expect(result.status).toBe("error");
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("draft");
    store.close();
  });

  test("aplica la serie ENMENDADA, no la cruda, cuando la tarjeta no reenvía filas (#1423)", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(store, args(SERIES), TODAY);
    if (!built.ok) throw new Error(built.error);
    const amended = await buildReconstructionAmendment(
      store,
      {
        operations: [{ action: "exclude", from: "2026-06-12" }],
        proposalId: built.proposal.draft.proposalId,
      },
      TODAY,
    );
    if (!amended.ok) throw new Error(amended.error);

    const result = await confirmCorrectionProposalAction(
      amended.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    // Dos puntos, no cuatro: los que la enmienda quitó no vuelven por la puerta
    // de atrás del confirmar.
    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines.map((row) => row.baselineDate)).toEqual([
      "2026-04-12",
      "2026-05-12",
    ]);
    store.close();
  });

  test("discard drops a reconstruct draft with no writes", async () => {
    const store = await seedMortgage();
    const built = await buildReconstructionProposal(
      store,
      args([{ balanceMinor: 140_000_00, date: TODAY }]),
      TODAY,
    );
    if (!built.ok) throw new Error(built.error);

    const result = await discardCorrectionProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "discarded" });
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    store.close();
  });
});
