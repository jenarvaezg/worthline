/**
 * Action-level tests for the unified createHoldingAction (issue #151, PRD #146 S5).
 *
 * The action is the public seam of the instrument-first add flow: given a form
 * carrying the chosen `instrument` plus that instrument's suffixed fields, it
 * derives the holding's defaults from the catalog (defaultsFor) and persists a
 * correct holding — a manual asset, an investment, or a liability — reading ONLY
 * the selected instrument's fields (the others POST as hidden inputs and are
 * ignored). These tests assert the resulting store state + the success redirect.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import {
  computeContributionAllowanceUsage,
  defaultInstrumentForLiability,
  fixedClock,
  valuationMethodOfLiability,
} from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

import { createHoldingAction } from "./create-holding-action";

vi.mock("@web/demo/write-guard", () => ({
  guardDemoWrite: vi.fn(async () => undefined),
}));

/** Build a FormData with the given key/value pairs. */
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/**
 * A fixed "today" makes the acquisition-anchor ripple deterministic: it is well
 * after every backdated acquisition date below, with no global Date mocking.
 */
const CLOCK = fixedClock("2026-06-15");

/** Invoke the action (which always throws redirect()) and return the URL. */
async function runAction(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await createHoldingAction(fd, store, CLOCK);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

/** The holding's public `wl_hld_…` id — the only id the product puts in a URL (#1318). */
async function publicIdOf(store: WorthlineStore, internalId: string): Promise<string> {
  const row = (await store.agentView.readPublicIds()).find(
    (entry) => entry.entityType === "holding" && entry.entityId === internalId,
  );
  return row!.publicId;
}

async function seedStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/** A 2-member household with a piso owned 65 % Jose / 35 % Ana (for #171). */
async function seedHousehold(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 200_000_00,
    id: "piso",
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [
      { memberId: "mJ", shareBps: 6_500 },
      { memberId: "mA", shareBps: 3_500 },
    ],
    type: "real_estate",
  });
  return store;
}

async function ownershipByMember(store: WorthlineStore): Promise<Record<string, number>> {
  const liability = (await store.liabilities.readLiabilities())[0]!;
  return Object.fromEntries(liability.ownership.map((o) => [o.memberId, o.shareBps]));
}

describe("createHoldingAction — stored assets", () => {
  test("current_account → manual asset on the cash rung, instrument persisted", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        instrument: "current_account",
        name_current_account: "Cuenta BBVA",
        value_current_account: "2.500,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("/patrimonio");
    expect(url).toContain("ok=");

    const assets = await store.assets.readAssets();
    expect(assets).toHaveLength(1);
    const asset = assets[0]!;
    expect(asset.name).toBe("Cuenta BBVA");
    expect(asset.type).toBe("cash");
    expect(asset.liquidityTier).toBe("cash");
    expect(asset.instrument).toBe("current_account");
    expect(asset.currentValue.amountMinor).toBe(250_000);
  });

  test("vehicle → manual asset on the illiquid rung, instrument persisted", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "vehicle",
        name_vehicle: "Renault Clio",
        value_vehicle: "8.500,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const asset = (await store.assets.readAssets())[0]!;
    expect(asset.type).toBe("manual");
    expect(asset.liquidityTier).toBe("illiquid");
    expect(asset.instrument).toBe("vehicle");
    expect(asset.currentValue.amountMinor).toBe(850_000);
  });

  test("ignores the hidden fields of the non-selected instruments", async () => {
    const store = await seedStore();

    // Both current_account and vehicle fields POST; only current_account is chosen.
    await runAction(
      form({
        instrument: "current_account",
        name_current_account: "Cuenta BBVA",
        value_current_account: "2.500,00",
        name_vehicle: "Coche que no debe crearse",
        value_vehicle: "99.999,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const assets = await store.assets.readAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0]!.name).toBe("Cuenta BBVA");
    expect(assets[0]!.instrument).toBe("current_account");
  });
});

describe("createHoldingAction — appreciating (property)", () => {
  test("property → real_estate on illiquid, with acquisition anchor + instrument", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        instrument: "property",
        name_property: "Piso Malasaña",
        acqDate_property: "2020-01-15",
        acqValue_property: "180.000,00",
        rate_property: "3",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=");

    const asset = (await store.assets.readAssets())[0]!;
    expect(asset.type).toBe("real_estate");
    expect(asset.liquidityTier).toBe("illiquid");
    expect(asset.instrument).toBe("property");
    expect(asset.currentValue.amountMinor).toBe(18_000_000);

    // The acquisition seeds a valuation anchor (the curve's base).
    const anchors = await store.assets.readValuationAnchors(asset.id);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    expect(anchors.some((a) => a.valuationDate === "2020-01-15")).toBe(true);
  });
});

describe("createHoldingAction — success loop on the simple wizard (#600)", () => {
  test("a simple-drawer add loops back to the wizard with ok + the new holding id", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "dinero",
        simpleName_dinero: "Cuenta nómina",
        simpleValue_dinero: "1.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    // Back to the wizard (not the holdings list) so the success screen can loop.
    expect(url).toContain("/patrimonio/anadir");
    expect(url).toContain("ok=asset_added");
    // The new holding's PUBLIC id rides a query param (not the #hash, which is
    // client-only) so the wizard can build its links server-side — and it is the
    // public one because that is the only id a URL may carry (#1318).
    const added = await publicIdOf(store, (await store.assets.readAssets())[0]!.id);
    expect(added).toMatch(/^wl_hld_/);
    expect(url).toContain(`added=${added}`);
  });

  test("the avanzado form still lands on the patrimonio list (no loop)", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        returnTo: "/patrimonio/anadir/avanzado",
        instrument: "current_account",
        name_current_account: "Cuenta",
        value_current_account: "1.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=asset_added");
    expect(url).not.toContain("/anadir");
  });
});

describe("createHoldingAction — simple drawer form (#596)", () => {
  test("cash drawer maps the term toggle to a term deposit and keeps even ownership", async () => {
    const store = await seedHousehold();

    await runAction(
      form({
        simpleDrawer: "dinero",
        simpleName_dinero: "Depósito Openbank",
        simpleValue_dinero: "10.000,00",
        cashTerm_dinero: "on",
        ownershipPreset: "even",
      }),
      store,
    );

    const asset = (await store.assets.readAssets()).find(
      (a) => a.name === "Depósito Openbank",
    )!;
    expect(asset.type).toBe("manual");
    expect(asset.instrument).toBe("term_deposit");
    expect(asset.currentValue.amountMinor).toBe(1_000_000);
    expect(
      Object.fromEntries(asset.ownership.map((o) => [o.memberId, o.shareBps])),
    ).toEqual({
      mA: 5_000,
      mJ: 5_000,
    });
  });

  test("housing drawer creates a real-estate asset from today's value only", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "inmueble",
        simpleName: "",
        simpleValue: "",
        simpleName_inmueble: "Casa",
        simpleValue_inmueble: "300.000,00",
        primaryResidence_inmueble: "on",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const asset = (await store.assets.readAssets())[0]!;
    expect(asset.type).toBe("real_estate");
    expect(asset.instrument).toBe("property");
    expect(asset.currentValue.amountMinor).toBe(30_000_000);
    expect(asset.isPrimaryResidence).toBe(true);

    const anchors = await store.assets.readValuationAnchors(asset.id);
    expect(anchors.some((a) => a.valuationDate === "2026-06-15")).toBe(true);
  });

  test("housing drawer preserves the primary-residence opt-out sentinel", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "inmueble",
        simpleName_inmueble: "Local",
        simpleValue_inmueble: "90.000,00",
        primaryResidence_inmueble: "off",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const asset = (await store.assets.readAssets())[0]!;
    expect(asset.isPrimaryResidence).toBe(false);
  });

  test("a second primary residence is rejected naming the current one", async () => {
    const store = await seedStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "casa",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Casa",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });

    const url = await runAction(
      form({
        simpleDrawer: "inmueble",
        simpleName_inmueble: "Chalet",
        simpleValue_inmueble: "250.000,00",
        primaryResidence_inmueble: "on",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).not.toContain("ok=");
    expect(url).toContain("vivienda+habitual");
    expect(await store.assets.readAssets()).toHaveLength(1);
  });
});

/**
 * The alta's acquisition-date question (#1561). The simple drawer stamps TODAY as
 * the acquisition date without asking, so a piso bought in 2004 enters the book
 * as if bought this morning and the mortgage that financed it drops out of every
 * earlier graph (#1436, Plasencia). When worthline can see that contradiction it
 * asks — and the alta goes through either way.
 */
describe("createHoldingAction — adquisición de hoy con una deuda anterior (#1561)", () => {
  /** A mortgage whose own curve starts in 2004, long before the alta. */
  async function seedOldMortgage(store: WorthlineStore, plan = true): Promise<void> {
    await store.liabilities.createLiability({
      balanceMinor: 60_000_00,
      currency: "EUR",
      id: "hipoteca",
      name: "Hipoteca Plasencia",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("hipoteca", "amortizable");
    if (!plan) return;
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.04",
      disbursementDate: "2004-05-19",
      firstPaymentDate: "2004-06-19",
      id: "plan-hipoteca",
      initialCapitalMinor: 150_253_03,
      liabilityId: "hipoteca",
      termMonths: 300,
    });
  }

  const housingForm = (extra: Record<string, string> = {}): FormData =>
    form({
      simpleDrawer: "inmueble",
      simpleName_inmueble: "Piso Plasencia",
      simpleValue_inmueble: "210.000,00",
      primaryResidence_inmueble: "off",
      ownershipPreset: "scope",
      scopeMemberId: "mJ",
      ...extra,
    });

  test("asks about the date, and the alta still goes through", async () => {
    const store = await seedStore();
    await seedOldMortgage(store);

    const url = await runAction(housingForm(), store);

    expect(url).toContain("ok=asset_added_acquisition_today");
    expect(url).toContain("deudaDesde=2004-05-19");
    // A warning, never a rejection: the inmueble is on disk.
    expect(await store.assets.readAssets()).toHaveLength(1);
  });

  test("no question when the acquisition date is historical", async () => {
    const store = await seedStore();
    await seedOldMortgage(store);

    const url = await runAction(
      form({
        instrument: "property",
        name_property: "Piso Plasencia",
        acqDate_property: "2004-05-19",
        acqValue_property: "150.253,03",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=asset_added");
    expect(url).not.toContain("acquisition_today");
  });

  test("no question with no debt at all", async () => {
    const store = await seedStore();

    const url = await runAction(housingForm(), store);

    expect(url).toContain("ok=asset_added");
    expect(url).not.toContain("acquisition_today");
  });

  test("no question from a debt that declares no start date (no plan)", async () => {
    const store = await seedStore();
    await seedOldMortgage(store, false);

    const url = await runAction(housingForm(), store);

    expect(url).toContain("ok=asset_added");
    expect(url).not.toContain("acquisition_today");
  });

  test("no question on a non-housing alta — nothing there is dated by acquisition", async () => {
    const store = await seedStore();
    await seedOldMortgage(store);

    const url = await runAction(
      form({
        instrument: "current_account",
        name_current_account: "Cuenta BBVA",
        value_current_account: "2.500,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=asset_added");
    expect(url).not.toContain("acquisition_today");
  });
});

describe("createHoldingAction — inmueble partial split with a non-member (#598)", () => {
  test("housing drawer keeps a custom split below 100% (rest is a non-member's)", async () => {
    const store = await seedHousehold();

    // Jose 50% + Ana 30% = 80%; the remaining 20% belongs to someone outside the
    // workspace. Both members are positive, so the split can NOT auto-complete to
    // 100% — it is preserved exactly, which only a real_estate holding allows.
    const url = await runAction(
      form({
        simpleDrawer: "inmueble",
        simpleName_inmueble: "Piso heredado",
        simpleValue_inmueble: "300.000,00",
        primaryResidence_inmueble: "off",
        ownershipPreset: "custom",
        scopeMemberId: "mJ",
        owner_mJ: "50",
        owner_mA: "30",
      }),
      store,
    );

    expect(url).toContain("ok="); // accepted, not rejected as "must sum to 100%"

    const asset = (await store.assets.readAssets()).find(
      (a) => a.name === "Piso heredado",
    )!;
    expect(asset.type).toBe("real_estate");
    expect(
      Object.fromEntries(asset.ownership.map((o) => [o.memberId, o.shareBps])),
    ).toEqual({
      mJ: 5_000,
      mA: 3_000,
    });
  });

  test("a non-inmueble drawer rejects the same partial split (no phantom net worth)", async () => {
    const store = await seedHousehold();

    const url = await runAction(
      form({
        simpleDrawer: "dinero",
        simpleName_dinero: "Cuenta compartida con un tercero",
        simpleValue_dinero: "10.000,00",
        ownershipPreset: "custom",
        scopeMemberId: "mJ",
        owner_mJ: "50",
        owner_mA: "30",
      }),
      store,
    );

    expect(url).toContain("error=");
    expect(
      (await store.assets.readAssets()).some(
        (a) => a.name === "Cuenta compartida con un tercero",
      ),
    ).toBe(false);
  });
});

describe("createHoldingAction — derived investments", () => {
  test("stock → investment with instrument=stock and the yahoo provider", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        instrument: "stock",
        name_stock: "Apple",
        symbol_stock: "AAPL",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=");

    const meta = await store.assets.readInvestmentAssetsWithMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0]!.priceProvider).toBe("yahoo");
    expect(meta[0]!.providerSymbol).toBe("AAPL");

    // The chosen instrument is persisted distinctly — not collapsed to "fund".
    const asset = (await store.assets.readAssets()).find((a) => a.id === meta[0]!.id);
    expect(asset?.instrument).toBe("stock");
    expect(asset?.liquidityTier).toBe("market");
  });

  test("crypto → investment with instrument=crypto and the coingecko provider", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "crypto",
        name_crypto: "Bitcoin",
        symbol_crypto: "bitcoin",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    expect(meta.priceProvider).toBe("coingecko");

    const asset = (await store.assets.readAssets()).find((a) => a.id === meta.id);
    expect(asset?.instrument).toBe("crypto");
  });

  test("pension_plan → investment with instrument=pension_plan and finect provider", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "pension_plan",
        name_pension_plan: "Indexa",
        symbol_pension_plan: "N5394",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    expect(meta.priceProvider).toBe("finect");

    const asset = (await store.assets.readAssets()).find((a) => a.id === meta.id);
    expect(asset?.instrument).toBe("pension_plan");
    expect(asset?.liquidityTier).toBe("term-locked");
  });

  test("fund → investment persists the searched ISIN", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "fund",
        name_fund: "Vanguard Global",
        symbol_fund: "0P0001CLDK.F",
        isin_fund: "IE00BYX5NX33",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    expect(meta.isin).toBe("IE00BYX5NX33");
    expect(meta.providerSymbol).toBe("0P0001CLDK.F");
  });
});

describe("createHoldingAction — investment drawer, saldo-de-hoy (#597)", () => {
  test("saldo path creates the investment AND an opening BUY with derived units, valued today", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "crypto",
        name_crypto: "Bitcoin",
        symbol_crypto: "bitcoin",
        price_crypto: "50.000,00",
        invMode_crypto: "saldo",
        saldo_crypto: "1.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("/patrimonio");
    expect(url).toContain("ok=");

    // The investment is created with its group's provider.
    const meta = await store.assets.readInvestmentAssetsWithMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0]!.priceProvider).toBe("coingecko");
    expect(meta[0]!.providerSymbol).toBe("bitcoin");

    // An opening BUY dated today, units = saldo / price (1000 / 50000 = 0.02).
    const ops = await store.operations.readOperations(meta[0]!.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("buy");
    expect(ops[0]!.executedAt).toBe("2026-06-15");
    expect(ops[0]!.units).toBe("0.02");
    expect(ops[0]!.pricePerUnit).toBe("50000.00");
    expect(ops[0]!.source).toBe("opening");

    // It lands valued (≈ saldo), not the 0 € container the alta used to create.
    const asset = (await store.assets.readAssets()).find((a) => a.type === "investment");
    expect(asset?.currentValue.amountMinor).toBe(100_000);
  });

  test("a blank «Fecha del saldo» keeps the opening dated today (#1395, unchanged path)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "crypto",
        name_crypto: "Bitcoin",
        symbol_crypto: "bitcoin",
        price_crypto: "50.000,00",
        invMode_crypto: "saldo",
        saldo_crypto: "1.000,00",
        saldoDate_crypto: "",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);
    expect(ops[0]!.executedAt).toBe("2026-06-15");
    // Dated today, so there is no past to reconstruct: no backfilled snapshot.
    expect(await store.snapshots.readSnapshots()).toHaveLength(0);
  });

  test("a past «Fecha del saldo» dates the opening there and rebuilds the history from that day (#1395)", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "fund",
        name_fund: "Fondo destino del traspaso",
        symbol_fund: "VANGTLI",
        price_fund: "319,59",
        invMode_fund: "saldo",
        saldo_fund: "1.089,79",
        // The traspaso landed 15 days before the alta (#1393): the money left the
        // origin fund then, and the destination must exist from that day.
        saldoDate_fund: "2026-05-31",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=investment_added");

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.executedAt).toBe("2026-05-31");
    expect(ops[0]!.units).toBe("3.409963");
    expect(ops[0]!.source).toBe("opening");

    // The ripple (ADR 0012/0020) reconstructed the net worth AT the saldo date —
    // the hole between the exit and the re-entry is what #1395 is about.
    const snapshots = await store.snapshots.readSnapshots();
    expect(snapshots.map((snap) => snap.dateKey)).toContain("2026-05-31");
    const rebuilt = snapshots.find((snap) => snap.dateKey === "2026-05-31")!;
    expect(rebuilt.totalNetWorth.amountMinor).toBeGreaterThanOrEqual(1_089_79);
  });

  test("a future «Fecha del saldo» is refused and records no opening (#1395)", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "crypto",
        name_crypto: "Bitcoin",
        symbol_crypto: "bitcoin",
        price_crypto: "50.000,00",
        invMode_crypto: "saldo",
        saldo_crypto: "1.000,00",
        saldoDate_crypto: "2026-07-01",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url).replaceAll("+", " ")).toContain(
      "desde una fecha futura",
    );
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(0);
    expect(await store.snapshots.readSnapshots()).toHaveLength(0);
  });

  test("an impossible calendar date is refused and refills the field (#1395)", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "crypto",
        name_crypto: "Bitcoin",
        symbol_crypto: "bitcoin",
        price_crypto: "50.000,00",
        invMode_crypto: "saldo",
        saldo_crypto: "1.000,00",
        // Passes any ISO regex and sorts before today, yet 30 February is not a day:
        // it would land as an executed_at (and a snapshot dateKey) no calendar reads.
        saldoDate_crypto: "2026-02-30",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    // The redirect encodes spaces as «+», so read it back the way a URL does.
    const decoded = decodeURIComponent(url).replaceAll("+", " ");
    expect(decoded).toContain("no es válida");
    // The guard fires before any write: no holding, no operation, no snapshot — and
    // the typed date comes back, so the fix is one edit instead of a re-entry.
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(0);
    expect(await store.snapshots.readSnapshots()).toHaveLength(0);
    expect(decoded).toContain("v_saldoDate_crypto=2026-02-30");
  });

  test("el coste declarado es el precio de la apertura, y la plusvalía latente aparece (#1490)", async () => {
    const store = await seedStore();

    // Jorge's real alta, replayed: 27 uds of the SXR1 worth 5.865,75 € today at
    // 217,25 €, bought between December and January for 4.999,86 € in total.
    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "fund",
        name_fund: "iShares Core S&P 500",
        symbol_fund: "SXR1.DE",
        price_fund: "217,25",
        invMode_fund: "saldo",
        saldo_fund: "5.865,75",
        saldoDate_fund: "2026-01-15",
        cost_fund: "4.999,86",
        costMode_fund: "total",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=investment_added");

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);
    expect(ops).toHaveLength(1);
    // The units come from what it is WORTH today; the price from what it COST.
    expect(ops[0]!.units).toBe("27");
    expect(ops[0]!.pricePerUnit).toBe("185.18");
    expect(ops[0]!.executedAt).toBe("2026-01-15");
    expect(ops[0]!.source).toBe("opening");

    // Cost basis 4.999,86 € against a 5.865,75 € position: the 865,89 € of latent
    // gain that used to be erased by writing today's price as the cost.
    const asset = (await store.assets.readAssets()).find((a) => a.type === "investment");
    expect(asset?.currentValue.amountMinor).toBe(5_865_75);
  });

  test("un coste por participación se persiste tal cual (#1490)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "fund",
        name_fund: "iShares Core S&P 500",
        symbol_fund: "SXR1.DE",
        price_fund: "217,25",
        invMode_fund: "saldo",
        saldo_fund: "5.865,75",
        cost_fund: "185,18",
        costMode_fund: "unit",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);
    expect(ops[0]!.pricePerUnit).toBe("185.18");
  });

  test("un coste que no se lee refusa el alta entera y lo devuelve tecleado (#1490)", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "fund",
        name_fund: "iShares Core S&P 500",
        symbol_fund: "SXR1.DE",
        price_fund: "217,25",
        invMode_fund: "saldo",
        saldo_fund: "5.865,75",
        cost_fund: "cinco mil",
        costMode_fund: "total",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const decoded = decodeURIComponent(url).replaceAll("+", " ");
    expect(decoded).toContain("coste de adquisición no se lee");
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(0);
    // The cost and its mode come back typed: the figure the user had to look up is
    // not something to make him find twice.
    expect(decoded).toContain("v_cost_fund=cinco mil");
    expect(decoded).toContain("v_costMode_fund=total");
  });

  test("sin coste la apertura sigue naciendo al precio de hoy — pero ya es una elección (#1490)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "fund",
        name_fund: "iShares Core S&P 500",
        symbol_fund: "SXR1.DE",
        price_fund: "217,25",
        invMode_fund: "saldo",
        saldo_fund: "5.865,75",
        cost_fund: "",
        costMode_fund: "total",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);
    expect(ops[0]!.pricePerUnit).toBe("217.25");
    // And whatever the cost says, the apertura is never read as savings (#1490's
    // engine half): `source: "opening"` is the mark that rules that out.
    expect(ops[0]!.source).toBe("opening");
  });

  test("import path creates the investment with NO opening operation and routes to «Cargar movimientos»", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "fund",
        name_fund: "Vanguard Global",
        symbol_fund: "VANGTLI",
        // A saldo + price are present but MUST be ignored in import mode (exclusion).
        price_fund: "215,40",
        saldo_fund: "10.000,00",
        invMode_fund: "import",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const meta = await store.assets.readInvestmentAssetsWithMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0]!.priceProvider).toBe("yahoo");

    // No synthetic opening — the broker CSV's orders will be the only operations.
    expect(await store.operations.readOperations(meta[0]!.id)).toHaveLength(0);

    // Routed to the holding's edit page, where «Cargar movimientos» lives (#173),
    // addressed by its public `wl_hld_…` id (#1318).
    expect(url).toContain(`/patrimonio/${await publicIdOf(store, meta[0]!.id)}/editar`);
    expect(url).toContain("ok=investment_import_ready");
  });

  test("saldo without a price errors with manual-fallback guidance and creates nothing persistent", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "inversion",
        instrument: "crypto",
        name_crypto: "Bitcoin",
        symbol_crypto: "bitcoin",
        price_crypto: "",
        invMode_crypto: "saldo",
        saldo_crypto: "1.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toContain("precio");
    // The price guard fires before the creation, so there is no 0 € container either
    // — the "no orphaned holding" the action's comment promises.
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(0);
  });
});

describe("createHoldingAction — debts", () => {
  test("mortgage → mortgage liability with the amortizable model", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        instrument: "mortgage",
        name_mortgage: "Hipoteca Santander",
        balance_mortgage: "120.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok=");

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(liability.type).toBe("mortgage");
    expect(liability.currentBalance.amountMinor).toBe(12_000_000);
    expect(await store.liabilities.readDebtModel(liability.id)).toBe("amortizable");
    // The instrument is recoverable from (type, debtModel).
    expect(defaultInstrumentForLiability("mortgage", "amortizable")).toBe("mortgage");
  });

  test("loan → debt liability with the amortizable model (derives to loan)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "loan",
        name_loan: "Préstamo coche",
        balance_loan: "8.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(liability.type).toBe("debt");
    expect(await store.liabilities.readDebtModel(liability.id)).toBe("amortizable");
    expect(defaultInstrumentForLiability("debt", "amortizable")).toBe("loan");
  });

  test("loan + debtModel=informal → debt liability with the informal model, valued anchored (#273)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "loan",
        name_loan: "Préstamo a mi hermano",
        balance_loan: "3.000,00",
        debtModel_loan: "informal",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(liability.type).toBe("debt");
    expect(liability.currentBalance.amountMinor).toBe(300_000);
    const debtModel = await store.liabilities.readDebtModel(liability.id);
    expect(debtModel).toBe("informal");
    // AC#4: an informal loan is valued by declared balances (anchored), not a plan.
    expect(valuationMethodOfLiability(debtModel)).toBe("anchored");
    // It still recovers to the `loan` instrument (type + model).
    expect(defaultInstrumentForLiability("debt", "informal")).toBe("loan");
  });

  test("loan + debtModel=amortizable (explicit) keeps the amortizable model (#273)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "loan",
        name_loan: "Préstamo coche",
        balance_loan: "8.000,00",
        debtModel_loan: "amortizable",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(await store.liabilities.readDebtModel(liability.id)).toBe("amortizable");
  });

  test("credit_card → debt liability with the revolving model (derives to credit_card)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        instrument: "credit_card",
        name_credit_card: "Visa BBVA",
        balance_credit_card: "850,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(liability.type).toBe("debt");
    expect(await store.liabilities.readDebtModel(liability.id)).toBe("revolving");
    expect(defaultInstrumentForLiability("debt", "revolving")).toBe("credit_card");
  });
});

describe("createHoldingAction — debt ownership inheritance (#171)", () => {
  test("a mortgage associated to an asset, inherit on, copies the asset's split", async () => {
    const store = await seedHousehold();

    await runAction(
      form({
        instrument: "mortgage",
        name_mortgage: "Hipoteca Santander",
        balance_mortgage: "120.000,00",
        assoc_mortgage: "piso",
        inheritOwnership_mortgage: "on",
        // The footer says 100% Jose — it MUST be ignored while inherit is on.
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(liability.associatedAssetId).toBe("piso");
    // Equals the piso's split (65/35), not the footer's 100% Jose.
    expect(await ownershipByMember(store)).toEqual({ mJ: 6_500, mA: 3_500 });
  });

  test("inherit off uses the footer ownership inputs exactly as today", async () => {
    const store = await seedHousehold();

    await runAction(
      form({
        instrument: "mortgage",
        name_mortgage: "Hipoteca",
        balance_mortgage: "120.000,00",
        assoc_mortgage: "piso",
        // The inherit checkbox is unchecked → its field is absent from the POST.
        ownershipPreset: "even",
      }),
      store,
    );

    // The footer's even split wins — NOT the piso's 65/35.
    expect(await ownershipByMember(store)).toEqual({ mJ: 5_000, mA: 5_000 });
  });

  test("inherits a partially-owned home's split and accepts it (single member, 75%)", async () => {
    // A home co-owned with a non-member: 75% Jose, 25% external. The mortgage on
    // it mirrors the 75% — a debt on a co-owned home is a known partial (#171),
    // not rejected by the "totals 100%" rule that standalone debts obey.
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 7_500 }],
      type: "real_estate",
    });

    const url = await runAction(
      form({
        instrument: "mortgage",
        name_mortgage: "Hipoteca",
        balance_mortgage: "120.000,00",
        assoc_mortgage: "piso",
        inheritOwnership_mortgage: "on",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("ok="); // accepted, not rejected as "must sum to 100%"
    expect(await ownershipByMember(store)).toEqual({ mJ: 7_500 });
  });

  test("inherit on but no asset associated falls back to the footer preset (no crash)", async () => {
    const store = await seedHousehold();

    await runAction(
      form({
        instrument: "mortgage",
        name_mortgage: "Hipoteca",
        balance_mortgage: "120.000,00",
        assoc_mortgage: "",
        inheritOwnership_mortgage: "on",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(await ownershipByMember(store)).toEqual({ mJ: 10_000 });
  });

  test("the inherited split is a one-time copy — a later asset edit does not move it", async () => {
    const store = await seedHousehold();

    await runAction(
      form({
        instrument: "mortgage",
        name_mortgage: "Hipoteca",
        balance_mortgage: "120.000,00",
        assoc_mortgage: "piso",
        inheritOwnership_mortgage: "on",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );
    expect(await ownershipByMember(store)).toEqual({ mJ: 6_500, mA: 3_500 });

    // Changing the asset's split afterwards must NOT follow into the liability:
    // the inheritance is a copy at creation, not a live link (CONTEXT.md).
    await store.assets.updateAsset("piso", {
      ownership: [
        { memberId: "mJ", shareBps: 9_000 },
        { memberId: "mA", shareBps: 1_000 },
      ],
    });

    expect(await ownershipByMember(store)).toEqual({ mJ: 6_500, mA: 3_500 });
  });
});

describe("createHoldingAction — «alta por estado actual» wizard drawer mode (ADR 0056, #677)", () => {
  // Real drawer shape (simpleDrawer/simpleDebtKind/simpleName_deuda), not the
  // canonical instrument/name_mortgage/balance_mortgage form the avanzado flow
  // posts directly — this is what anadir/page.tsx's DebtPane actually submits.
  test("a mortgage with current-state fields saves a plan + startsAtBaseline re-baseline (default for old debts)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "deuda",
        simpleDebtKind: "mortgage",
        simpleName_deuda: "Hipoteca Santander",
        csAnnualRate: "2,35",
        csEndDate: "2032-06-30",
        csInputMode: "rate",
        csNextPaymentDate: "2026-08-01",
        csOutstandingBalance: "118.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(liability.currentBalance.amountMinor).toBe(118_000_00);

    const plan = await store.liabilities.readAmortizationPlan(liability.id);
    expect(plan).toMatchObject({
      disbursementDate: CLOCK.today(),
      firstPaymentDate: "2026-08-01",
      initialCapitalMinor: 118_000_00,
    });

    const rebaselines = await store.liabilities.readBalanceRebaselines(liability.id);
    expect(rebaselines).toHaveLength(1);
    expect(rebaselines[0]).toMatchObject({ startsAtBaseline: true });
  });

  // Regression for the #677 review's H1: the CSS hides the plain "Saldo
  // pendiente" field for mortgage/loan (the current-state balance is the only
  // visible input), so leaving the end date blank must NOT also lose the
  // balance — it still creates a plan-less debt WITH the declared saldo.
  test("leaving the end date blank keeps today's plan-less creation, WITH the current-state saldo (origin path intact)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "deuda",
        simpleDebtKind: "mortgage",
        simpleName_deuda: "Hipoteca",
        csOutstandingBalance: "120.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(liability.currentBalance.amountMinor).toBe(120_000_00);
    expect(await store.liabilities.readAmortizationPlan(liability.id)).toBeNull();
  });

  test("a credit card ignores current-state fields even when present (revolving, no plan)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        simpleDrawer: "deuda",
        simpleDebtKind: "credit_card",
        simpleName_deuda: "Visa BBVA",
        simpleValue_deuda: "850,00",
        csAnnualRate: "20",
        csEndDate: "2032-06-30",
        csInputMode: "rate",
        csNextPaymentDate: "2026-08-01",
        csOutstandingBalance: "850,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    const liability = (await store.liabilities.readLiabilities())[0]!;
    expect(await store.liabilities.readDebtModel(liability.id)).toBe("revolving");
    expect(await store.liabilities.readAmortizationPlan(liability.id)).toBeNull();
  });

  test("an infeasible current-state declaration rejects the whole add (no liability created)", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({
        simpleDrawer: "deuda",
        simpleDebtKind: "mortgage",
        simpleName_deuda: "Hipoteca",
        csEndDate: "2032-06-30",
        csInputMode: "payment",
        csMonthlyPayment: "1,00",
        csNextPaymentDate: "2026-08-01",
        csOutstandingBalance: "118.000,00",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("error=");
    expect(await store.liabilities.readLiabilities()).toHaveLength(0);
  });
});

/**
 * «Viene traspasada de otra entidad» (#1541, S6 of PRD #1393).
 *
 * The worked case is literal and it is in production: on 23-ene-2026 MyInvestor's
 * «Traer plan desde otra entidad» landed 95,46 € into Jorge's pension plan. The alta
 * had no way to say that, so the row was written by hand in the 19-ago retyping pass
 * — and the two things he could have done instead are the two ADR 0083 rejected: a
 * `buy` eats a year of contribution allowance (ADR 0080) for capital that merely
 * changed manager, and a fabricated outgoing half promises an origin that does not
 * exist.
 */
describe("createHoldingAction — investment drawer, «viene traspasada de otra entidad» (#1541)", () => {
  /** The enero-2026 alta, as the pane posts it. */
  const ENERO = {
    simpleDrawer: "inversion",
    instrument: "pension_plan",
    name_pension_plan: "Plan de pensiones MyInvestor",
    symbol_pension_plan: "N5394-Myinvestor",
    invMode_pension_plan: "traspaso",
    trAmount_pension_plan: "95,46",
    trDate_pension_plan: "2026-01-23",
    trPrice_pension_plan: "12,50",
    ownershipPreset: "scope",
    scopeMemberId: "mJ",
  };

  test("writes ONE transfer_in with its own transferId, not a compra", async () => {
    const store = await seedStore();

    const url = await runAction(form(ENERO), store);

    expect(url).toContain("ok=investment_transfer_in_added");

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("transfer_in");
    expect(ops[0]!.executedAt).toBe("2026-01-23");
    expect(ops[0]!.units).toBe("7.6368");
    expect(ops[0]!.transferId).toBeTruthy();
    // «manual», never «opening»: that mark means a synthetic apertura the alta
    // invented, and `replaceOpening` is allowed to drop those. This row is a fact
    // the user declared, with its own date and its own inherited cost.
    expect(ops[0]!.source).toBe("manual");
  });

  test("the entry does NOT consume the year's contribution allowance (ADR 0080)", async () => {
    const store = await seedStore();
    await runAction(form(ENERO), store);

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const usage = computeContributionAllowanceUsage({
      allowance: {
        annualCapMinor: 150_000,
        holdingIds: [meta.id],
        id: "cupo",
        label: "Planes de pensiones",
        scopeId: "mJ",
      },
      currency: "EUR",
      operations: await store.operations.readOperations(meta.id),
      // Read inside the same calendar year as the entry — the window that would
      // have counted it.
      todayISO: "2026-06-15",
    });

    expect(usage.consumedMinor).toBe(0);
    expect(usage.entries).toEqual([]);
    expect(usage.remainingMinor).toBe(150_000);
  });

  test("«sé cuánto tengo hoy» tampoco consume cupo: una apertura no es una aportación (#1567)", async () => {
    const store = await seedStore();

    await runAction(
      form({
        ...ENERO,
        invMode_pension_plan: "saldo",
        saldo_pension_plan: "95,46",
        price_pension_plan: "12,50",
        saldoDate_pension_plan: "2026-01-23",
      }),
      store,
    );

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const usage = computeContributionAllowanceUsage({
      allowance: {
        annualCapMinor: 150_000,
        holdingIds: [meta.id],
        id: "cupo",
        label: "Planes de pensiones",
        scopeId: "mJ",
      },
      currency: "EUR",
      operations: await store.operations.readOperations(meta.id),
      todayISO: "2026-06-15",
    });

    expect(usage.consumedMinor).toBe(0);
    expect(usage.entries).toEqual([]);
    expect(usage.remainingMinor).toBe(150_000);
  });

  test("the inherited cost defaults to what arrived — no plusvalía latente invented", async () => {
    const store = await seedStore();
    await runAction(form(ENERO), store);

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);

    expect(ops[0]!.transferCostMinor).toBe(9_546);
  });

  test("a declared inherited cost is what the participaciones carry", async () => {
    const store = await seedStore();
    await runAction(form({ ...ENERO, trCost_pension_plan: "80,00" }), store);

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);

    expect(ops[0]!.transferCostMinor).toBe(8_000);
  });

  test("the loose half has no counterpart, so a reader can name it «otra entidad» (#1481)", async () => {
    const store = await seedStore();
    await runAction(form(ENERO), store);

    const meta = (await store.assets.readInvestmentAssetsWithMeta())[0]!;
    const ops = await store.operations.readOperations(meta.id);
    const counterparts = await store.operations.readTransferCounterparts(meta.id);

    // Absent from the map is the contract for «the other half lives outside
    // worthline» — never a broken pair.
    expect(counterparts.has(ops[0]!.transferId!)).toBe(false);
  });

  test("the declared VL becomes the holding's price, so the plan does not land at 0 €", async () => {
    const store = await seedStore();
    await runAction(form(ENERO), store);

    const asset = (await store.assets.readAssets()).find((a) => a.type === "investment");

    expect(asset?.currentValue.amountMinor).toBe(9_546);
  });

  test("a price left over in the hidden saldo pane does not outrank the declared VL", async () => {
    // Every pane posts even while hidden (ADR 0009), so `price_*` can carry a figure
    // the user typed before switching modes. The VL of the pane they actually chose
    // is the price of record; a real provider quote still beats it at read time
    // (ADR 0006), so nothing that IS quoted is affected.
    const store = await seedStore();

    await runAction(form({ ...ENERO, price_pension_plan: "999,00" }), store);

    const asset = (await store.assets.readAssets()).find((a) => a.type === "investment");

    expect(asset?.currentValue.amountMinor).toBe(9_546);
  });

  test("the entry rebuilds the history from the day the capital landed (ADR 0020)", async () => {
    const store = await seedStore();
    await runAction(form(ENERO), store);

    const snapshots = await store.snapshots.readSnapshots();

    expect(snapshots.map((snap) => snap.dateKey)).toContain("2026-01-23");
  });

  test("a future entry date is refused and leaves no empty holding behind", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({ ...ENERO, trDate_pension_plan: "2026-07-01" }),
      store,
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url).replaceAll("+", " ")).toContain(
      "desde una fecha futura",
    );
    expect(await store.assets.readAssets()).toHaveLength(0);
  });

  test("a VL of zero is refused with the gate's own words, and nothing is written", async () => {
    const store = await seedStore();

    const url = await runAction(form({ ...ENERO, trPrice_pension_plan: "0" }), store);

    expect(url).toContain("error=");
    expect(decodeURIComponent(url).replaceAll("+", " ")).toContain(
      "valor liquidativo de la inversión de destino",
    );
    expect(await store.assets.readAssets()).toHaveLength(0);
  });

  test("a refused entry comes back with the four figures still typed (#1329)", async () => {
    const store = await seedStore();

    const url = await runAction(
      form({ ...ENERO, trCost_pension_plan: "ochenta" }),
      store,
    );
    const decoded = decodeURIComponent(url);

    expect(decoded).toContain("v_trAmount_pension_plan=95,46");
    expect(decoded).toContain("v_trDate_pension_plan=2026-01-23");
    expect(decoded).toContain("v_trPrice_pension_plan=12,50");
    expect(decoded).toContain("v_trCost_pension_plan=ochenta");
    expect(decoded).toContain("v_invMode_pension_plan=traspaso");
  });
});
