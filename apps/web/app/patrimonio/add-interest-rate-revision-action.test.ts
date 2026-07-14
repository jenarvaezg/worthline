/**
 * Action-level test for addInterestRateRevisionAction — specifically the #692
 * duplicate-date guard: revisions carry a unique index per (plan, date), so
 * re-submitting the same revision date must surface a friendly error redirect,
 * never let the raw SQL throw bubble as a 500. Mirrors the recalibrate action
 * harness (recalibrate-debt-balance-action.test.ts).
 */

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import { addEarlyRepaymentAction, addInterestRateRevisionAction } from "./actions";

let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

const TODAY = "2026-07-02";
const CLOCK = fixedClock(TODAY);

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

type DebtAction = (fd: FormData, store: WorthlineStore, clock: Clock) => Promise<never>;

async function runAction(
  action: DebtAction,
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await action(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.command.createAmortizationPlan(
    {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
    { today: TODAY },
  );
  return store;
}

describe("addInterestRateRevisionAction — duplicate revision date (#692)", () => {
  test("re-submitting the SAME revision date returns a friendly error, not a 500", async () => {
    const store = await seedAmortizableMortgage();
    const sameDate = {
      id: "mortgage",
      planId: "plan1",
      revisionDate: "2026-03-15",
      newAnnualInterestRate: "0,04",
    };

    const first = await runAction(
      addInterestRateRevisionAction,
      form(sameDate),
      store,
      CLOCK,
    );
    expect(first).toContain("revision_added");

    const second = await runAction(
      addInterestRateRevisionAction,
      form({ ...sameDate, newAnnualInterestRate: "0,05" }),
      store,
      CLOCK,
    );
    expect(second).toContain("error=");

    const revisions = await store.liabilities.readInterestRateRevisions("plan1");
    expect(revisions).toHaveLength(1);

    store.close();
  });

  test("re-submitting the SAME early-repayment date returns a friendly error, not a 500", async () => {
    const store = await seedAmortizableMortgage();
    const sameDate = {
      id: "mortgage",
      planId: "plan1",
      repaymentDate: "2026-03-15",
      amount: "5.000,00",
      mode: "reduce-term",
    };

    const first = await runAction(addEarlyRepaymentAction, form(sameDate), store, CLOCK);
    expect(first).toContain("repayment_added");

    const second = await runAction(
      addEarlyRepaymentAction,
      form({ ...sameDate, amount: "3.000,00" }),
      store,
      CLOCK,
    );
    expect(second).toContain("error=");

    const repayments = await store.liabilities.readEarlyRepayments("plan1");
    expect(repayments).toHaveLength(1);

    store.close();
  });
});
