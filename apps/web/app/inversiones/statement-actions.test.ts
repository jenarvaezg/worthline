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

import { uploadStatementAction } from "./actions";

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

function seedFund(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  store.assets.createInvestmentAsset({
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
    await uploadStatementAction(assetId, fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

describe("uploadStatementAction (#174)", () => {
  test("creates 8 buy operations from the Finalizada rows and skips the other 2", async () => {
    const store = createInMemoryStore();
    seedFund(store);

    const digest = await run(uploadForm(CSV), store);

    expect(digest).toContain("ok=statement_loaded");
    expect(digest).toContain("created=8");
    expect(digest).toContain("skipped=2");

    const ops = store.operations.readOperations("fund");
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
    const store = createInMemoryStore();
    seedFund(store);

    await run(uploadForm(CSV), store);

    const dates = store.snapshots
      .readSnapshots("household")
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
    const store = createInMemoryStore();
    seedFund(store);

    const fd = new FormData();
    fd.set("broker", "myinvestor");
    fd.set("currentUrl", "/patrimonio/fund/editar");
    fd.set("file", new File([], "empty.csv", { type: "text/csv" }));

    const digest = await run(fd, store);
    expect(digest).toContain("error=");
    expect(store.operations.readOperations("fund")).toHaveLength(0);
  });

  test("a malformed Finalizada row aborts the whole load (nothing written)", async () => {
    const store = createInMemoryStore();
    seedFund(store);

    const bad = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/02/2024;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "99/99/2024;IE00BYX5NX33;100 EUR;7,000;Finalizada",
    ].join("\n");

    const digest = await run(uploadForm(bad), store);
    expect(digest).toContain("error=");
    expect(store.operations.readOperations("fund")).toHaveLength(0);
  });
});
