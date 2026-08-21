/**
 * Integration test for the statement upload action (ADR 0018, #174) via the
 * `_store` injection seam. The action is scoped to the route asset id (no scope
 * cookie / next/headers dependency), so it runs fully here: parse the uploaded
 * plantilla CSV → create operations → one batched ripple → redirect with a
 * summary. Prior art: ajustes/numista-actions.test.ts.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { describe, expect, test } from "vitest";

import {
  confirmStatementAction,
  previewStatementAction,
  type StatementPreviewState,
} from "./actions";

const IDLE: StatementPreviewState = { status: "idle" };

const HEADER =
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre";

const CSV = [
  HEADER,
  "01/02/2024;Fondo;IE00BYX5NX33;Compra;7,226;100;;",
  "01/03/2024;Fondo;IE00BYX5NX33;Compra;7,180;100;;",
  "01/04/2024;Fondo;IE00BYX5NX33;Compra;7,050;100;;",
  "01/05/2024;Fondo;IE00BYX5NX33;Compra;39,120;559;;",
  "01/06/2024;Fondo;IE00BYX5NX33;Compra;6,900;100;;",
  "01/07/2024;Fondo;IE00BYX5NX33;Compra;6,800;100;;",
  "01/08/2024;Fondo;IE00BYX5NX33;Compra;6,700;100;;",
  "01/09/2024;Fondo;IE00BYX5NX33;Compra;95,400;1418,15;;",
].join("\n");

function uploadForm(csv: string, broker = "plantilla"): FormData {
  const fd = new FormData();
  fd.set("broker", broker);
  fd.set("currentUrl", "/patrimonio/fund/editar");
  fd.set("file", new File([csv], "plantilla.csv", { type: "text/csv" }));
  return fd;
}

async function seedFund(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

async function run(
  fd: FormData,
  store: WorthlineStore,
  assetId = "fund",
  /** The injected ECB fetcher, for a file that states a non-EUR currency (#1401). */
  fxRates?: { fetchDailyRates: () => Promise<ReadonlyMap<string, number>> },
): Promise<string> {
  try {
    await confirmStatementAction(assetId, fd, store, ...(fxRates ? [fxRates] : []));
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

function preview(
  fd: FormData,
  store: WorthlineStore,
  assetId = "fund",
): Promise<StatementPreviewState> {
  return previewStatementAction(assetId, IDLE, fd, store);
}

describe("confirmStatementAction (#174)", () => {
  test("creates 8 buy operations from the plantilla rows", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const digest = await run(uploadForm(CSV), store);

    expect(digest).toContain("ok=statement_loaded");
    expect(digest).toContain("created=8");
    expect(digest).toContain("skipped=0");

    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(8);
    for (const op of ops) {
      expect(op.kind).toBe("buy");
      expect(op.currency).toBe("EUR");
      expect(op.feesMinor).toBe(0);
      expect(op.occurredAt).toBeUndefined();
    }
    expect(ops.map((op) => op.executedAt).sort()).toEqual([
      "2024-02-01",
      "2024-03-01",
      "2024-04-01",
      "2024-05-01",
      "2024-06-01",
      "2024-07-01",
      "2024-08-01",
      "2024-09-01",
    ]);
  });

  test("an empty file is an error and writes nothing", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const fd = new FormData();
    fd.set("broker", "plantilla");
    fd.set("currentUrl", "/patrimonio/fund/editar");
    fd.set("file", new File([], "empty.csv", { type: "text/csv" }));

    const digest = await run(fd, store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("a malformed row aborts the whole load (nothing written)", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const bad = [
      HEADER,
      "01/02/2024;Fondo;IE00BYX5NX33;Compra;7,226;100;;",
      "99/99/2024;Fondo;IE00BYX5NX33;Compra;7,000;100;;",
    ].join("\n");

    const digest = await run(uploadForm(bad), store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });
});

describe("confirmStatementAction — merge by date (#175)", () => {
  test("re-uploading the same file overwrites every match and creates nothing", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await run(uploadForm(CSV), store);
    expect(await store.operations.readOperations("fund")).toHaveLength(8);

    const digest = await run(uploadForm(CSV), store);

    expect(digest).toContain("created=0");
    expect(digest).toContain("overwritten=8");
    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(8);
  });

  test("overwrite replaces a hand-edited operation's value for the matched date", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await store.operations.recordOperation({
      assetId: "fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      id: "op_handtyped",
      kind: "buy",
      pricePerUnit: "1",
      units: "999",
    });

    const digest = await run(uploadForm(CSV), store);

    expect(digest).toContain("created=7");
    expect(digest).toContain("overwritten=1");

    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(8);
    const march = ops.find((op) => op.executedAt === "2024-03-01")!;
    expect(march.id).toBe("op_handtyped");
    expect(march.units).toBe("7.18");
  });

  test("an operation on a date absent from the file is left untouched", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await store.operations.recordOperation({
      assetId: "fund",
      currency: "EUR",
      executedAt: "2024-01-15",
      id: "op_manual",
      kind: "buy",
      pricePerUnit: "100",
      units: "5",
    });

    await run(uploadForm(CSV), store);

    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(9);
    expect(ops.find((op) => op.id === "op_manual")).toBeDefined();
  });
});

describe("previewStatementAction — preview before confirm (#176)", () => {
  test("preview summarizes new/overwritten/skipped and writes NOTHING", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const state = await preview(uploadForm(CSV), store);

    expect(state.status).toBe("summary");
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.created).toBe(8);
    expect(state.overwritten).toBe(0);
    expect(state.skipped).toBe(0);
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
    expect(await store.snapshots.readSnapshots("household")).toHaveLength(0);
  });

  test("preview reflects overwrites against existing operations without writing", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);
    await store.operations.recordOperation({
      assetId: "fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      id: "op_existing",
      kind: "buy",
      pricePerUnit: "1",
      units: "1",
    });

    const state = await preview(uploadForm(CSV), store);

    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.created).toBe(7);
    expect(state.overwritten).toBe(1);
    expect(
      (await store.operations.readOperations("fund")).find((o) => o.id === "op_existing")!
        .units,
    ).toBe("1");
  });

  test("a parse error surfaces as an error state, not a thrown redirect", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const bad = [HEADER, "99/99/2024;Fondo;IE00BYX5NX33;Compra;7,000;100;;"].join("\n");

    const state = await preview(uploadForm(bad), store);
    expect(state.status).toBe("error");
  });

  test("confirm re-validates the file server-side (a malformed file still aborts)", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const bad = [HEADER, "99/99/2024;Fondo;IE00BYX5NX33;Compra;7,000;100;;"].join("\n");

    const digest = await run(uploadForm(bad), store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });
});

describe("statement ISIN guard + anomalies (#178)", () => {
  async function seedFundWithIsin(store: WorthlineStore, isin: string): Promise<void> {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      isin,
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo indexado",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
  }

  function csvForIsin(isin: string): string {
    return [HEADER, `01/02/2024;Fondo;${isin};Compra;7,226;100;;`].join("\n");
  }

  test("a file whose ISIN differs from the asset's blocks confirm and writes nothing", async () => {
    const store = await createInMemoryStore();
    await seedFundWithIsin(store, "LU0000000009");

    const digest = await run(uploadForm(CSV), store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("preview surfaces an ISIN mismatch as an error", async () => {
    const store = await createInMemoryStore();
    await seedFundWithIsin(store, "LU0000000009");

    const state = await preview(uploadForm(CSV), store);
    expect(state.status).toBe("error");
  });

  test("an asset with no ISIN is backfilled, and a later upload is guarded by it", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await run(uploadForm(CSV), store);
    expect((await store.assets.readInvestmentAssetById("fund"))?.isin).toBe(
      "IE00BYX5NX33",
    );

    const digest = await run(uploadForm(csvForIsin("LU0000000009")), store);
    expect(digest).toContain("error=");
  });

  test("a file containing more than one ISIN is rejected as malformed", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const mixed = [
      HEADER,
      "01/02/2024;Fondo;IE00BYX5NX33;Compra;7,226;100;;",
      "01/03/2024;Fondo;LU0000000009;Compra;7,180;100;;",
    ].join("\n");

    const digest = await run(uploadForm(mixed), store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("preview flags a same-date anomaly without overwriting the wrong row", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const dup = [
      HEADER,
      "01/02/2024;Fondo;IE00BYX5NX33;Compra;7,226;100;;",
      "01/02/2024;Fondo;IE00BYX5NX33;Compra;14,000;200;;",
      "01/03/2024;Fondo;IE00BYX5NX33;Compra;7,180;100;;",
    ].join("\n");

    const state = await preview(uploadForm(dup), store);
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.anomalies).toBe(1);
    expect(state.created).toBe(1);
  });
});

describe("statement sells (#179)", () => {
  const WITH_SELL = [
    HEADER,
    "01/02/2024;Fondo;IE00BYX5NX33;Compra;7,226;100;;",
    "01/03/2024;Fondo;IE00BYX5NX33;Venta;3;50;;",
  ].join("\n");

  test("preview calls out detected sells distinctly", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const state = await preview(uploadForm(WITH_SELL), store);
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.sells).toBe(1);
    expect(state.created).toBe(2);
  });

  test("confirm stores a sell operation with absolute units", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await run(uploadForm(WITH_SELL), store);

    const ops = await store.operations.readOperations("fund");
    const sell = ops.find((op) => op.kind === "sell");
    expect(sell).toBeDefined();
    expect(sell!.executedAt).toBe("2024-03-01");
    expect(sell!.units).toBe("3");
  });
});

/**
 * The per-holding upload is the SECOND statement door (#1401) — same plantilla, its own
 * action. It was the one path left that could still store dollars as euros, and the new
 * `Divisa` column would have made that easier rather than harder.
 */
describe("confirmStatementAction — la columna Divisa", () => {
  const USD_CSV = [
    `${HEADER};Divisa`,
    "23/01/2026;Fondo;IE00BDZVHT63;Compra;0,255;2,04;;Fidelity Pacific ex-Japan;USD",
  ].join("\n");

  const usdRates = { fetchDailyRates: async () => new Map([["2026-01-23", 0.85]]) };

  test("converts the row and keeps what the file stated", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await run(uploadForm(USD_CSV), store, "fund", usdRates);

    const [operation] = await store.operations.readOperations("fund");
    // 2,04 US$ ÷ 0,255 = 8,00 US$/ud → × 0,85 = 6,80 €/ud.
    expect(operation?.currency).toBe("EUR");
    expect(operation?.pricePerUnit).toBe("6.8");
    expect(operation?.capture).toEqual({
      currency: "USD",
      eurPerUnit: 0.85,
      feesMinor: 0,
      pricePerUnit: "8",
    });
  });

  test("writes nothing when ECB has no rate for that day", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const redirectUrl = await run(uploadForm(USD_CSV), store, "fund", {
      fetchDailyRates: async () => new Map(),
    });

    expect(decodeURIComponent(redirectUrl).replaceAll("+", " ")).toContain(
      "No hay tipo de cambio del BCE de USD",
    );
    expect(await store.operations.readOperations("fund")).toEqual([]);
  });

  test("the preview counts the converted rows, so it matches the confirm", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const state = await previewStatementAction(
      "fund",
      IDLE,
      uploadForm(USD_CSV),
      store,
      usdRates,
    );

    expect(state.status).toBe("summary");
    if (state.status !== "summary") return;
    // One row, counted — and counted from the CONVERTED figures, since the plan is
    // built after the conversion.
    expect(state.created).toBe(1);
    expect(state.skipped).toBe(0);
  });

  test("a rate outage refuses the preview instead of showing native figures", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const state = await previewStatementAction("fund", IDLE, uploadForm(USD_CSV), store, {
      fetchDailyRates: async () => new Map(),
    });

    expect(state.status).toBe("error");
  });
});
