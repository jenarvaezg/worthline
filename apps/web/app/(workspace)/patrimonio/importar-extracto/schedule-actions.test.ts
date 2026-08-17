/**
 * Integration tests for the cuadro-de-amortización lane of «Importar extracto»
 * (#1406), through the `_store` injection seam.
 *
 * The fixture is the shape of the real Santander workbook: a wide matrix of
 * anniversaries (rows `Capital` / `Interés` / `Plazo` / `Amortiz Anticipada`)
 * above the long table of cuotas.
 */
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { describe, expect, test } from "vitest";

import {
  confirmImportScheduleAction,
  type ImportScheduleState,
  previewImportScheduleAction,
} from "./schedule-actions";

const IDLE: ImportScheduleState = { status: "idle" };

const CUADRO = [
  ";01/05/2005;01/05/2006",
  "Capital;160855,24;155438,99",
  "Interés;0,02815;0,03771",
  "Plazo;360",
  "Tabla de Amortización Ejecutada Préstamo Nº 0049",
  "Fecha;Cuota Nº;Cuota;Capital;Interés;Extra;Saldo",
  "01/05/2005;10;665,80;296,46;369,34;;160855,24",
  "01/05/2006;22;665,80;300,00;365,80;;155438,99",
].join("\r\n");

function uploadForm(csv = CUADRO, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("currentUrl", "/patrimonio/importar-extracto?documento=cuadro");
  fd.set("liabilityId", "mortgage");
  fd.set("earlyRepaymentMode", "reduce-payment");
  for (const [key, value] of Object.entries(overrides)) fd.set(key, value);
  fd.set("file", new File([csv], "cuadro.csv", { type: "text/csv" }));
  return fd;
}

async function seed(
  store: WorthlineStore,
  options: { plan?: boolean } = {},
): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 5_335_017,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca Plasencia",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  if (options.plan === false) return;
  await store.liabilities.createAmortizationPlan({
    annualInterestRate: "0.027",
    disbursementDate: "2004-05-19",
    firstPaymentDate: "2004-07-01",
    id: "plan1",
    initialCapitalMinor: 17_315_318,
    liabilityId: "mortgage",
    termMonths: 360,
  });
}

function preview(fd: FormData, store: WorthlineStore): Promise<ImportScheduleState> {
  return previewImportScheduleAction(IDLE, fd, store);
}

async function confirm(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await confirmImportScheduleAction(fd, store);
    throw new Error("action did not redirect");
  } catch (error: unknown) {
    const redirect = error as { message?: string; digest?: string };
    if (redirect.message === "NEXT_REDIRECT" && typeof redirect.digest === "string") {
      return redirect.digest;
    }
    throw error;
  }
}

describe("cuadro import — preview", () => {
  test("reads the revisions the matrix declares and checks them against its saldos", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const state = await preview(uploadForm(), store);

    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    const plan = state.preview.value;
    expect(plan.revisions.map((revision) => revision.revisionDate)).toEqual([
      "2005-05-01",
      "2006-05-01",
    ]);
    expect(plan.summary.newRevisionCount).toBe(2);
    expect(plan.summary.checkedCount).toBe(2);
    // Nothing was written by looking.
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(0);

    store.close();
  });

  test("a debt with no plan is refused, and says which door creates one", async () => {
    const store = await createInMemoryStore();
    await seed(store, { plan: false });

    const state = await preview(uploadForm(), store);

    expect(state.status).toBe("error");
    if (state.status !== "error") return;
    expect(state.message).toContain("/editar");

    store.close();
  });

  test("a file that is not a schedule is refused before anything is read", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const state = await preview(
      uploadForm(["Concepto;Importe", "Luz;62,10"].join("\r\n")),
      store,
    );

    expect(state.status).toBe("error");
    if (state.status !== "error") return;
    expect(state.message).toContain("cuadro de amortización");

    store.close();
  });

  test("without a debt named, nothing is read", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const fd = uploadForm();
    fd.set("liabilityId", "");
    const state = await preview(fd, store);

    expect(state.status).toBe("error");

    store.close();
  });
});

describe("cuadro import — confirm", () => {
  test("writes every new event over the existing plan and never touches the plan", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const digest = await confirm(uploadForm(), store);

    expect(digest).toContain("ok=schedule_import_loaded");
    expect(digest).toContain("revisiones=2");
    const revisions = await store.liabilities.readInterestRateRevisions("plan1");
    expect(revisions.map((revision) => revision.newAnnualInterestRate)).toEqual([
      "0.02815",
      "0.03771",
    ]);
    const plan = await store.liabilities.readAmortizationPlan("mortgage");
    expect(plan?.annualInterestRate).toBe("0.027");
    expect(plan?.termMonths).toBe(360);

    store.close();
  });

  test("re-uploading the same cuadro adds nothing and says so", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await confirm(uploadForm(), store);

    const digest = await confirm(uploadForm(), store);

    expect(digest).toContain("error=");
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(2);

    store.close();
  });

  test("an «Extra» column becomes a dated early repayment in the chosen mode", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const withLump = [
      ";01/05/2005;01/05/2006",
      "Interés;0,02815;0,03771",
      "Fecha;Cuota;Capital;Interés;Extra;Saldo",
      "01/06/2005;665,80;296,46;369,34;3500;157000,00",
    ].join("\r\n");

    await confirm(uploadForm(withLump, { earlyRepaymentMode: "reduce-term" }), store);

    expect(await store.liabilities.readEarlyRepayments("plan1")).toMatchObject([
      { amountMinor: 350_000, mode: "reduce-term", repaymentDate: "2005-06-01" },
    ]);

    store.close();
  });

  test("history is re-derived, so the debt's snapshots match the live curve", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await confirm(uploadForm(), store);

    const snapshots = await store.snapshots.readSnapshots();
    const sample = snapshots.find((snapshot) => snapshot.dateKey === "2006-05-01");
    expect(sample?.debts.amountMinor).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", "2006-05-01"),
    );

    store.close();
  });
});
