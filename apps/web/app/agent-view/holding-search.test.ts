/**
 * Holding lookup by name/symbol (uso real 2026-07-30).
 *
 * The dead end this closes, from a real transcript: «hay un fondo que está a 0 €,
 * elimínalo». The compact context sorts by absolute value and cuts at its limit, so
 * a 0 € holding is invisible there; the user even supplied the exact ticker and
 * there was no read that took one.
 */

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test } from "vitest";

import { AgentViewHttpError } from "./contract";
import {
  buildHoldingSearch,
  DEFAULT_HOLDING_MATCH_LIMIT,
  normalizeSearchText,
} from "./holding-search";
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

async function search(
  store: WorthlineStore,
  query: string,
  limit = DEFAULT_HOLDING_MATCH_LIMIT,
) {
  const scopes = await listAgentViewScopes(store.agentView);
  const scopeId = (scopes.find((scope) => scope.isDefault) ?? scopes[0])?.id ?? "";
  return buildHoldingSearch(bindScope(store.agentView, scopeId), {
    asOf: AS_OF,
    limit,
    query,
  });
}

/**
 * A market fund with no operations and no cached price — so it is worth 0 €, which
 * is exactly the holding the compact context drops.
 */
async function createEmptyFund(
  store: WorthlineStore,
  input: { id: string; name: string; providerSymbol?: string; isin?: string },
): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: input.id,
    instrument: "fund",
    name: input.name,
    ownership: SOLO,
    ...(input.providerSymbol ? { providerSymbol: input.providerSymbol } : {}),
    ...(input.isin ? { isin: input.isin } : {}),
  });
}

/** A stored (hand-valued) holding, for the cases that need a real figure. */
async function createCash(
  store: WorthlineStore,
  input: { id: string; name: string; valueMinor: number },
): Promise<void> {
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: input.valueMinor,
    id: input.id,
    instrument: "current_account",
    liquidityTier: "cash",
    name: input.name,
    ownership: SOLO,
    type: "cash",
  });
}

async function publicIdOf(store: WorthlineStore, internalId: string): Promise<string> {
  const row = (await store.agentView.readPublicIds()).find(
    (item) => item.entityType === "holding" && item.entityId === internalId,
  );
  if (!row) throw new Error(`no public id for ${internalId}`);
  return row.publicId;
}

describe("normalizeSearchText", () => {
  test("folds case, accents and repeated whitespace", () => {
    expect(normalizeSearchText("  Colección   de   Monedas ")).toBe(
      "coleccion de monedas",
    );
  });
});

describe("buildHoldingSearch (uso real 2026-07-30)", () => {
  test("finds a holding worth 0 € by name, with the public id a baja needs", async () => {
    const store = await seed();
    await createEmptyFund(store, { id: "zero", name: "Fondo Cerrado Global" });
    await createCash(store, {
      id: "big",
      name: "Cuenta principal",
      valueMinor: 50_000_00,
    });

    const page = await search(store, "cerrado");

    expect(page.matches).toHaveLength(1);
    expect(page.matches[0]).toMatchObject({
      currentValue: { amountMinor: 0, currency: "EUR" },
      direction: "asset",
      id: await publicIdOf(store, "zero"),
      label: "Fondo Cerrado Global",
      matchedOn: "label",
      object: "holding",
    });
    expect(page.meta).toEqual({
      limit: DEFAULT_HOLDING_MATCH_LIMIT,
      query: "cerrado",
      totalMatches: 1,
      truncated: false,
    });
  });

  test("finds it by the exact ticker the user pasted", async () => {
    const store = await seed();
    await createEmptyFund(store, {
      id: "zero",
      isin: "LU0000000123",
      name: "Fondo Cerrado Global",
      providerSymbol: "0P0000TEST.F",
    });

    const page = await search(store, "0p0000test.f");

    expect(page.matches[0]?.matchedOn).toBe("providerSymbol");
    expect(page.matches[0]?.providerSymbol).toBe("0P0000TEST.F");

    const byIsin = await search(store, "lu0000000123");
    expect(byIsin.matches[0]?.matchedOn).toBe("isin");
  });

  test("matches accent- and case-insensitively", async () => {
    const store = await seed();
    await createCash(store, {
      id: "coll",
      name: "Colección de Monedas",
      valueMinor: 3_000_00,
    });

    const page = await search(store, "COLECCION");

    expect(page.matches.map((match) => match.label)).toEqual(["Colección de Monedas"]);
  });

  test("marks a sync-owned match so the answer is not «declara su valor»", async () => {
    const store = await seed();
    const { assetId } = await store.connectedSources.connect({
      adapter: "numista",
      credentialsJson: JSON.stringify({ apiKey: "test-key" }),
      label: "Colección de monedas",
      ownership: SOLO,
    });

    const page = await search(store, "monedas");

    expect(page.matches.map((match) => match.id)).toContain(
      await publicIdOf(store, assetId),
    );
    expect(page.matches[0]?.connectedSource).toEqual({
      adapter: "numista",
      label: "Colección de monedas",
    });
  });

  test("finds a debt by name too, so «borra este préstamo» resolves", async () => {
    const store = await seed();
    await store.liabilities.createLiability({
      balanceMinor: 6_000_00,
      currency: "EUR",
      id: "loan",
      name: "Préstamo del coche",
      ownership: SOLO,
      type: "debt",
    });

    const page = await search(store, "prestamo");

    expect(page.matches[0]).toMatchObject({
      direction: "liability",
      id: await publicIdOf(store, "loan"),
      label: "Préstamo del coche",
    });
  });

  test("ranks by absolute value, caps, and says the cap dropped matches", async () => {
    const store = await seed();
    await createCash(store, { id: "c1", name: "Cuenta A", valueMinor: 100_00 });
    await createCash(store, { id: "c2", name: "Cuenta B", valueMinor: 900_00 });
    await createCash(store, { id: "c3", name: "Cuenta C", valueMinor: 0 });

    const page = await search(store, "cuenta", 2);

    expect(page.matches.map((match) => match.label)).toEqual(["Cuenta B", "Cuenta A"]);
    expect(page.meta).toMatchObject({ limit: 2, totalMatches: 3, truncated: true });
  });

  test("a trashed holding is not a live match (that lens is get_trash_summary)", async () => {
    const store = await seed();
    await createEmptyFund(store, { id: "gone", name: "Fondo Cerrado" });
    await store.assets.softDeleteAsset("gone", `${AS_OF}T09:00:00.000Z`);

    const page = await search(store, "cerrado");

    expect(page.matches).toEqual([]);
    expect(page.meta.totalMatches).toBe(0);
  });

  test("an empty query is a 422, never a dump of every holding", async () => {
    const store = await seed();
    await createCash(store, { id: "c1", name: "Cuenta A", valueMinor: 100_00 });

    await expect(search(store, "   ")).rejects.toBeInstanceOf(AgentViewHttpError);
    await expect(search(store, "")).rejects.toMatchObject({ status: 422 });
  });

  test("a query nothing matches is an honest empty answer", async () => {
    const store = await seed();
    await createCash(store, { id: "c1", name: "Cuenta A", valueMinor: 100_00 });

    const page = await search(store, "hipoteca");

    expect(page.matches).toEqual([]);
    expect(page.meta.truncated).toBe(false);
  });
});
