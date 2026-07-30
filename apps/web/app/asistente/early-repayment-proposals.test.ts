import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  buildEarlyRepaymentProposal,
  earlyRepaymentPlanFromProposal,
  parseEarlyRepaymentInput,
  projectEarlyRepaymentProposal,
} from "./early-repayment-proposals";

const TODAY = "2026-07-26";

/**
 * The PRD's origin case, modelled: a Revolut personal loan whose cuota is close to
 * the 158,49 € the capture shows, and a 91,32 € lump paid on the 20th — five days
 * after the cuota, so the month boundary matters.
 */
async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 4_200_00,
    currency: "EUR",
    id: "loan",
    name: "Préstamo Revolut",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.setDebtModel("loan", "amortizable");
  await store.command.createAmortizationPlan(
    {
      annualInterestRate: "0.089",
      disbursementDate: "2025-08-15",
      firstPaymentDate: "2025-09-15",
      id: "plan",
      initialCapitalMinor: 5_000_00,
      liabilityId: "loan",
      termMonths: 36,
    },
    { today: TODAY },
  );
  return store;
}

async function seedRevolving(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 1_200_00,
    currency: "EUR",
    id: "card",
    name: "Visa",
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.setDebtModel("card", "revolving");
  return store;
}

const VALID = {
  amountMinor: 91_32,
  liabilityId: "loan",
  mode: "reduce-term",
  repaymentDate: "2026-07-20",
} as const;

describe("parseEarlyRepaymentInput money math (#1245)", () => {
  test("rejects a non-integer amount instead of rounding it silently", () => {
    // The attachment contract speaks major units (91,32 €); the conversion to
    // cents crosses here, and 91.32 cents is the exact mistake to catch.
    const parsed = parseEarlyRepaymentInput({ ...VALID, amountMinor: 91.32 }, TODAY);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/céntimos/i);
  });

  test("rejects a zero or negative amount", () => {
    for (const amountMinor of [0, -100]) {
      expect(parseEarlyRepaymentInput({ ...VALID, amountMinor }, TODAY).ok).toBe(false);
    }
  });

  test("rejects a non-integer observed cuota the same way", () => {
    const parsed = parseEarlyRepaymentInput(
      { ...VALID, observedMonthlyPaymentMinor: 158.49 },
      TODAY,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/céntimos/i);
  });

  test("accepts the origin case verbatim", () => {
    const parsed = parseEarlyRepaymentInput(
      { ...VALID, observedMonthlyPaymentMinor: 158_49, summary: "Anticipada Revolut" },
      TODAY,
    );

    expect(parsed).toMatchObject({
      ok: true,
      row: {
        amountMinor: 9132,
        liabilityId: "loan",
        mode: "reduce-term",
        observedMonthlyPaymentMinor: 15849,
        repaymentDate: "2026-07-20",
      },
    });
  });

  test("never infers the mode: an absent or unknown mode is a question, not a guess", () => {
    for (const mode of [undefined, "", "reduce", "shorten"]) {
      const parsed = parseEarlyRepaymentInput({ ...VALID, mode }, TODAY);
      expect(parsed.ok, String(mode)).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toMatch(/reduce-term|reduce-payment/);
    }
  });

  test("rejects a future date: an observed repayment cannot be tomorrow's", () => {
    expect(
      parseEarlyRepaymentInput({ ...VALID, repaymentDate: "2026-08-01" }, TODAY).ok,
    ).toBe(false);
    expect(
      parseEarlyRepaymentInput({ ...VALID, repaymentDate: "2026-13-40" }, TODAY).ok,
    ).toBe(false);
  });
});

describe("buildEarlyRepaymentProposal (#1245)", () => {
  test("proposes the origin case with the impact the domain computes", async () => {
    const store = await seed();

    const built = await buildEarlyRepaymentProposal(
      store,
      {
        ...VALID,
        observedMonthlyPaymentMinor: 158_49,
        publicHoldingId: "wl_hld_loan",
      },
      TODAY,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { proposal } = built;
    expect(proposal.proposalType).toBe("early_repayment");
    expect(proposal.holding).toEqual({ id: "wl_hld_loan", name: "Préstamo Revolut" });
    // The amount keeps its cents: 91,32 €, never «91 €».
    expect(proposal.repayment.amount).toContain("91,32");
    expect(proposal.repayment.mode).toBe("reduce-term");
    expect(proposal.repayment.modeLabel).toMatch(/plazo/i);
    // The month boundary is surfaced, not hidden behind the date the user gave.
    expect(proposal.repayment.boundaryDate).toBe("2026-07-15");
    expect(proposal.notes.join(" ")).toMatch(/15\/07\/2026/);
    // The date the user paid is rendered es-ES, never as a raw ISO string.
    expect(proposal.repayment.dateLabel).toBe("20/07/2026");
    // Balance before/after, resulting cuota and resulting end date, all present.
    // The balance pair is dated on the REPAYMENT date — where the curve steps down
    // (#1291) — never undated next to a Confirmar button (#1266).
    expect(proposal.rows.map((row) => row.label)).toEqual([
      "Saldo pendiente (20/07/2026)",
      "Cuota mensual",
      "Última cuota",
    ]);
    expect(proposal.reconciliation).not.toBeNull();
    expect(proposal.folio).toContain("1 deuda");

    // The fact is persisted as a draft; nothing was written to the debt.
    const stored = await store.assistantProposals.read(proposal.draft.proposalId);
    expect(stored?.status).toBe("draft");
    expect(stored && earlyRepaymentPlanFromProposal(stored)).toMatchObject({
      amountMinor: 9132,
      holding: "wl_hld_loan",
      liabilityId: "loan",
      mode: "reduce-term",
      planId: "plan",
      repaymentDate: "2026-07-20",
    });
    expect(await store.liabilities.readEarlyRepayments("plan")).toEqual([]);
    store.close();
  });

  test("rejects a second proposal on the same plan and date without touching the DB", async () => {
    const store = await seed();
    await store.command.addEarlyRepayment(
      {
        amountMinor: 91_32,
        id: "existing",
        mode: "reduce-term",
        planId: "plan",
        repaymentDate: "2026-07-20",
      },
      { liabilityId: "loan", today: TODAY },
    );

    const built = await buildEarlyRepaymentProposal(
      store,
      { ...VALID, publicHoldingId: "wl_hld_loan" },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/ya está registrada/i);
    // Never summed, never a unique-index crash: the existing row is untouched.
    expect(await store.liabilities.readEarlyRepayments("plan")).toMatchObject([
      { amountMinor: 9132, id: "existing" },
    ]);
    store.close();
  });

  test("routes a revolving debt to the balance anchor instead of writing", async () => {
    const store = await seedRevolving();

    const built = await buildEarlyRepaymentProposal(
      store,
      { ...VALID, liabilityId: "card", publicHoldingId: "wl_hld_card" },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/revolving|informal/i);
    expect(built.error).toMatch(/propose_correction|saldo/i);
    store.close();
  });

  test("refuses an unknown holding rather than guessing a debt", async () => {
    const store = await seed();

    const built = await buildEarlyRepaymentProposal(
      store,
      { ...VALID, liabilityId: "nope", publicHoldingId: "wl_hld_nope" },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/no encuentro|no existe/i);
    store.close();
  });

  test("refuses a lump 100× the live balance instead of previewing a fake payoff (#1266)", async () => {
    // 99.999 € against a 4.200 € loan: the domain clamps the principal at 0, so
    // without a ceiling this proposes «la anticipada cancela el préstamo» and, on
    // confirm, persists an arithmetically impossible fact forever.
    const store = await seed();

    const built = await buildEarlyRepaymentProposal(
      store,
      { ...VALID, amountMinor: 99_999_00, publicHoldingId: "wl_hld_loan" },
      TODAY,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/supera el saldo vivo/i);
    // Nothing was drafted: a rejected amount leaves no proposal to confirm.
    expect(await store.liabilities.readEarlyRepayments("plan")).toEqual([]);
    store.close();
  });

  test("says a total repayment out loud when the lump really does cover the balance", async () => {
    const store = await seed();
    const projected = await projectEarlyRepaymentProposal(
      store,
      {
        amountMinor: 1_00,
        liabilityId: "loan",
        mode: "reduce-term",
        repaymentDate: "2026-07-20",
      },
      TODAY,
    );
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const built = await buildEarlyRepaymentProposal(
      store,
      {
        ...VALID,
        amountMinor: projected.impact.balanceBeforeMinor,
        publicHoldingId: "wl_hld_loan",
      },
      TODAY,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.notes.join(" ")).toMatch(/cancela/i);
    expect(built.proposal.rows[0]?.after).toMatch(/0,00/);
    store.close();
  });
});
