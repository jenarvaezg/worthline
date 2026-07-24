/**
 * Action-level tests for the amortizable-debt editing server actions (PRD #109
 * slice 10, PRD #146; barrel-exported from ./actions) exercised through their
 * REAL FormData → redirect interface against an in-memory store: the debt-model
 * selector, the amortization-plan save (create + update), and the CRUD for
 * interest-rate revisions and early repayments.
 *
 * Every action funnels through `formAction`, so a success is a NEXT_REDIRECT
 * carrying a success key (`plan_saved`, `revision_saved`, …) and a failure is a
 * NEXT_REDIRECT carrying `error=`. Each action here is pinned along three axes:
 * the happy path (success key + the store actually changed, ripple included),
 * an error path (validation / amortizable guard / not-found), and demo
 * write-gating (`wl_demo_persona` → DEMO_DISABLED_MESSAGE, store untouched).
 * Mirrors the recalibrate-debt-balance-action / add-interest-rate-revision-action
 * harnesses.
 */

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addEarlyRepaymentAction,
  addInterestRateRevisionAction,
  deleteEarlyRepaymentAction,
  deleteInterestRateRevisionAction,
  saveAmortizationPlanAction,
  setDebtModelAction,
  updateEarlyRepaymentAction,
  updateInterestRateRevisionAction,
} from "./actions";

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
const CLOCK: Clock = fixedClock(TODAY);
const MEMBER_ID = "mJ";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

async function runAction(
  action: (fd: FormData, ...a: unknown[]) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await action(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

/** Decode a redirect digest so an es-ES error/DEMO message can be substring-matched. */
function decoded(digest: string): string {
  return decodeURIComponent(digest.replace(/\+/g, " "));
}

async function createWorkspaceStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/** A liability carrying a given debt model, no amortization plan yet. */
async function seedLiability(
  model: "amortizable" | "revolving" | null,
  type: "mortgage" | "debt" = "mortgage",
): Promise<WorthlineStore> {
  const store = await createWorkspaceStore();
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type,
  });
  if (model) await store.liabilities.setDebtModel("mortgage", model);
  return store;
}

/** An amortizable liability with a past plan (`plan1`) already rippled — the S1/S2 fixture. */
async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await seedLiability("amortizable");
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

// ─── setDebtModelAction ─────────────────────────────────────────────────────

describe("setDebtModelAction", () => {
  test("happy path — persists the chosen model", async () => {
    const store = await seedLiability(null, "debt");

    const url = await runAction(
      setDebtModelAction,
      form({ id: "mortgage", debtModel: "amortizable" }),
      store,
      CLOCK,
    );
    expect(url).toContain("debt_model_saved");
    expect(await store.liabilities.readDebtModel("mortgage")).toBe("amortizable");

    store.close();
  });

  test("error path — an invalid model is rejected and nothing changes", async () => {
    const store = await seedLiability(null, "debt");

    const url = await runAction(
      setDebtModelAction,
      form({ id: "mortgage", debtModel: "bogus" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readDebtModel("mortgage")).toBeNull();

    store.close();
  });

  test("demo write-gating — blocks the mutation, model untouched", async () => {
    const store = await seedLiability(null, "debt");
    mockPersonaCookie = "familia";

    const url = await runAction(
      setDebtModelAction,
      form({ id: "mortgage", debtModel: "amortizable" }),
      store,
      CLOCK,
    );
    expect(decoded(url)).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readDebtModel("mortgage")).toBeNull();

    store.close();
  });
});

// ─── saveAmortizationPlanAction ─────────────────────────────────────────────

describe("saveAmortizationPlanAction", () => {
  const planFields = {
    id: "mortgage",
    initialCapital: "100.000,00",
    annualInterestRate: "3", // percent → "0.03"
    termMonths: "180",
    disbursementDate: "2026-01-15",
    firstPaymentDate: "2026-02-15",
  };

  test("happy path (create) — persists the first plan and ripples the curve", async () => {
    const store = await seedLiability("amortizable");
    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeNull();

    const url = await runAction(
      saveAmortizationPlanAction,
      form(planFields),
      store,
      CLOCK,
    );
    expect(url).toContain("plan_saved");

    const plan = await store.liabilities.readAmortizationPlan("mortgage");
    expect(plan).toMatchObject({
      annualInterestRate: "0.03",
      initialCapitalMinor: 100_000_00,
      termMonths: 180,
    });
    // The ripple landed: the curve reads the initial capital at disbursement.
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2026-01-15")).toBe(
      100_000_00,
    );

    store.close();
  });

  test("happy path (update) — replaces the existing plan in place", async () => {
    const store = await seedAmortizableMortgage(); // plan1: rate 0.03, term 240

    const url = await runAction(
      saveAmortizationPlanAction,
      form({
        ...planFields,
        initialCapital: "150.000,00",
        annualInterestRate: "4",
        termMonths: "120",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("plan_saved");

    const plan = await store.liabilities.readAmortizationPlan("mortgage");
    expect(plan).toMatchObject({
      annualInterestRate: "0.04",
      termMonths: 120,
    });
    // Same plan row, updated in place — not a second plan.
    expect(plan?.id).toBe("plan1");

    store.close();
  });

  test("error path — the amortizable guard rejects a non-amortizable debt", async () => {
    const store = await seedLiability("revolving");

    const url = await runAction(
      saveAmortizationPlanAction,
      form(planFields),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(decoded(url)).toContain("solo aplica a deudas amortizables");
    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeNull();

    store.close();
  });

  test("demo write-gating — blocks the create, no plan persisted", async () => {
    const store = await seedLiability("amortizable");
    mockPersonaCookie = "familia";

    const url = await runAction(
      saveAmortizationPlanAction,
      form(planFields),
      store,
      CLOCK,
    );
    expect(decoded(url)).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeNull();

    store.close();
  });
});

// ─── interest-rate revisions: update + delete ───────────────────────────────

/** Seed a mortgage + one revision, returning its store-assigned id. */
async function seedRevision(store: WorthlineStore): Promise<string> {
  await runAction(
    addInterestRateRevisionAction,
    form({
      id: "mortgage",
      planId: "plan1",
      revisionDate: "2026-03-15",
      newAnnualInterestRate: "4",
    }),
    store,
    CLOCK,
  );
  const [revision] = await store.liabilities.readInterestRateRevisions("plan1");
  return revision!.id;
}

describe("updateInterestRateRevisionAction", () => {
  test("happy path — patches the revision in place", async () => {
    const store = await seedAmortizableMortgage();
    const revisionId = await seedRevision(store);

    const url = await runAction(
      updateInterestRateRevisionAction,
      form({
        id: "mortgage",
        planId: "plan1",
        revisionId,
        revisionDate: "2026-04-15",
        newAnnualInterestRate: "5",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("revision_saved");

    const revisions = await store.liabilities.readInterestRateRevisions("plan1");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      newAnnualInterestRate: "0.05",
      revisionDate: "2026-04-15",
    });

    store.close();
  });

  test("error path — an unknown revision id is a friendly not-found", async () => {
    const store = await seedAmortizableMortgage();
    await seedRevision(store);

    const url = await runAction(
      updateInterestRateRevisionAction,
      form({
        id: "mortgage",
        planId: "plan1",
        revisionId: "nope",
        revisionDate: "2026-04-15",
        newAnnualInterestRate: "5",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    // The original revision is untouched.
    const revisions = await store.liabilities.readInterestRateRevisions("plan1");
    expect(revisions[0]).toMatchObject({ newAnnualInterestRate: "0.04" });

    store.close();
  });

  test("demo write-gating — blocks the update, revision untouched", async () => {
    const store = await seedAmortizableMortgage();
    const revisionId = await seedRevision(store);
    mockPersonaCookie = "familia";

    const url = await runAction(
      updateInterestRateRevisionAction,
      form({
        id: "mortgage",
        planId: "plan1",
        revisionId,
        revisionDate: "2026-04-15",
        newAnnualInterestRate: "5",
      }),
      store,
      CLOCK,
    );
    expect(decoded(url)).toContain(DEMO_DISABLED_MESSAGE);
    const revisions = await store.liabilities.readInterestRateRevisions("plan1");
    expect(revisions[0]).toMatchObject({
      newAnnualInterestRate: "0.04",
      revisionDate: "2026-03-15",
    });

    store.close();
  });
});

describe("deleteInterestRateRevisionAction", () => {
  test("happy path — removes the revision", async () => {
    const store = await seedAmortizableMortgage();
    const revisionId = await seedRevision(store);

    const url = await runAction(
      deleteInterestRateRevisionAction,
      form({ id: "mortgage", planId: "plan1", revisionId }),
      store,
      CLOCK,
    );
    expect(url).toContain("revision_deleted");
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(0);

    store.close();
  });

  test("error path — an unknown revision id is a friendly not-found", async () => {
    const store = await seedAmortizableMortgage();
    await seedRevision(store);

    const url = await runAction(
      deleteInterestRateRevisionAction,
      form({ id: "mortgage", planId: "plan1", revisionId: "nope" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(1);

    store.close();
  });

  test("demo write-gating — blocks the delete, revision survives", async () => {
    const store = await seedAmortizableMortgage();
    const revisionId = await seedRevision(store);
    mockPersonaCookie = "familia";

    const url = await runAction(
      deleteInterestRateRevisionAction,
      form({ id: "mortgage", planId: "plan1", revisionId }),
      store,
      CLOCK,
    );
    expect(decoded(url)).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(1);

    store.close();
  });
});

// ─── early repayments: add + update + delete ────────────────────────────────

/** Seed a mortgage + one early repayment, returning its store-assigned id. */
async function seedRepayment(store: WorthlineStore): Promise<string> {
  await runAction(
    addEarlyRepaymentAction,
    form({
      id: "mortgage",
      planId: "plan1",
      repaymentDate: "2026-03-15",
      amount: "5.000,00",
      mode: "reduce-term",
    }),
    store,
    CLOCK,
  );
  const [repayment] = await store.liabilities.readEarlyRepayments("plan1");
  return repayment!.id;
}

describe("addEarlyRepaymentAction", () => {
  test("happy path — persists the repayment and ripples the curve down", async () => {
    const store = await seedAmortizableMortgage();
    const balanceBefore = await store.liabilities.debtBalanceAtDate(
      "mortgage",
      "2026-06-15",
    );

    const url = await runAction(
      addEarlyRepaymentAction,
      form({
        id: "mortgage",
        planId: "plan1",
        repaymentDate: "2026-03-15",
        amount: "5.000,00",
        mode: "reduce-term",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("repayment_added");

    const repayments = await store.liabilities.readEarlyRepayments("plan1");
    expect(repayments).toHaveLength(1);
    expect(repayments[0]).toMatchObject({
      amountMinor: 5_000_00,
      mode: "reduce-term",
      repaymentDate: "2026-03-15",
    });
    // The repayment ripples the curve: a later balance is strictly lower.
    const balanceAfter = await store.liabilities.debtBalanceAtDate(
      "mortgage",
      "2026-06-15",
    );
    expect(balanceAfter).toBeLessThan(balanceBefore);

    store.close();
  });

  test("error path — a non-positive amount is rejected, nothing persisted", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      addEarlyRepaymentAction,
      form({
        id: "mortgage",
        planId: "plan1",
        repaymentDate: "2026-03-15",
        amount: "0",
        mode: "reduce-term",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(0);

    store.close();
  });

  test("demo write-gating — blocks the add, no repayment persisted", async () => {
    const store = await seedAmortizableMortgage();
    mockPersonaCookie = "familia";

    const url = await runAction(
      addEarlyRepaymentAction,
      form({
        id: "mortgage",
        planId: "plan1",
        repaymentDate: "2026-03-15",
        amount: "5.000,00",
        mode: "reduce-term",
      }),
      store,
      CLOCK,
    );
    expect(decoded(url)).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(0);

    store.close();
  });
});

describe("updateEarlyRepaymentAction", () => {
  test("happy path — patches the repayment in place", async () => {
    const store = await seedAmortizableMortgage();
    const repaymentId = await seedRepayment(store);

    const url = await runAction(
      updateEarlyRepaymentAction,
      form({
        id: "mortgage",
        planId: "plan1",
        repaymentId,
        repaymentDate: "2026-04-15",
        amount: "3.000,00",
        mode: "reduce-payment",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("repayment_saved");

    const repayments = await store.liabilities.readEarlyRepayments("plan1");
    expect(repayments).toHaveLength(1);
    expect(repayments[0]).toMatchObject({
      amountMinor: 3_000_00,
      mode: "reduce-payment",
      repaymentDate: "2026-04-15",
    });

    store.close();
  });

  test("error path — an unknown repayment id is a friendly not-found", async () => {
    const store = await seedAmortizableMortgage();
    await seedRepayment(store);

    const url = await runAction(
      updateEarlyRepaymentAction,
      form({
        id: "mortgage",
        planId: "plan1",
        repaymentId: "nope",
        repaymentDate: "2026-04-15",
        amount: "3.000,00",
        mode: "reduce-payment",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect((await store.liabilities.readEarlyRepayments("plan1"))[0]).toMatchObject({
      amountMinor: 5_000_00,
    });

    store.close();
  });

  test("demo write-gating — blocks the update, repayment untouched", async () => {
    const store = await seedAmortizableMortgage();
    const repaymentId = await seedRepayment(store);
    mockPersonaCookie = "familia";

    const url = await runAction(
      updateEarlyRepaymentAction,
      form({
        id: "mortgage",
        planId: "plan1",
        repaymentId,
        repaymentDate: "2026-04-15",
        amount: "3.000,00",
        mode: "reduce-payment",
      }),
      store,
      CLOCK,
    );
    expect(decoded(url)).toContain(DEMO_DISABLED_MESSAGE);
    expect((await store.liabilities.readEarlyRepayments("plan1"))[0]).toMatchObject({
      amountMinor: 5_000_00,
      mode: "reduce-term",
      repaymentDate: "2026-03-15",
    });

    store.close();
  });
});

describe("deleteEarlyRepaymentAction", () => {
  test("happy path — removes the repayment", async () => {
    const store = await seedAmortizableMortgage();
    const repaymentId = await seedRepayment(store);

    const url = await runAction(
      deleteEarlyRepaymentAction,
      form({ id: "mortgage", planId: "plan1", repaymentId }),
      store,
      CLOCK,
    );
    expect(url).toContain("repayment_deleted");
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(0);

    store.close();
  });

  test("error path — an unknown repayment id is a friendly not-found", async () => {
    const store = await seedAmortizableMortgage();
    await seedRepayment(store);

    const url = await runAction(
      deleteEarlyRepaymentAction,
      form({ id: "mortgage", planId: "plan1", repaymentId: "nope" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(1);

    store.close();
  });

  test("demo write-gating — blocks the delete, repayment survives", async () => {
    const store = await seedAmortizableMortgage();
    const repaymentId = await seedRepayment(store);
    mockPersonaCookie = "familia";

    const url = await runAction(
      deleteEarlyRepaymentAction,
      form({ id: "mortgage", planId: "plan1", repaymentId }),
      store,
      CLOCK,
    );
    expect(decoded(url)).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(1);

    store.close();
  });
});
