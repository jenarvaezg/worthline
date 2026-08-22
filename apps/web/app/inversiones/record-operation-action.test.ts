/**
 * Integration test for `recordOperationAction`'s idempotency key (#1394), via the
 * `_store` injection seam.
 *
 * The case that motivated it: on 17-ago-2026 a double click left two identical
 * sells 4 seconds apart on the same fund, ~1.000 € of net worth evaporated, and —
 * because the operation was backdated — every snapshot from that date on rewritten
 * with the wrong units. The client now sends one `submissionId` per submission and
 * the action seeds the operation id with it, so a replay recognises its own row.
 *
 * The money-math counterpart is asserted here too: two operations that are
 * legitimately identical (a split periodic buy) arrive under different keys and
 * BOTH persist. Prior art: inversiones/cobros-action.test.ts.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { recordOperationAction } from "./actions";

const HOLDING = "h1";

async function seedHolding(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: HOLDING,
    liquidityTier: "market",
    name: "Palm Harbour Global Value F EUR Acc",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  return store;
}

async function seedBuy(
  store: WorthlineStore,
  units = "100",
  holding = HOLDING,
): Promise<void> {
  await store.command.recordInvestmentOperation(
    {
      assetId: holding,
      currency: "EUR",
      executedAt: "2026-01-01",
      feesMinor: 0,
      id: `seed-buy-${holding}`,
      kind: "buy",
      pricePerUnit: "10",
      units,
    },
    { today: "2026-08-22" },
  );
}

/** The sell the father recorded — twice. */
function sellForm(submissionId?: string): FormData {
  return operationForm({ kind: "sell", ...(submissionId ? { submissionId } : {}) });
}

function operationForm({
  kind = "sell",
  oversellConfirmed,
  submissionId,
  units = "47,96",
}: {
  kind?: string;
  oversellConfirmed?: boolean;
  submissionId?: string;
  units?: string;
}): FormData {
  const fd = new FormData();
  fd.set("currentUrl", `/patrimonio/${HOLDING}/editar`);
  fd.set("kind", kind);
  fd.set("executedAt", "2026-07-31");
  fd.set("units", units);
  fd.set("pricePerUnit", "21,24");
  fd.set("fees", "0");
  if (submissionId !== undefined) fd.set("submissionId", submissionId);
  if (oversellConfirmed) fd.set("oversellConfirmed", "1");
  return fd;
}

/** Run the action and return its NEXT_REDIRECT digest (the redirect URL). */
async function record(
  fd: FormData,
  store: WorthlineStore,
  holding = HOLDING,
  /** The injected ECB fetcher, for the non-EUR captures of #1401. */
  fxRates?: { fetchDailyRates: () => Promise<ReadonlyMap<string, number>> },
): Promise<string> {
  try {
    await recordOperationAction(holding, fd, store, ...(fxRates ? [fxRates] : []));
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

describe("recordOperationAction · submissionId idempotency (#1394)", () => {
  test("two submits of the SAME submissionId leave one operation", async () => {
    const store = await seedHolding();
    await seedBuy(store);
    const key = "9f2c4d7a1b3e4f5a8c9d0e1f2a3b4c5d";

    expect(await record(sellForm(key), store)).toContain("ok=saved");
    expect(await record(sellForm(key), store)).toContain("ok=saved");

    const operations = await store.operations.readOperations(HOLDING);
    expect(operations.filter((operation) => operation.kind === "sell")).toHaveLength(1);
    expect(operations.find((operation) => operation.kind === "sell")).toMatchObject({
      kind: "sell",
      units: "47.96",
    });
  });

  test("the replay reports success — the user never sees a phantom failure", async () => {
    const store = await seedHolding();
    await seedBuy(store);
    const key = "aaaabbbbccccddddeeeeffff00001111";

    await record(sellForm(key), store);
    const digest = await record(sellForm(key), store);

    expect(digest).toContain(`/patrimonio/${HOLDING}/editar`);
    expect(digest).not.toContain("error");
  });

  test("identical operations under DIFFERENT keys both persist", async () => {
    // A split periodic buy: same day, same units, same price, two real orders.
    // The ledger has no unique index on (asset, date), so nothing else would
    // stop them — the key is the only thing deciding, and it must not.
    const store = await seedHolding();

    await record(operationForm({ kind: "buy", submissionId: "1111111111111111" }), store);
    await record(operationForm({ kind: "buy", submissionId: "2222222222222222" }), store);

    const operations = await store.operations.readOperations(HOLDING);
    expect(operations).toHaveLength(2);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(2);
  });

  test("a replay carrying different values keeps the first ones", async () => {
    // Inherent to an idempotency key, and pinned as a decision rather than left
    // as an accident: only reachable by editing the form between two clicks of
    // the same frame, and the honest answer is that the FIRST submission won.
    const store = await seedHolding();
    await seedBuy(store);
    const key = "7777777777777777";

    await record(operationForm({ submissionId: key, units: "47,96" }), store);
    await record(operationForm({ submissionId: key, units: "10" }), store);

    const operations = await store.operations.readOperations(HOLDING);
    expect(operations.filter((operation) => operation.kind === "sell")).toHaveLength(1);
    expect(operations.find((operation) => operation.kind === "sell")?.units).toBe(
      "47.96",
    );
  });

  test("a genuine write failure still surfaces as an error", async () => {
    // The replay check must not turn every failed record into a silent success.
    const store = await seedHolding();
    await seedBuy(store);
    const failing: WorthlineStore = {
      ...store,
      command: {
        ...store.command,
        recordInvestmentOperation: async () => {
          throw new Error("la escritura falló de verdad");
        },
      },
    };

    await expect(
      recordOperationAction(HOLDING, sellForm("8888888888888888"), failing),
    ).rejects.toThrow("la escritura falló de verdad");
    expect(await store.operations.readOperations(HOLDING)).toHaveLength(1);
  });

  test("a key only dedupes within its own holding", async () => {
    const store = await seedHolding();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "h2",
      liquidityTier: "market",
      name: "Otro fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await seedBuy(store);
    await seedBuy(store, "100", "h2");
    const key = "5555555555555555";

    await record(sellForm(key), store);
    await record(sellForm(key), store, "h2");

    expect(await store.operations.readOperations(HOLDING)).toHaveLength(2);
    expect(await store.operations.readOperations("h2")).toHaveLength(2);
  });

  test("without a submissionId (no JS) each submit records, as before", async () => {
    const store = await seedHolding();
    await seedBuy(store);

    await record(sellForm(), store);
    await record(sellForm(), store);

    expect(
      (await store.operations.readOperations(HOLDING)).filter(
        (operation) => operation.kind === "sell",
      ),
    ).toHaveLength(2);
  });
});

describe("recordOperationAction · a replay that is NOT serialized (#1394)", () => {
  test("losing the INSERT race resolves to the same 'guardado', not a 500", async () => {
    // Next serializes one client's actions, so the ordinary double click arrives
    // second and the pre-read catches it. Two replicas that are NOT serialized —
    // two tabs, two devices, a browser retrying over a second connection — both
    // read before either writes, and the loser's INSERT hits the id's UNIQUE
    // constraint. Modelled here rather than raced for real: the in-memory store
    // shares one connection, so a genuine overlap rolls the WINNER's row back
    // too, which is an artefact of the test double and not of production.
    const store = await seedHolding();
    await seedBuy(store);
    const key = "3333333333333333";
    const raceLoser: WorthlineStore = {
      ...store,
      command: {
        ...store.command,
        recordInvestmentOperation: async (input, options) => {
          await store.command.recordInvestmentOperation(input, options); // the winner
          throw new Error(
            'Failed query: insert into "asset_operations"\nCaused by: UNIQUE constraint failed: asset_operations.id',
          );
        },
      },
    };

    expect(await record(sellForm(key), raceLoser)).toContain("ok=saved");
    expect(
      (await store.operations.readOperations(HOLDING)).filter(
        (operation) => operation.kind === "sell",
      ),
    ).toHaveLength(1);
  });
});

/**
 * The dollar apunte (#1401). Eight MyInvestor purchases of a USD-denominated Fidelity
 * fund were stored as euros, inflating the cost basis by 17,7 %; the form now carries
 * the currency and the action converts at the ECB rate of the execution date.
 */
describe("recordOperationAction — a capture outside EUR", () => {
  /** EUR per USD on 23-ene-2026, the day of the father's first purchase. */
  const usdRates = { fetchDailyRates: async () => new Map([["2026-01-23", 0.85]]) };

  function usdBuyForm(): FormData {
    const fd = new FormData();
    fd.set("currentUrl", `/patrimonio/${HOLDING}/editar`);
    fd.set("kind", "buy");
    fd.set("executedAt", "2026-01-23");
    fd.set("units", "0,255");
    fd.set("pricePerUnit", "8,00");
    fd.set("fees", "0");
    fd.set("currency", "USD");
    return fd;
  }

  test("persists the euros the engine folds AND the dollars the bank stated", async () => {
    const store = await seedHolding();

    await record(usdBuyForm(), store, HOLDING, usdRates);

    const [operation] = await store.operations.readOperations(HOLDING);
    // 8,00 US$ × 0,85 = 6,80 €. Before #1401 this row read `0.255 @ 8.00 EUR`.
    expect(operation?.currency).toBe("EUR");
    expect(operation?.pricePerUnit).toBe("6.8");
    expect(operation?.capture).toEqual({
      currency: "USD",
      eurPerUnit: 0.85,
      feesMinor: 0,
      pricePerUnit: "8.00",
    });
  });

  test("writes nothing and says why when no rate covers the date", async () => {
    const store = await seedHolding();

    const redirectUrl = await record(usdBuyForm(), store, HOLDING, {
      fetchDailyRates: async () => new Map(),
    });

    expect(await store.operations.readOperations(HOLDING)).toEqual([]);
    // `decodeURIComponent` does NOT turn `+` back into a space (#1395).
    expect(decodeURIComponent(redirectUrl).replaceAll("+", " ")).toContain(
      "No hay tipo de cambio del BCE de USD",
    );
  });

  test("a euro apunte never reaches the rate fetcher", async () => {
    const store = await seedHolding();
    let fetched = false;

    await record(operationForm({ kind: "buy" }), store, HOLDING, {
      fetchDailyRates: async () => {
        fetched = true;
        return new Map();
      },
    });

    expect(fetched).toBe(false);
    expect(await store.operations.readOperations(HOLDING)).toHaveLength(1);
  });
});

describe("recordOperationAction · oversell confirm (#1443)", () => {
  function readable(digest: string): string {
    return decodeURIComponent(digest).replaceAll("+", " ");
  }

  test("a sell past held without confirm writes nothing and asks for confirm", async () => {
    const store = await seedHolding();
    await seedBuy(store, "31.999");

    const digest = await record(operationForm({ kind: "sell", units: "32" }), store);

    expect(await store.operations.readOperations(HOLDING)).toHaveLength(1);
    expect(readable(digest)).toContain("redondeo del bróker");
    expect(readable(digest)).toContain("form=operation");
    expect(readable(digest)).toContain("v_oversellPending=1");
    expect(readable(digest)).not.toContain("ok=saved");
  });

  test("a 10× mistype uses the fat-finger copy", async () => {
    const store = await seedHolding();
    await seedBuy(store, "31.999");

    const digest = await record(operationForm({ kind: "sell", units: "320" }), store);

    expect(readable(digest)).toContain("supera con mucho la posición");
    expect(await store.operations.readOperations(HOLDING)).toHaveLength(1);
  });

  test("confirming persists the typed units, not the clamped ones", async () => {
    const store = await seedHolding();
    await seedBuy(store, "31.999");

    expect(
      await record(
        operationForm({ kind: "sell", oversellConfirmed: true, units: "32" }),
        store,
      ),
    ).toContain("ok=saved");

    const sells = (await store.operations.readOperations(HOLDING)).filter(
      (operation) => operation.kind === "sell",
    );
    expect(sells).toHaveLength(1);
    expect(sells[0]?.units).toBe("32");
  });

  test("a buy never asks for confirm even when the position is empty", async () => {
    const store = await seedHolding();

    expect(await record(operationForm({ kind: "buy", units: "32" }), store)).toContain(
      "ok=saved",
    );
    expect(await store.operations.readOperations(HOLDING)).toHaveLength(1);
  });
});
