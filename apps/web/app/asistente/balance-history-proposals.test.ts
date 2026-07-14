import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { balanceCurvePolyline } from "./balance-curve-polyline";
import { parseBalanceHistoryProposalDraft } from "./balance-history-proposal-contract";
import {
  buildBalanceHistoryProposal,
  observationsFromProposal,
  projectBalanceHistoryProposal,
} from "./balance-history-proposals";

async function seed() {
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
  await store.liabilities.setDebtModel("mortgage", "amortizable");
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
    { today: "2026-07-12" },
  );
  return store;
}

describe("balance-history assistant proposal (#768)", () => {
  test("maps an engine curve to stable SVG coordinates", () => {
    expect(
      balanceCurvePolyline([
        { balanceMinor: 200 },
        { balanceMinor: 150 },
        { balanceMinor: 100 },
      ]),
    ).toBe("0.00,8.00 50.00,50.00 100.00,92.00");
  });
  test("persists observed balances and previews an exact current-balance checksum", async () => {
    const store = await seed();
    const built = await buildBalanceHistoryProposal(
      store,
      {
        documentName: "cuadro.pdf",
        liabilityId: "mortgage",
        rows: [
          { balanceMinor: 140_000_00, date: "2026-07-12" },
          { balanceMinor: 139_000_00, date: "2026-08-12" },
        ],
      },
      "2026-07-12",
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.reconciliation).toEqual({
      expectedMinor: 140_000_00,
      matches: true,
      resultingMinor: 140_000_00,
    });
    expect(built.proposal.points).toMatchObject([
      { date: "2026-07-12", status: "accepted" },
      { date: "2026-08-12", status: "excluded", reason: expect.any(String) },
    ]);
    expect(built.proposal.curve).toEqual([
      { balanceMinor: 140_000_00, date: "2026-07-12" },
    ]);
    const stored = await store.assistantProposals.read(built.proposal.draft.proposalId);
    expect(stored && observationsFromProposal(stored)).toMatchObject({
      liabilityId: "mortgage",
      rows: [
        { balanceMinor: 140_000_00, date: "2026-07-12" },
        { balanceMinor: 139_000_00, date: "2026-08-12" },
      ],
    });
    store.close();
  });

  test("rejects a missing target instead of fuzzy matching another debt", async () => {
    const store = await seed();
    const built = await buildBalanceHistoryProposal(
      store,
      {
        liabilityId: "hipoteca",
        rows: [{ balanceMinor: 140_000_00, date: "2026-07-12" }],
      },
      "2026-07-12",
    );
    expect(built).toEqual({
      ok: false,
      error: "La deuda no existe o no es amortizable.",
    });
    store.close();
  });

  test("applies agent-sourced rebaselines and resolves the draft together", async () => {
    const store = await seed();
    const rows = [{ balanceMinor: 140_000_00, date: "2026-07-12" }];
    const built = await buildBalanceHistoryProposal(
      store,
      { liabilityId: "mortgage", rows },
      "2026-07-12",
    );
    const projected = await projectBalanceHistoryProposal(
      store,
      "mortgage",
      rows,
      "2026-07-12",
    );
    expect(built.ok && projected.ok).toBe(true);
    if (!built.ok || !projected.ok) return;
    await store.command.applyAssistantBalanceHistoryProposal({
      liabilityId: "mortgage",
      proposalId: built.proposal.draft.proposalId,
      rebaselines: projected.plan.composed.map((row) => ({
        ...row,
        id: `agent_${row.baselineDate}`,
        liabilityId: "mortgage",
        source: "agent",
      })),
      today: "2026-07-12",
    });
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toMatchObject([
      { source: "agent", startsAtBaseline: false },
    ]);
    expect(
      await store.assistantProposals.read(built.proposal.draft.proposalId),
    ).toMatchObject({ status: "applied" });
    store.close();
  });
});
