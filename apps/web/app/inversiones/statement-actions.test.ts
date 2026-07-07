/**
 * Integration test for the statement upload action (ADR 0018, #174) via the
 * `_store` injection seam. The action is scoped to the route asset id (no scope
 * cookie / next/headers dependency), so it runs fully here: parse the uploaded
 * MyInvestor CSV → create operations → one batched ripple → redirect with a
 * summary. Prior art: ajustes/numista-actions.test.ts.
 */
import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  confirmStatementAction,
  previewStatementAction,
  type StatementPreviewState,
} from "./actions";

const IDLE: StatementPreviewState = { status: "idle" };

// 2024 dates so every order is unambiguously in the past regardless of wall
// clock, making the generated snapshot band deterministic. Eight `Finalizada`
// rows load as buys; one `En curso` and one `Rechazada` are skipped.
const CSV = [
  "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
  "01/02/2024;IE00BYX5NX33;100 EUR;7,226;Finalizada",
  "01/03/2024;IE00BYX5NX33;100 EUR;7,180;Finalizada",
  "01/04/2024;IE00BYX5NX33;100 EUR;7,050;Finalizada",
  "01/05/2024;IE00BYX5NX33;559 EUR;39,120;Finalizada",
  "01/06/2024;IE00BYX5NX33;100 EUR;6,900;Finalizada",
  "01/07/2024;IE00BYX5NX33;100 EUR;6,800;Finalizada",
  "01/08/2024;IE00BYX5NX33;100 EUR;6,700;Finalizada",
  "01/09/2024;IE00BYX5NX33;1418.15 EUR;95,400;Finalizada",
  "01/10/2024;IE00BYX5NX33;100 EUR;6,500;En curso",
  "01/11/2024;IE00BYX5NX33;100 EUR;6,400;Rechazada",
].join("\n");

function uploadForm(csv: string, broker = "myinvestor"): FormData {
  const fd = new FormData();
  fd.set("broker", broker);
  fd.set("currentUrl", "/patrimonio/fund/editar");
  fd.set("file", new File([csv], "ordenes.csv", { type: "text/csv" }));
  return fd;
}

function noSalesForm(csv: string, broker = "myinvestor"): FormData {
  const fd = uploadForm(csv, broker);
  fd.set("confirmNoSalesOrRedemptions", "on");
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
): Promise<string> {
  try {
    await confirmStatementAction(assetId, fd, store);
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
  test("rejects a reduced MyInvestor export unless the user confirms there were no sells", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const digest = await run(uploadForm(CSV), store);

    expect(digest).toContain("error=");
    expect(digest).toContain("Este+archivo+no+distingue+compras+de+ventas");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("creates 8 buy operations from the Finalizada rows and skips the other 2", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const digest = await run(noSalesForm(CSV), store);

    expect(digest).toContain("ok=statement_loaded");
    expect(digest).toContain("created=8");
    expect(digest).toContain("skipped=2");

    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(8);
    for (const op of ops) {
      expect(op.kind).toBe("buy");
      expect(op.currency).toBe("EUR");
      expect(op.feesMinor).toBe(0);
    }
    // Dates map to the eight Finalizada rows.
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

  test("the load triggers one snapshot per operation date (single batched ripple)", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await run(noSalesForm(CSV), store);

    const dates = (await store.snapshots.readSnapshots("household"))
      .map((s) => s.dateKey)
      .sort();
    expect(dates).toEqual([
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
    fd.set("broker", "myinvestor");
    fd.set("currentUrl", "/patrimonio/fund/editar");
    fd.set("file", new File([], "empty.csv", { type: "text/csv" }));

    const digest = await run(fd, store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("a malformed Finalizada row aborts the whole load (nothing written)", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const bad = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/02/2024;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "99/99/2024;IE00BYX5NX33;100 EUR;7,000;Finalizada",
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

    await run(noSalesForm(CSV), store);
    expect(await store.operations.readOperations("fund")).toHaveLength(8);

    // The second identical load overwrites all 8 by date — no duplicates.
    const digest = await run(noSalesForm(CSV), store);

    expect(digest).toContain("created=0");
    expect(digest).toContain("overwritten=8");
    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(8);
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

  test("overwrite replaces a hand-edited operation's value for the matched date", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    // A hand-typed approximation on a date the file also covers (01/03/2024).
    await store.operations.recordOperation({
      assetId: "fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      id: "op_handtyped",
      kind: "buy",
      pricePerUnit: "1",
      units: "999",
    });

    const digest = await run(noSalesForm(CSV), store);

    // 7 created (the other Finalizada dates) + the 01/03 match overwritten.
    expect(digest).toContain("created=7");
    expect(digest).toContain("overwritten=1");

    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(8);
    const march = ops.find((op) => op.executedAt === "2024-03-01")!;
    // The id is the match key and survives; the value is the file's, not 999.
    expect(march.id).toBe("op_handtyped");
    expect(march.units).toBe("7.18");
  });

  test("an operation on a date absent from the file is left untouched", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    // An operation the broker file never mentions (15/01/2024).
    await store.operations.recordOperation({
      assetId: "fund",
      currency: "EUR",
      executedAt: "2024-01-15",
      id: "op_manual",
      kind: "buy",
      pricePerUnit: "100",
      units: "5",
    });

    await run(noSalesForm(CSV), store);

    const ops = await store.operations.readOperations("fund");
    // 8 from the file + the 1 untouched manual operation = 9, none deleted.
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
    expect(state.skipped).toBe(2);
    // The whole point of a preview: no operations and no snapshots are written.
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
    // Still untouched: the preview did not apply the overwrite.
    expect(
      (await store.operations.readOperations("fund")).find((o) => o.id === "op_existing")!
        .units,
    ).toBe("1");
  });

  test("a parse error surfaces as an error state, not a thrown redirect", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const bad = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "99/99/2024;IE00BYX5NX33;100 EUR;7,000;Finalizada",
    ].join("\n");

    const state = await preview(uploadForm(bad), store);
    expect(state.status).toBe("error");
  });

  test("confirm re-validates the file server-side (a malformed file still aborts)", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const bad = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "99/99/2024;IE00BYX5NX33;100 EUR;7,000;Finalizada",
    ].join("\n");

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
    return [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      `01/02/2024;${isin};100 EUR;7,226;Finalizada`,
    ].join("\n");
  }

  test("a file whose ISIN differs from the asset's blocks confirm and writes nothing", async () => {
    const store = await createInMemoryStore();
    await seedFundWithIsin(store, "LU0000000000");

    // CSV carries IE00BYX5NX33 — a different fund.
    const digest = await run(noSalesForm(CSV), store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("preview surfaces an ISIN mismatch as an error", async () => {
    const store = await createInMemoryStore();
    await seedFundWithIsin(store, "LU0000000000");

    const state = await preview(uploadForm(CSV), store);
    expect(state.status).toBe("error");
  });

  test("an asset with no ISIN is backfilled, and a later upload is guarded by it", async () => {
    const store = await createInMemoryStore();
    await seedFund(store); // no ISIN

    await run(noSalesForm(CSV), store);
    // The asset's ISIN is now the file's.
    expect((await store.assets.readInvestmentAssetById("fund"))?.isin).toBe(
      "IE00BYX5NX33",
    );

    // A subsequent upload of a DIFFERENT ISIN is now blocked by the backfill.
    const digest = await run(noSalesForm(csvForIsin("LU0000000000")), store);
    expect(digest).toContain("error=");
  });

  test("a file containing more than one ISIN is rejected as malformed", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const mixed = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/02/2024;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "01/03/2024;LU0000000000;100 EUR;7,180;Finalizada",
    ].join("\n");

    const digest = await run(uploadForm(mixed), store);
    expect(digest).toContain("error=");
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("preview flags a same-date anomaly without overwriting the wrong row", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    // The file repeats 01/02/2024 — ambiguous, so it is flagged, not created.
    const dup = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/02/2024;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "01/02/2024;IE00BYX5NX33;200 EUR;14,000;Finalizada",
      "01/03/2024;IE00BYX5NX33;100 EUR;7,180;Finalizada",
    ].join("\n");

    const state = await preview(uploadForm(dup), store);
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.anomalies).toBe(1);
    expect(state.created).toBe(1); // only 01/03 is unambiguous
  });
});

describe("statement sells (#179)", () => {
  const WITH_SELL = [
    "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
    "01/02/2024;IE00BYX5NX33;100 EUR;7,226;Finalizada",
    "01/03/2024;IE00BYX5NX33;-50 EUR;3,000;Finalizada",
  ].join("\n");
  const WITH_SELL_FULL = [
    "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado;Tipo de operación",
    "01/02/2024;IE00BYX5NX33;100 EUR;7,226;Finalizada;Suscripción Fondos de Inversión",
    "01/03/2024;IE00BYX5NX33;50 EUR;3,000;Finalizada;Reembolso Fondos de Inversión",
  ].join("\n");

  test("preview calls out detected sells distinctly", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const state = await preview(uploadForm(WITH_SELL), store);
    if (state.status !== "summary") throw new Error("expected summary");
    expect(state.sells).toBe(1);
    expect(state.created).toBe(2);
  });

  test("confirm stores a sell operation (negative row) with absolute units", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await run(uploadForm(WITH_SELL_FULL), store);

    const ops = await store.operations.readOperations("fund");
    const sell = ops.find((op) => op.kind === "sell");
    expect(sell).toBeDefined();
    expect(sell!.executedAt).toBe("2024-03-01");
    expect(sell!.units).toBe("3"); // absolute, trailing-zero noise collapsed
  });
});
