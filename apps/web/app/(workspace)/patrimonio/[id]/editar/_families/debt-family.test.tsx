/**
 * The debt ficha's header against the board (#1848).
 *
 * «El valor de la cabecera es la cifra de la fila del tablero, del mismo cálculo»:
 * a witness, not a claim. Each case seeds a real store, asks the board's own read
 * (`readCurveValuedHoldingsAtDate`) for the debt's balance, and asks the ficha's
 * loader for its header — one per model the ticket names. And the cuota printed
 * beside it follows a rate revision, as the balance does.
 */

import type { PersistenceTestStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import type { Liability } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { loadDebtSurface } from "./debt-family";
import type { FichaLayout } from "./family-contract";

const TODAY = "2026-08-10";
const MEMBER = "m1";

async function freshStore(): Promise<PersistenceTestStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER, name: "Jose" }],
    mode: "individual",
  });
  return store;
}

async function seedDebt(store: PersistenceTestStore, id: string): Promise<void> {
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id,
    name: id,
    ownership: [{ memberId: MEMBER, shareBps: 10_000 }],
    type: "mortgage",
  });
}

async function seedPlan(store: PersistenceTestStore, id: string): Promise<void> {
  await store.liabilities.setDebtModel(id, "amortizable");
  await store.liabilities.createAmortizationPlan({
    annualInterestRate: "0.03",
    disbursementDate: "2020-01-15",
    firstPaymentDate: "2020-02-15",
    id: `plan_${id}`,
    initialCapitalMinor: 200_000_00,
    liabilityId: id,
    termMonths: 240,
  });
}

/** The ficha's header for one debt, through its loader, on the same store. */
async function ficha(store: PersistenceTestStore, id: string): Promise<FichaLayout> {
  const liability = (await store.liabilities.readLiabilities()).find(
    (row) => row.id === id,
  ) as Liability;
  const surface = await loadDebtSurface({
    allAssets: [],
    archiveOriginAfterTransfer: false,
    baseCurrency: "EUR",
    checkedAt: `${TODAY}T00:00:00.000Z`,
    currentUrl: `/patrimonio/wl_hld_${id}/editar`,
    formError: null,
    id,
    isDemo: false,
    liability,
    overrides: [],
    privacyMode: false,
    // The in-memory store is the surface the page's store exposes.
    store: store as never,
    today: TODAY,
  });
  return surface.ficha;
}

/** The board row's figure for the debt, in the row's notation for a pasivo. */
async function boardRow(store: PersistenceTestStore, id: string): Promise<string> {
  const { liabilities } = await store.snapshots.readCurveValuedHoldingsAtDate(TODAY);
  const row = liabilities.find((liability) => liability.id === id);
  if (!row) throw new Error(`no board row for ${id}`);
  return `− ${formatMoneyMinorPrivacy(row.currentBalance, false)}`;
}

const figure = (layout: FichaLayout, key: string) => {
  const found = layout.figures.find((f) => f.key === key);
  return found
    ? renderToStaticMarkup(
        <>
          {found.value}
          {found.detail}
        </>,
      )
    : "";
};

describe("the debt ficha's header is the board row's figure (#1848)", () => {
  test("amortizable, with a plan and a rate revision", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_plan");
    await seedPlan(store, "l_plan");
    await store.liabilities.addInterestRateRevision({
      id: "rev_1",
      newAnnualInterestRate: "0.04",
      planId: "plan_l_plan",
      revisionDate: "2023-01-15",
    });

    const layout = await ficha(store, "l_plan");
    expect(layout.value).toBe(await boardRow(store, "l_plan"));
    // The curve's, not the stored column's.
    expect(layout.value).not.toContain("150.000");
  });

  test("amortizable, with a plan and a re-baseline that governs from its date (ADR 0056)", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_recal");
    await seedPlan(store, "l_recal");
    await store.liabilities.addBalanceRebaseline({
      annualInterestRate: "0.03",
      baselineDate: "2025-06-15",
      endDate: "2040-01-15",
      id: "reb_recal",
      liabilityId: "l_recal",
      nextPaymentDate: "2025-07-15",
      outstandingBalanceMinor: 120_000_00,
      startsAtBaseline: false,
    });

    const layout = await ficha(store, "l_recal");
    expect(layout.value).toBe(await boardRow(store, "l_recal"));
    expect(layout.value).not.toContain("150.000");
  });

  test("amortizable, with a re-baseline and no plan row", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_rebased");
    await store.liabilities.setDebtModel("l_rebased", "amortizable");
    await store.liabilities.addBalanceRebaseline({
      annualInterestRate: "0.0325",
      baselineDate: "2026-01-01",
      endDate: "2040-01-01",
      id: "reb_1",
      liabilityId: "l_rebased",
      nextPaymentDate: "2026-02-01",
      outstandingBalanceMinor: 90_000_00,
      startsAtBaseline: true,
    });

    const layout = await ficha(store, "l_rebased");
    expect(layout.value).toBe(await boardRow(store, "l_rebased"));
    expect(layout.value).not.toContain("150.000");
  });

  test("revolving, with declared balances", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_card");
    await store.liabilities.setDebtModel("l_card", "revolving");
    await store.liabilities.setValuationCadence("l_card", "interpolated");
    for (const [anchorDate, balanceMinor] of [
      ["2026-06-01", 2_000_00],
      ["2026-07-01", 1_200_00],
    ] as const) {
      await store.liabilities.addBalanceAnchor({
        anchorDate,
        balanceMinor,
        id: `anchor_${anchorDate}`,
        liabilityId: "l_card",
      });
    }

    const layout = await ficha(store, "l_card");
    expect(layout.value).toBe(await boardRow(store, "l_card"));
    expect(layout.value).toMatch(/^− 1\.?200\s€$/);
    // The last one declared, with its date.
    expect(figure(layout, "anchor")).toMatch(/1\.?200\s€/);
    expect(figure(layout, "anchor")).toContain("del 01/07/2026");
  });

  test("informal, with a declared balance", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_family");
    await store.liabilities.setDebtModel("l_family", "informal");
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2026-05-01",
      balanceMinor: 4_000_00,
      id: "anchor_family",
      liabilityId: "l_family",
    });

    const layout = await ficha(store, "l_family");
    expect(layout.value).toBe(await boardRow(store, "l_family"));
    expect(layout.value).toMatch(/^− 4\.?000\s€$/);
  });

  test("no model: the stored balance, and the gap said with its door", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_bare");

    const layout = await ficha(store, "l_bare");
    expect(layout.value).toBe(await boardRow(store, "l_bare"));
    expect(layout.value).toMatch(/^− 150\.?000\s€$/);
    expect(figure(layout, "model")).toContain("Sin modelo");
    expect(figure(layout, "model")).toContain("Elegir modelo");
    expect(figure(layout, "model")).toContain(
      'href="/patrimonio/wl_hld_l_bare/editar?accion=modelo"',
    );
  });
});

describe("«Cuota vigente» follows the rate revisions (#1848, #1520)", () => {
  test("after a revision it is the revised cuota, not the original plan's", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_plan");
    await seedPlan(store, "l_plan");
    // From the very disbursement: 200.000 € over 240 months at 4 % is the textbook
    // French cuota of 1.211,96 €, where the plan's own 3 % would be 1.109,20 €.
    await store.liabilities.addInterestRateRevision({
      id: "rev_1",
      newAnnualInterestRate: "0.04",
      planId: "plan_l_plan",
      revisionDate: "2020-01-15",
    });

    const cuota = figure(await ficha(store, "l_plan"), "cuota");
    // (es-ES leaves a four-digit figure ungrouped on some ICU builds.)
    expect(cuota).toMatch(/1\.?211,96/);
    expect(cuota).not.toMatch(/1\.?109,20/);
    // Next due on the cuota day after today.
    expect(cuota).toContain("próxima el 15/08/2026");
  });

  test("with no plan at all it says so, with the door to the Plan tab", async () => {
    const store = await freshStore();
    await seedDebt(store, "l_amort");
    await store.liabilities.setDebtModel("l_amort", "amortizable");

    const cuota = figure(await ficha(store, "l_amort"), "cuota");
    expect(cuota).toContain("Sin plan");
    expect(cuota).toContain("Configurar el plan");
  });
});
