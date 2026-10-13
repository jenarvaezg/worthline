/**
 * The declaration door, end to end through the `_store` seam (#1673, S2 of #1522):
 * an income declared with no asset, the same door on a holding's ficha, the
 * provenance it refuses to open without, and the correction of an existing
 * declaration. Example data only — the pension below stands for the SHAPE of a
 * real declaration (an official simulation, a start years away, a contribution
 * condition), not for anyone's figures.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { fixedClock } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  createIncomeAction,
  createStandaloneIncomeAction,
  deleteIncomeAction,
  updateIncomeDeclarationAction,
} from "./income-actions";

const RENTAS_URL = "/objetivos/rentas";
const HOLDING = "asset_flat";
// «Today» is pinned: the cut-off date is bounded by it.
const CLOCK = fixedClock("2026-10-11T12:00:00Z");

const createStandalone = (formData: FormData, store: WorthlineStore) =>
  createStandaloneIncomeAction(formData, store, CLOCK);
const createLinked = (holdingId: string, formData: FormData, store: WorthlineStore) =>
  createIncomeAction(holdingId, formData, store, CLOCK);
const updateDeclaration = (formData: FormData, store: WorthlineStore) =>
  updateIncomeDeclarationAction(formData, store, CLOCK);

async function seedWorkspace(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mA", name: "Ana" }],
    mode: "individual",
  });
}

async function seedHolding(store: WorthlineStore): Promise<void> {
  await seedWorkspace(store);
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 200_000_00,
    id: HOLDING,
    liquidityTier: "illiquid",
    name: "Piso alquilado",
    ownership: [{ memberId: "mA", shareBps: 10_000 }],
    type: "real_estate",
  });
}

function form(entries: Record<string, string>, currentUrl = RENTAS_URL): FormData {
  const formData = new FormData();
  formData.set("currentUrl", currentUrl);
  for (const [key, value] of Object.entries(entries)) formData.set(key, value);
  return formData;
}

/** Run an action expected to redirect; return the redirect URL (the digest). */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
  throw new Error("action did not redirect");
}

const PENSION = {
  label: "Pensión pública",
  amount: "1.500,00",
  cadence: "monthly",
  startISO: "2030-11-01",
  nature: "passive",
  amountBasis: "real",
  provenance: "official_simulation",
  provenanceAsOf: "2026-08-18",
  assumedContributionThrough: "2030-10-31",
};

describe("createStandaloneIncomeAction — an income with no asset", () => {
  test("a future public pension is declared whole, with every fact it carries", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    const digest = await redirectOf(() => createStandalone(form(PENSION), store));

    expect(digest).toContain("ok=income_saved");
    const incomes = await store.payouts.readPayoutSchedules();
    expect(incomes).toHaveLength(1);
    expect(incomes[0]).toMatchObject({
      holdingId: null,
      label: "Pensión pública",
      amountMinor: 150_000,
      cadence: "monthly",
      // The future start is the right shape, preserved verbatim (ADR 0054 point 4).
      startISO: "2030-11-01",
      endISO: null,
      nature: "passive",
      amountBasis: "real",
      provenance: "official_simulation",
      provenanceAsOf: "2026-08-18",
      assumedContributionThrough: "2030-10-31",
    });
    // No asset was invented to hold it.
    expect(await store.assets.readAssets()).toHaveLength(0);
  });

  test("an untouched nature is saved as undeclared, not passive", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    await redirectOf(() =>
      createStandalone(form({ ...PENSION, nature: "", amountBasis: "" }), store),
    );

    expect((await store.payouts.readPayoutSchedules())[0]).toMatchObject({
      nature: null,
      amountBasis: null,
    });
  });

  test("without a provenance it is refused inline, with a clear reason, nothing saved", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    const state = await createStandalone(
      form({ ...PENSION, provenance: "", inlineError: "1" }),
      store,
    );

    expect(state).toEqual({
      ok: false,
      error:
        "Indica de dónde sale la cifra: una simulación oficial o una estimación tuya.",
    });
    expect(await store.payouts.readPayoutSchedules()).toHaveLength(0);
  });

  test("without a cut-off date a no-JS post redirects with the reason and its fields", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    const digest = decodeURIComponent(
      await redirectOf(() =>
        createStandalone(form({ ...PENSION, provenanceAsOf: "" }), store),
      ),
    );

    expect(digest).toContain("form=income");
    expect(digest).toMatch(/fecha.de.corte/);
    // The typed declaration survives the round-trip, so nothing has to be re-typed.
    expect(digest).toMatch(/v_label=Pensión.pública/);
    expect(await store.payouts.readPayoutSchedules()).toHaveLength(0);
  });
});

describe("createIncomeAction — the same door on a holding's ficha", () => {
  test("links the asset and confirms in the ficha's own words", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);

    const digest = await redirectOf(() =>
      createLinked(
        HOLDING,
        form(
          {
            label: "Alquiler",
            amount: "900",
            cadence: "monthly",
            startISO: "2024-01-01",
            expenses: "150",
            leaseRegime: "residential_long_term",
            nature: "passive",
            amountBasis: "real",
            provenance: "user_estimate",
            provenanceAsOf: "2026-09-30",
          },
          "/patrimonio/wl_hld_x/editar",
        ),
        store,
      ),
    );

    expect(digest).toContain("ok=payout_schedule_saved");
    expect((await store.payouts.readPayoutSchedulesForHolding(HOLDING))[0]).toMatchObject(
      {
        holdingId: HOLDING,
        amountMinor: 90_000,
        expensesMinor: 15_000,
        leaseRegime: "residential_long_term",
        nature: "passive",
        provenance: "user_estimate",
      },
    );
  });

  test("is refused on the same terms — no provenance, no save — at the Cobros section", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);

    const digest = decodeURIComponent(
      await redirectOf(() =>
        createLinked(
          HOLDING,
          form(
            {
              label: "Alquiler",
              amount: "900",
              cadence: "monthly",
              startISO: "2024-01-01",
            },
            "/patrimonio/wl_hld_x/editar",
          ),
          store,
        ),
      ),
    );

    // Its own form id (#1731 review): the ficha reopens «Añadir cobro» on the
    // recurring pane, not the Cobros tab, with what was typed.
    expect(digest).toContain("form=payoutRecurring");
    expect(digest).toContain("v_label=Alquiler");
    expect(digest).toMatch(/de.dónde.sale.la.cifra/);
    expect(await store.payouts.readPayoutSchedulesForHolding(HOLDING)).toHaveLength(0);
  });
});

describe("updateIncomeDeclarationAction — correcting an existing declaration", () => {
  async function withIncome(): Promise<{ store: WorthlineStore; id: string }> {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    // As a declaration from before the door: nothing but the recurrence.
    const income = await store.payouts.createPayoutSchedule({
      amountMinor: 150_000,
      cadence: "monthly",
      label: "Pensión pública",
      startISO: "2030-11-01",
    });
    return { id: income.id, store };
  }

  test("declares the nature, basis, provenance and condition, keeping the recurrence", async () => {
    const { id, store } = await withIncome();

    const digest = await redirectOf(() =>
      updateDeclaration(
        form({
          incomeId: id,
          nature: "passive",
          amountBasis: "nominal",
          provenance: "official_simulation",
          provenanceAsOf: "2026-08-18",
          assumedContributionThrough: "2030-10-31",
        }),
        store,
      ),
    );

    expect(digest).toContain("ok=income_updated");
    expect((await store.payouts.readPayoutSchedules())[0]).toMatchObject({
      amountMinor: 150_000,
      startISO: "2030-11-01",
      nature: "passive",
      amountBasis: "nominal",
      provenance: "official_simulation",
      provenanceAsOf: "2026-08-18",
      assumedContributionThrough: "2030-10-31",
    });
  });

  test("an emptied choice withdraws the declaration back to undeclared", async () => {
    const { id, store } = await withIncome();
    await store.payouts.updatePayoutSchedule(id, {
      assumedContributionThrough: "2030-10-31",
      nature: "work",
    });

    await redirectOf(() =>
      updateDeclaration(
        form({
          incomeId: id,
          nature: "",
          amountBasis: "",
          provenance: "user_estimate",
          provenanceAsOf: "2026-10-01",
          assumedContributionThrough: "",
        }),
        store,
      ),
    );

    expect((await store.payouts.readPayoutSchedules())[0]).toMatchObject({
      nature: null,
      assumedContributionThrough: null,
    });
  });

  test("a field the form did not carry is left as declared, never wiped to undeclared", async () => {
    const { id, store } = await withIncome();
    await store.payouts.updatePayoutSchedule(id, {
      amountBasis: "real",
      assumedContributionThrough: "2030-10-31",
      nature: "passive",
    });

    // A partial form: only the provenance travels.
    await redirectOf(() =>
      updateDeclaration(
        form({
          incomeId: id,
          provenance: "official_simulation",
          provenanceAsOf: "2026-08-18",
        }),
        store,
      ),
    );

    expect((await store.payouts.readPayoutSchedules())[0]).toMatchObject({
      nature: "passive",
      amountBasis: "real",
      assumedContributionThrough: "2030-10-31",
      provenance: "official_simulation",
      provenanceAsOf: "2026-08-18",
    });
  });

  test("a correction without provenance is refused inline, nothing written", async () => {
    const { id, store } = await withIncome();

    const state = await updateDeclaration(
      form({ incomeId: id, nature: "passive", inlineError: "1" }),
      store,
    );

    expect(state).toMatchObject({ ok: false });
    expect((await store.payouts.readPayoutSchedules())[0]?.nature).toBeNull();
  });

  test("an income that no longer exists is refused, not silently created", async () => {
    const { store } = await withIncome();

    const state = await updateDeclaration(
      form({
        incomeId: "gone",
        provenance: "user_estimate",
        provenanceAsOf: "2026-10-01",
        inlineError: "1",
      }),
      store,
    );

    expect(state).toEqual({ ok: false, error: "Renta no encontrada." });
  });
});

// #1813: an income with no asset has no ficha, so its recurrence is corrected here.
// No figure derives its past payouts (ADR 0111 reads only today's state), which is
// why it is corrected in place instead of deleted and declared again.
describe("updateIncomeDeclarationAction — the recurrence of an income with no asset", () => {
  const DECLARED = {
    provenance: "official_simulation",
    provenanceAsOf: "2026-08-18",
  } as const;

  async function withPension(): Promise<{ store: WorthlineStore; id: string }> {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    const income = await store.payouts.createPayoutSchedule({
      amountBasis: "real",
      amountMinor: 150_000,
      assumedContributionThrough: "2030-10-31",
      cadence: "monthly",
      label: "Pensión pública",
      nature: "passive",
      ...DECLARED,
      startISO: "2030-11-01",
    });
    return { id: income.id, store };
  }

  test("a new official simulation changes the amount in place, keeping the declaration", async () => {
    const { id, store } = await withPension();

    const digest = await redirectOf(() =>
      updateDeclaration(
        form({
          incomeId: id,
          saveRecurrence: "1",
          label: "Pensión pública",
          amount: "1.620,40",
          cadence: "monthly",
          startISO: "2030-11-01",
          endISO: "",
          provenance: "official_simulation",
          provenanceAsOf: "2026-10-01",
        }),
        store,
      ),
    );

    expect(digest).toContain("ok=income_updated");
    const incomes = await store.payouts.readPayoutSchedules();
    expect(incomes).toHaveLength(1);
    expect(incomes[0]).toMatchObject({
      id,
      holdingId: null,
      amountMinor: 162_040,
      startISO: "2030-11-01",
      endISO: null,
      provenanceAsOf: "2026-10-01",
      // What the form did not carry is left as declared.
      nature: "passive",
      amountBasis: "real",
      assumedContributionThrough: "2030-10-31",
    });
  });

  test("a life annuity that ended is ended on its last payment, not deleted", async () => {
    const { id, store } = await withPension();
    await store.payouts.updatePayoutSchedule(id, { startISO: "2019-03-01" });

    await redirectOf(() =>
      updateDeclaration(
        form({
          incomeId: id,
          saveRecurrence: "1",
          label: "Renta vitalicia",
          amount: "1.500,00",
          cadence: "quarterly",
          startISO: "2019-03-01",
          endISO: "2026-09-01",
          ...DECLARED,
        }),
        store,
      ),
    );

    expect((await store.payouts.readPayoutSchedules())[0]).toMatchObject({
      label: "Renta vitalicia",
      cadence: "quarterly",
      startISO: "2019-03-01",
      endISO: "2026-09-01",
      provenance: "official_simulation",
      provenanceAsOf: "2026-08-18",
    });
  });

  test("an emptied end reactivates it", async () => {
    const { id, store } = await withPension();
    await store.payouts.updatePayoutSchedule(id, { endISO: "2040-01-01" });

    await redirectOf(() =>
      updateDeclaration(
        form({
          incomeId: id,
          saveRecurrence: "1",
          label: "Pensión pública",
          amount: "1.500,00",
          cadence: "monthly",
          startISO: "2030-11-01",
          endISO: "",
          ...DECLARED,
        }),
        store,
      ),
    );

    expect((await store.payouts.readPayoutSchedules())[0]?.endISO).toBeNull();
  });

  test("an invalid recurrence is refused on the door's own terms, nothing written", async () => {
    const { id, store } = await withPension();

    const state = await updateDeclaration(
      form({
        incomeId: id,
        saveRecurrence: "1",
        label: "Pensión pública",
        amount: "1.500,00",
        cadence: "monthly",
        startISO: "2030-11-01",
        endISO: "2030-01-01",
        ...DECLARED,
        inlineError: "1",
      }),
      store,
    );

    expect(state).toEqual({
      ok: false,
      error: "La fecha de fin no puede ser anterior al inicio.",
    });
    expect((await store.payouts.readPayoutSchedules())[0]?.endISO).toBeNull();
  });

  test("the recurrence of an income an asset generates is refused: it is changed on its ficha", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);
    const rent = await store.payouts.createPayoutSchedule({
      amountMinor: 90_000,
      cadence: "monthly",
      holdingId: HOLDING,
      label: "Alquiler",
      startISO: "2025-01-01",
    });

    const state = await updateDeclaration(
      form({
        incomeId: rent.id,
        saveRecurrence: "1",
        label: "Alquiler",
        amount: "950,00",
        cadence: "monthly",
        startISO: "2025-01-01",
        endISO: "",
        ...DECLARED,
        inlineError: "1",
      }),
      store,
    );

    expect(state).toEqual({
      ok: false,
      error: expect.stringContaining("se cambian en la ficha de ese activo"),
    });
    expect((await store.payouts.readPayoutSchedules())[0]).toMatchObject({
      amountMinor: 90_000,
      provenance: null,
    });
  });

  test("the declaration of an income an asset generates is still corrected from Rentas", async () => {
    const store = await createInMemoryStore();
    await seedHolding(store);
    const rent = await store.payouts.createPayoutSchedule({
      amountMinor: 90_000,
      cadence: "monthly",
      holdingId: HOLDING,
      label: "Alquiler",
      startISO: "2025-01-01",
    });

    await redirectOf(() =>
      updateDeclaration(
        form({ incomeId: rent.id, nature: "passive", ...DECLARED }),
        store,
      ),
    );

    expect((await store.payouts.readPayoutSchedules())[0]).toMatchObject({
      amountMinor: 90_000,
      holdingId: HOLDING,
      nature: "passive",
      provenance: "official_simulation",
    });
  });
});

describe("deleteIncomeAction", () => {
  test("deletes the income from the list", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);
    const income = await store.payouts.createPayoutSchedule({
      amountMinor: 200_000,
      cadence: "monthly",
      label: "Nómina",
      startISO: "2025-01-01",
    });

    const digest = await redirectOf(() =>
      deleteIncomeAction(form({ incomeId: income.id }), store),
    );

    expect(digest).toContain("ok=income_deleted");
    expect(await store.payouts.readPayoutSchedules()).toHaveLength(0);
  });

  test("an id the workspace no longer holds is «no encontrada», never «eliminada»", async () => {
    const store = await createInMemoryStore();
    await seedWorkspace(store);

    const digest = decodeURIComponent(
      await redirectOf(() => deleteIncomeAction(form({ incomeId: "gone" }), store)),
    );

    expect(digest).toMatch(/error=Renta.no.encontrada/);
    expect(digest).not.toContain("ok=income_deleted");
  });
});
