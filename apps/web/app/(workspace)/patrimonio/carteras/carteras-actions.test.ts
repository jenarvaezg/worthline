/**
 * Registering a cartera without enumerating its composition (#1551), through the
 * Server Actions that own the gesture.
 *
 * `managed-portfolio-store.test.ts` pins the persistence (the aggregate's shape,
 * who is protected from the Papelera); `carteras-view.test.ts` pins the
 * suggestion's arithmetic. This pins the acceptance case of the issue end to end:
 * a "solo saldo" alta of 1.000 € raises the gross by 1.000 €, and detailing a
 * 400 € fund and leaving the aggregate at 600 € keeps it exactly there.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import {
  createManagedPortfolioAction,
  setUndetailedRemainderAction,
  updateManagedPortfolioAction,
} from "./carteras-actions";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const TODAY = "2026-08-24";
const CLOCK: Clock = fixedClock(TODAY);
const MEMBER_ID = "m1";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  fd.set("currentUrl", "/patrimonio/carteras");
  return fd;
}

async function run(
  action: (fd: FormData, ...rest: unknown[]) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
): Promise<string> {
  try {
    await action(fd, store, CLOCK);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return decodeURIComponent(e.digest.replace(/\+/g, " "));
    }
    throw err;
  }
}

async function freshStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jorge" }],
    mode: "individual",
  });
  return store;
}

/** Every live holding's value summed — the gross the board would print. */
async function grossMinor(store: WorthlineStore): Promise<number> {
  const assets = await store.assets.readAssets();
  return assets.reduce((sum, asset) => sum + asset.currentValue.amountMinor, 0);
}

async function onlyPortfolio(store: WorthlineStore) {
  const [portfolio] = await store.managedPortfolios.readManagedPortfolios("household");
  return portfolio!;
}

/** A live 400 € fund: one participación bought at 400 €, priced by its ledger. */
async function seedDetailedFund(store: WorthlineStore): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "a_fondo",
    instrument: "fund",
    name: "Vanguard Global Stock",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  await store.operations.recordOperation({
    assetId: "a_fondo",
    currency: "EUR",
    executedAt: "2026-02-01",
    id: "op_buy",
    kind: "buy",
    pricePerUnit: "400",
    units: "1",
  });
}

async function createSoloSaldo(store: WorthlineStore, declaredValue = "1.000,00") {
  return run(
    createManagedPortfolioAction,
    form({
      declaredValue,
      name: "Cartera Indexada Metal",
      provider: "MyInvestor",
      scopeId: "household",
    }),
    store,
  );
}

describe("createManagedPortfolioAction — alta «solo saldo» (#1551)", () => {
  test("a 1.000 € balance raises the gross by 1.000 € and declares the witness", async () => {
    const store = await freshStore();

    const url = await createSoloSaldo(store);

    expect(url).toContain("cartera_creada_sin_detallar");
    expect(await grossMinor(store)).toBe(1_000_00);

    const portfolio = await onlyPortfolio(store);
    // The same figure is the witness: it IS the balance read in the manager's app.
    expect(portfolio.witness).toEqual({
      declaredDate: TODAY,
      declaredValue: { amountMinor: 1_000_00, currency: "EUR" },
    });
    // Cash box at 0 € plus the aggregate — the composition can wait.
    expect(portfolio.holdingIds).toHaveLength(2);

    store.close();
  });

  test("an alta that enumerates its funds declares nothing and adds nothing", async () => {
    const store = await freshStore();
    await seedDetailedFund(store);

    const url = await run(
      createManagedPortfolioAction,
      form({ holdingIds: "a_fondo", name: "Cartera Metal", scopeId: "household" }),
      store,
    );

    expect(url).toContain("cartera_creada");
    expect(url).not.toContain("sin_detallar");
    // Only the fund that already summed: registering never moves the gross.
    expect(await grossMinor(store)).toBe(400_00);
    expect((await onlyPortfolio(store)).witness).toBeNull();

    store.close();
  });

  test("a balance typed as nonsense bounces instead of registering a hollow cartera", async () => {
    const store = await freshStore();

    const url = await createSoloSaldo(store, "mil euros");

    expect(url).toContain("error=");
    expect(url).toContain("importe positivo");
    expect(await store.managedPortfolios.readManagedPortfolios("household")).toEqual([]);

    // Retrying registers exactly ONE cartera, with the witness on it (#1600):
    // the alta no longer needs a swallowed second write to stay idempotent.
    await createSoloSaldo(store);
    const rows = await store.managedPortfolios.readManagedPortfolios("household");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.witness?.declaredValue.amountMinor).toBe(1_000_00);

    store.close();
  });
});

describe("setUndetailedRemainderAction — sustitución progresiva (#1551)", () => {
  test("detailing 400 € and leaving the aggregate at 600 € keeps the gross at 1.000 €", async () => {
    const store = await freshStore();
    await seedDetailedFund(store);
    await createSoloSaldo(store);
    const portfolio = await onlyPortfolio(store);

    // Detailing the fund does NOT drop the aggregate: for that instant the
    // cartera counts 1.400 €, which is why the ficha suggests reducing it.
    await run(
      updateManagedPortfolioAction,
      form({
        holdingIds: "a_fondo",
        name: portfolio.name,
        portfolioId: portfolio.id,
        provider: "MyInvestor",
      }),
      store,
    );
    expect(await grossMinor(store)).toBe(1_400_00);

    const url = await run(
      setUndetailedRemainderAction,
      form({ portfolioId: portfolio.id, remainderValue: "600,00" }),
      store,
    );

    expect(url).toContain("agregado_ajustado");
    expect(await grossMinor(store)).toBe(1_000_00);
    // Saving members while the aggregate still stands says so out loud (#1551).
    // The aggregate is still a member — the cartera is only half detailed.
    expect((await onlyPortfolio(store)).holdingIds).toHaveLength(3);

    store.close();
  });

  test("retiring it archives it with nothing inside — no ceremony, no money lost", async () => {
    const store = await freshStore();
    await createSoloSaldo(store);
    const portfolio = await onlyPortfolio(store);

    const url = await run(
      setUndetailedRemainderAction,
      form({ portfolioId: portfolio.id, withdraw: "1" }),
      store,
    );

    expect(url).toContain("agregado_retirado");
    // Nothing of the cartera is left summing: the cash box stays live at 0 €.
    expect(await grossMinor(store)).toBe(0);
    const trashed = (await store.readTrash()).assets;
    expect(trashed.map((asset) => asset.name)).toEqual([
      "Cartera Indexada Metal (sin detallar)",
    ]);
    // Archived with its figure intact: restoring brings back what it stood for,
    // not a 0 € stub.
    await store.assets.restoreAsset(trashed[0]!.id);
    expect(await grossMinor(store)).toBe(1_000_00);

    store.close();
  });

  test("typing 0 is the same gesture as retiring it", async () => {
    const store = await freshStore();
    await createSoloSaldo(store);
    const portfolio = await onlyPortfolio(store);

    const url = await run(
      setUndetailedRemainderAction,
      form({ portfolioId: portfolio.id, remainderValue: "0" }),
      store,
    );

    expect(url).toContain("agregado_retirado");
    expect((await store.readTrash()).assets).toHaveLength(1);

    store.close();
  });

  test("a cartera with no aggregate says so instead of touching a member", async () => {
    const store = await freshStore();
    await seedDetailedFund(store);
    await run(
      createManagedPortfolioAction,
      form({ holdingIds: "a_fondo", name: "Cartera Metal", scopeId: "household" }),
      store,
    );
    const portfolio = await onlyPortfolio(store);

    const url = await run(
      setUndetailedRemainderAction,
      form({ portfolioId: portfolio.id, remainderValue: "600,00" }),
      store,
    );

    expect(url).toContain("error=");
    expect(url).toContain("sin detallar");
    expect(await grossMinor(store)).toBe(400_00);

    store.close();
  });
});
