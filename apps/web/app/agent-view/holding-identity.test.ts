/**
 * Instrument identity on the holding row (#1346).
 *
 * The dead end this closes, from a real transcript (2026-07-30 noche): «prepara una
 * lista de todos los instrumentos bursátiles con nombre, ISIN y número de
 * participaciones». No row of the agent view carried an ISIN, a provider symbol, or units, so
 * the model fanned out `get_holding_detail` fund by fund, gave up after three, and
 * then ASSERTED the rest had no ISIN registered — while 17 of 24 did. An enumeration
 * question has to be answerable in ONE read, and that means the identity travels on
 * the row the model is already looking at.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import type { InvestmentOperation } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

import { buildFinancialContext } from "./financial-context";
import { buildHoldingDetail } from "./holding-detail";
import { resolveHoldingIdentity } from "./holding-identity";
import { buildHoldingSearch } from "./holding-search";
import { bindScope } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";

const AS_OF = "2026-07-30";
const SOLO = [{ memberId: "m", shareBps: 10_000 }];

const openStores = new Set<WorthlineStore>();
afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
});

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  openStores.add(store);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Titular" }],
    mode: "individual",
  });
  return store;
}

async function createFund(
  store: WorthlineStore,
  input: {
    id: string;
    name: string;
    isin?: string;
    providerSymbol?: string;
    /** Buy/sell pairs as `[kind, units]`, priced at 100 €/unit. */
    operations?: Array<["buy" | "sell", string]>;
  },
): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: input.id,
    instrument: "fund",
    name: input.name,
    ownership: SOLO,
    ...(input.isin ? { isin: input.isin } : {}),
    ...(input.providerSymbol ? { providerSymbol: input.providerSymbol } : {}),
  });

  for (const [index, [kind, units]] of (input.operations ?? []).entries()) {
    await store.operations.recordOperation({
      assetId: input.id,
      currency: "EUR",
      executedAt: `2026-0${index + 1}-01T10:00:00.000Z`,
      id: `${input.id}-op-${index}`,
      kind,
      pricePerUnit: "100",
      units,
    });
  }
}

async function createCash(store: WorthlineStore, id: string, name: string) {
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id,
    instrument: "current_account",
    liquidityTier: "cash",
    name,
    ownership: SOLO,
    type: "cash",
  });
}

async function contextOf(store: WorthlineStore, holdingLimit?: number) {
  const scopes = await listAgentViewScopes(store.agentView);
  const scopeId = (scopes.find((scope) => scope.isDefault) ?? scopes[0])?.id ?? "";
  return buildFinancialContext(bindScope(store.agentView, scopeId), {
    asOf: AS_OF,
    ...(holdingLimit === undefined ? {} : { holdingLimit }),
  });
}

async function publicIdOf(store: WorthlineStore, internalId: string): Promise<string> {
  const row = (await store.agentView.readPublicIds()).find(
    (item) => item.entityType === "holding" && item.entityId === internalId,
  );
  if (!row) throw new Error(`no public id for ${internalId}`);
  return row.publicId;
}

describe("resolveHoldingIdentity", () => {
  test("carries the registered ISIN, provider symbol and net units held", () => {
    expect(
      resolveHoldingIdentity({
        meta: { isin: "LU0000000123", providerSymbol: "0P0000TEST.F" },
        operations: ledger([
          ["buy", "10"],
          ["sell", "2.5"],
        ]),
      }),
    ).toEqual({
      isin: "LU0000000123",
      providerSymbol: "0P0000TEST.F",
      units: "7.5",
    });
  });

  test("prefers the projected asset's provider symbol over the stored meta row", () => {
    // The asset row is what the price path reads (ADR 0011); meta is the fallback
    // for a holding whose symbol lives only on the investment reference row.
    expect(
      resolveHoldingIdentity({
        asset: { providerSymbol: "BTC" },
        meta: { providerSymbol: "0P0000TEST.F" },
      }),
    ).toEqual({ providerSymbol: "BTC" });
  });

  test("omits every field it has no fact for — absent, never a fabricated blank", () => {
    expect(resolveHoldingIdentity({})).toEqual({});
    expect(resolveHoldingIdentity({ meta: {}, operations: [] })).toEqual({});
  });

  test("reports 0 units for a sold-out position (operations exist, nothing held)", () => {
    // "0" is a fact, not a gap: the ledger says the position closed. Only a holding
    // with NO operations at all omits `units` (#1348 semantics).
    expect(
      resolveHoldingIdentity({
        operations: ledger([
          ["buy", "10"],
          ["sell", "10"],
        ]),
      }),
    ).toEqual({ units: "0" });
  });
});

/** A buy/sell ledger from `[kind, units]` pairs, priced at 100 €/unit. */
function ledger(
  entries: ReadonlyArray<readonly ["buy" | "sell", string]>,
): InvestmentOperation[] {
  return entries.map(([kind, units], index) => ({
    assetId: "a",
    currency: "EUR",
    executedAt: `2026-0${index + 1}-01T10:00:00.000Z`,
    feesMinor: 0,
    id: `op-${index}`,
    kind,
    pricePerUnit: "100",
    source: "manual",
    units,
  }));
}

describe("buildFinancialContext · instrument identity per row (#1346)", () => {
  test("stamps ISIN, provider symbol and net units on every investment row in ONE read", async () => {
    const store = await seed();
    await createFund(store, {
      id: "fund-a",
      isin: "LU0000000123",
      name: "Fondo Global",
      operations: [
        ["buy", "10"],
        ["sell", "2.5"],
      ],
      providerSymbol: "0P0000TEST.F",
    });
    await createFund(store, {
      id: "fund-b",
      isin: "ES0000000456",
      name: "Fondo Ibérico",
      operations: [["buy", "40"]],
    });
    await createCash(store, "cash", "Cuenta corriente");

    const context = await contextOf(store);
    const rows = new Map(context.holdings.items.map((holding) => [holding.id, holding]));
    const fundA = rows.get(await publicIdOf(store, "fund-a"));
    const fundB = rows.get(await publicIdOf(store, "fund-b"));
    const cash = rows.get(await publicIdOf(store, "cash"));

    expect(fundA).toMatchObject({
      isin: "LU0000000123",
      providerSymbol: "0P0000TEST.F",
      units: "7.5",
    });
    // A fund with an ISIN but no provider symbol reports the ISIN and stays silent about the
    // symbol — the enumeration answer is «this one has no symbol registered», never
    // «no ISIN consta» for the whole list.
    expect(fundB).toMatchObject({ isin: "ES0000000456", units: "40" });
    expect(fundB && "providerSymbol" in fundB).toBe(false);
    // A cash account has no instrument identity at all: absent, not blank.
    expect(cash).toBeDefined();
    expect(cash && "isin" in cash).toBe(false);
    expect(cash && "units" in cash).toBe(false);
    expect(cash && "providerSymbol" in cash).toBe(false);
  });

  test("the identity costs a bounded handful of bytes per investment row", async () => {
    // The context is the always-first read of every turn, so a per-row addition is
    // paid on every question. Measured, not assumed: three short fields per
    // investment row (#1346), against a ~1.000-byte row.
    const store = await seed();
    for (let index = 0; index < 20; index += 1) {
      await createFund(store, {
        id: `fund-${index}`,
        isin: `LU000000${index.toString().padStart(4, "0")}`,
        name: `Fondo ${index}`,
        operations: [["buy", "10"]],
        providerSymbol: `0P00000${index.toString().padStart(3, "0")}.F`,
      });
    }

    const items = (await contextOf(store, 100)).holdings.items;
    const stripped = items.map((holding) => {
      const withoutIdentity = { ...holding };
      delete withoutIdentity.isin;
      delete withoutIdentity.providerSymbol;
      delete withoutIdentity.units;
      return withoutIdentity;
    });
    const perRow =
      (JSON.stringify(items).length - JSON.stringify(stripped).length) / items.length;

    expect(items).toHaveLength(20);
    expect(perRow).toBeGreaterThan(0);
    expect(perRow).toBeLessThan(80);
  });
});

describe("buildHoldingDetail · the same identity as the row that led here (#1346)", () => {
  test("exposes isin, providerSymbol and units in the drilldown", async () => {
    const store = await seed();
    await createFund(store, {
      id: "fund-a",
      isin: "LU0000000123",
      name: "Fondo Global",
      operations: [
        ["buy", "10"],
        ["sell", "2.5"],
      ],
      providerSymbol: "0P0000TEST.F",
    });

    const detail = await buildHoldingDetail(
      store.agentView,
      await publicIdOf(store, "fund-a"),
      // The catalog is injected reference data, never the workspace store: an
      // unavailable one must not change what the identity reports.
      {
        readExposureCatalog: async () => ({
          status: "unavailable",
          reason: "read_failed",
        }),
      },
    );

    expect(detail).toMatchObject({
      isin: "LU0000000123",
      providerSymbol: "0P0000TEST.F",
      units: "7.5",
    });
    // And the row that leads here says exactly the same thing.
    const row = (await contextOf(store)).holdings.items[0];
    expect(row?.isin).toBe(detail.isin);
    expect(row?.providerSymbol).toBe(detail.providerSymbol);
    expect(row?.units).toBe(detail.units);
  });

  test("a liability drilldown carries no instrument identity at all", async () => {
    const store = await seed();
    await store.liabilities.createLiability({
      balanceMinor: 12_000_00,
      currency: "EUR",
      id: "loan",
      name: "Préstamo coche",
      ownership: SOLO,
      type: "debt",
    });

    const detail = await buildHoldingDetail(
      store.agentView,
      await publicIdOf(store, "loan"),
      {
        readExposureCatalog: async () => ({
          status: "unavailable",
          reason: "read_failed",
        }),
      },
    );

    expect("isin" in detail).toBe(false);
    expect("providerSymbol" in detail).toBe(false);
    expect("units" in detail).toBe(false);
  });
});

describe("buildHoldingSearch · net units per match (#1346)", () => {
  test("carries the units held so a lookup answers «cuántas participaciones»", async () => {
    const store = await seed();
    await createFund(store, {
      id: "fund-a",
      isin: "LU0000000123",
      name: "Fondo Global",
      operations: [
        ["buy", "10"],
        ["sell", "2.5"],
      ],
      providerSymbol: "0P0000TEST.F",
    });

    const scopes = await listAgentViewScopes(store.agentView);
    const scopeId = (scopes.find((scope) => scope.isDefault) ?? scopes[0])?.id ?? "";
    const page = await buildHoldingSearch(bindScope(store.agentView, scopeId), {
      asOf: AS_OF,
      limit: 10,
      query: "global",
    });

    expect(page.matches[0]).toMatchObject({
      isin: "LU0000000123",
      providerSymbol: "0P0000TEST.F",
      units: "7.5",
    });
  });
});
