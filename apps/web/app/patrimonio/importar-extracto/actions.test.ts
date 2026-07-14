/**
 * Integration tests for the multi-fund statement import page (PRD #669 S2,
 * #673, ADR 0055) via the `_store` injection seam. Mirrors
 * `inversiones/statement-actions.test.ts` (#176) and
 * `packages/db/tests/statement-import.persistence.test.ts` (the S1 seam this
 * builds on).
 */
import { readFileSync } from "node:fs";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { parseStatement } from "@worthline/domain";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import {
  confirmImportStatementAction,
  type FundPreviewRow,
  type ImportStatementPreviewState,
  type IsinLookupResult,
  type IsinSymbolResolver,
  previewImportStatementAction,
} from "./actions";

const IDLE: ImportStatementPreviewState = { status: "idle" };

// Plantilla shape (ADR 0055): `;`-delimited, dd/mm/yyyy, comma-decimal units,
// positive amounts, explicit Compra/Venta. Four ISINs: one matches an existing
// holding, three are new — one resolvable, one not, all rows load.
const MULTI_ISIN_CSV = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "05/01/2024;Fondo;ES00WL000001;Compra;34,2857;1200;;",
  "05/02/2024;Fondo;ES00WL000001;Compra;33,9120;1200;;",
  "10/01/2024;Fondo;LU00WL000002;Compra;12,3456;600;;",
  "10/02/2024;Fondo;LU00WL000002;Compra;12,4011;600;;",
  "15/01/2024;Fondo;IE00WL000003;Compra;21,0000;900;;",
  "15/02/2024;Fondo;IE00WL000003;Compra;20,7500;900;;",
  "20/01/2024;Fondo;FR00WL000004;Compra;6,0000;300;;",
].join("\r\n");

function uploadForm(csv = MULTI_ISIN_CSV): FormData {
  const fd = new FormData();
  fd.set("broker", "plantilla");
  fd.set("currentUrl", "/patrimonio/importar-extracto");
  fd.set("file", new File([csv], "plantilla.csv", { type: "text/csv" }));
  return fd;
}

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "matched_fund",
    isin: "ES00WL000001",
    liquidityTier: "market",
    manualPricePerUnit: "35",
    name: "Fondo existente",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

function fakeResolver(results: Record<string, IsinLookupResult>): IsinSymbolResolver {
  return async (isin) => results[isin] ?? { status: "not_found" };
}

function preview(
  fd: FormData,
  store: WorthlineStore,
  resolver?: IsinSymbolResolver,
): Promise<ImportStatementPreviewState> {
  return previewImportStatementAction(IDLE, fd, store, resolver);
}

async function confirm(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await confirmImportStatementAction(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

function newRow(
  preview: ImportStatementPreviewState,
  isin: string,
): FundPreviewRow & {
  bucket: "new";
} {
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  const fund = preview.funds.find((f) => f.isin === isin);
  if (fund?.bucket !== "new") throw new Error(`expected a new bucket for ${isin}`);
  return fund;
}

function matchedRow(
  preview: ImportStatementPreviewState,
  isin: string,
): FundPreviewRow & {
  bucket: "matched";
} {
  if (preview.status !== "ready") throw new Error("expected a ready preview");
  const fund = preview.funds.find((f) => f.isin === isin);
  if (fund?.bucket !== "matched")
    throw new Error(`expected a matched bucket for ${isin}`);
  return fund;
}

describe("previewImportStatementAction (#673)", () => {
  test("groups the file by ISIN into matched/new buckets with per-fund counts", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const result = await preview(uploadForm(), store);

    if (result.status !== "ready") throw new Error("expected a ready preview");
    expect(
      result.funds.map((fund) => ({
        bucket: fund.bucket,
        executedCount: fund.executedCount,
        isin: fund.isin,
        skippedCount: fund.skippedCount,
      })),
    ).toEqual([
      { bucket: "matched", executedCount: 2, isin: "ES00WL000001", skippedCount: 0 },
      { bucket: "new", executedCount: 2, isin: "LU00WL000002", skippedCount: 0 },
      { bucket: "new", executedCount: 2, isin: "IE00WL000003", skippedCount: 0 },
      { bucket: "new", executedCount: 1, isin: "FR00WL000004", skippedCount: 0 },
    ]);

    const matched = result.funds[0];
    if (matched?.bucket !== "matched") throw new Error("expected the matched bucket");
    // No operations pre-recorded on the seeded holding, so both dates create.
    expect(matched.toCreateCount).toBe(2);
    expect(matched.toOverwriteCount).toBe(0);
    expect(matched.existingName).toBe("Fondo existente");
  });

  test("prefill states: found, not_found, and error via the fake resolver", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const resolver = fakeResolver({
      IE00WL000003: { status: "error" },
      LU00WL000002: {
        name: "Fondo Brújula",
        provider: "yahoo",
        status: "found",
        symbol: "BRUJULA.FAKE",
      },
      // FR00WL000004 intentionally omitted -> not_found
    });

    const result = await preview(uploadForm(), store, resolver);

    expect(newRow(result, "LU00WL000002").lookup).toEqual({
      name: "Fondo Brújula",
      provider: "yahoo",
      status: "found",
      symbol: "BRUJULA.FAKE",
    });
    expect(newRow(result, "IE00WL000003").lookup).toEqual({ status: "error" });
    expect(newRow(result, "FR00WL000004").lookup).toEqual({ status: "not_found" });
  });

  test("does not write anything", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await preview(uploadForm(), store);

    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(1);
    expect(await store.operations.readOperations("matched_fund")).toHaveLength(0);
  });

  test("an unparsable file surfaces as an error state, not a thrown redirect", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const fd = new FormData();
    fd.set("broker", "plantilla");
    fd.set("file", new File(["not,a,valid,header"], "bad.csv", { type: "text/csv" }));

    const result = await preview(fd, store);
    expect(result.status).toBe("error");
  });

  test("matched preview shows position before and after the simulated merge", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.operations.recordOperation({
      assetId: "matched_fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      id: "opening",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    const result = await preview(
      plantillaForm(
        [
          "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Nombre",
          "01/01/2024;Fondo;ES00WL000001;Compra;10;1000;",
        ].join("\r\n"),
      ),
      store,
    );

    expect(matchedRow(result, "ES00WL000001").positionImpact).toEqual({
      afterUnits: "20",
      afterValueMinor: 2000_00,
      beforeUnits: "10",
      beforeValueMinor: 1000_00,
      flags: ["nearly_doubles"],
    });
  });

  test("matched preview flags oversell and a resulting zero position", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.operations.recordOperation({
      assetId: "matched_fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      id: "opening",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    const result = await preview(
      plantillaForm(
        [
          "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Nombre",
          "01/04/2024;Fondo;ES00WL000001;Venta;12;1200;",
        ].join("\r\n"),
      ),
      store,
    );

    expect(matchedRow(result, "ES00WL000001").positionImpact).toMatchObject({
      afterUnits: "0",
      afterValueMinor: 0,
      flags: ["oversell", "near_zero"],
    });
  });

  test("matched preview replaces a source=opening operation by default", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.operations.recordOperation({
      assetId: "matched_fund",
      currency: "EUR",
      executedAt: "2026-06-15",
      id: "opening",
      kind: "buy",
      pricePerUnit: "100",
      source: "opening",
      units: "10",
    });

    const fd = plantillaForm(
      [
        "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Nombre",
        "01/01/2024;Fondo;ES00WL000001;Compra;10;1000;",
      ].join("\r\n"),
    );
    const result = await preview(fd, store);

    const matched = matchedRow(result, "ES00WL000001");
    expect(matched.toCreateCount).toBe(1);
    expect(matched.toDeleteCount).toBe(1);
    expect(matched.positionImpact).toMatchObject({
      afterUnits: "10",
      beforeUnits: "10",
      flags: [],
    });

    fd.set("include_ES00WL000001", "on");
    await confirm(fd, store);

    expect(await store.operations.readOperations("matched_fund")).toMatchObject([
      { executedAt: "2024-01-01", source: "statement", units: "10" },
    ]);
  });

  test("confirm can opt out of replacing a source=opening operation", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.operations.recordOperation({
      assetId: "matched_fund",
      currency: "EUR",
      executedAt: "2026-06-15",
      id: "opening",
      kind: "buy",
      pricePerUnit: "100",
      source: "opening",
      units: "10",
    });

    const fd = plantillaForm(
      [
        "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Nombre",
        "01/01/2024;Fondo;ES00WL000001;Compra;10;1000;",
      ].join("\r\n"),
    );
    fd.set("include_ES00WL000001", "on");
    fd.set("replaceOpeningSeen_ES00WL000001", "on");

    await confirm(fd, store);

    expect(await store.operations.readOperations("matched_fund")).toMatchObject([
      { executedAt: "2024-01-01", source: "statement" },
      { id: "opening", source: "opening" },
    ]);
  });
});

describe("confirmImportStatementAction — all-or-nothing (#673)", () => {
  test("applies only the included funds; the excluded fund is untouched", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const fd = uploadForm();
    fd.set("include_ES00WL000001", "on");
    fd.set("include_LU00WL000002", "on");
    fd.set("name_LU00WL000002", "Fondo Brújula");
    fd.set("symbol_LU00WL000002", "BRUJULA.FAKE");
    // IE00WL000003 and FR00WL000004 left unchecked -> excluded.

    const digest = await confirm(fd, store);
    expect(digest).toContain("ok=statement_import_loaded");
    expect(digest).toContain("funds=2");
    expect(digest).toContain("created=1");

    const matchedOps = await store.operations.readOperations("matched_fund");
    expect(matchedOps).toHaveLength(2);
    expect(matchedOps.every((operation) => operation.occurredAt === undefined)).toBe(
      true,
    );

    const metas = await store.assets.readInvestmentAssetsWithMeta();
    const created = metas.find((meta) => meta.isin === "LU00WL000002");
    expect(created).toBeDefined();
    expect(created?.providerSymbol).toBe("BRUJULA.FAKE");
    expect(await store.operations.readOperations(created!.id)).toHaveLength(2);

    // The excluded ISINs never got a holding created — an untouched fund.
    expect(metas.some((meta) => meta.isin === "IE00WL000003")).toBe(false);
    expect(metas.some((meta) => meta.isin === "FR00WL000004")).toBe(false);
    expect(metas).toHaveLength(2); // the seeded one + the one new inclusion
  });

  test("an included new fund with a blank name/symbol still creates (empty allowed)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const fd = uploadForm();
    fd.set("include_FR00WL000004", "on");
    // name/symbol left blank.

    await confirm(fd, store);

    const metas = await store.assets.readInvestmentAssetsWithMeta();
    const created = metas.find((meta) => meta.isin === "FR00WL000004");
    expect(created).toBeDefined();
    expect(created?.name).toBe("FR00WL000004"); // falls back to the ISIN
    expect(created?.providerSymbol).toBeUndefined();
  });

  test("re-confirming the same file is a no-op on the already-included funds", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const fd = () => {
      const form = uploadForm();
      form.set("include_ES00WL000001", "on");
      form.set("include_LU00WL000002", "on");
      form.set("symbol_LU00WL000002", "BRUJULA.FAKE");
      return form;
    };

    await confirm(fd(), store);
    await confirm(fd(), store);

    const metas = await store.assets.readInvestmentAssetsWithMeta();
    expect(metas).toHaveLength(2); // no duplicate holding created on re-confirm
    const created = metas.find((meta) => meta.isin === "LU00WL000002");
    expect(await store.operations.readOperations(created!.id)).toHaveLength(2);
    expect(await store.operations.readOperations("matched_fund")).toHaveLength(2);
  });

  test("a malformed file aborts before any write", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const fd = new FormData();
    fd.set("broker", "plantilla");
    fd.set("file", new File(["not,a,valid,header"], "bad.csv", { type: "text/csv" }));

    const digest = await confirm(fd, store);
    expect(digest).toContain("error=");
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(1);
  });
});

// ── Plantilla (#695) ─────────────────────────────────────────────────────────

const PLANTILLA_CSV = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "01/02/2024;Fondo;LU00WL000002;Compra;10;500;;Fondo Plantilla",
  "05/02/2024;Fondo;LU00WL000002;Venta;4;220;;",
  "03/02/2024;Cripto;bitcoin;Compra;0,01;500;;Bitcoin",
].join("\r\n");

function plantillaForm(csv = PLANTILLA_CSV): FormData {
  const fd = new FormData();
  fd.set("broker", "plantilla");
  fd.set("currentUrl", "/patrimonio/importar-extracto");
  fd.set("file", new File([csv], "plantilla.csv", { type: "text/csv" }));
  return fd;
}

describe("plantilla import (#695)", () => {
  test("mixes asset types: crypto matches an existing holding by providerSymbol, sells load as sells", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "btc_holding",
      instrument: "crypto",
      liquidityTier: "market",
      name: "Bitcoin",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      priceProvider: "coingecko",
      providerSymbol: "bitcoin",
    });

    const result = await preview(plantillaForm(), store);
    if (result.status !== "ready") throw new Error("expected a ready preview");
    const fund = newRow(result, "LU00WL000002");
    // The row's own Nombre backs the (not-found) lookup; an ISIN-shaped
    // identifier suggests no symbol.
    expect(fund.suggestedName).toBe("Fondo Plantilla");
    expect(fund.suggestedSymbol).toBe("");

    const btc = result.funds.find((row) => row.isin === "bitcoin");
    expect(btc?.bucket).toBe("matched");

    // Confirm: the new fund is created WITH its declared instrument and ISIN;
    // the crypto rows merge into the existing holding, no duplicate.
    const fd = plantillaForm();
    fd.set("include_LU00WL000002", "on");
    fd.set("name_LU00WL000002", "Fondo Plantilla");
    fd.set("include_bitcoin", "on");
    await confirm(fd, store);

    const metas = await store.assets.readInvestmentAssetsWithMeta();
    expect(metas).toHaveLength(3);
    const created = metas.find((meta) => meta.isin === "LU00WL000002");
    expect(created).toBeDefined();
    const ops = await store.operations.readOperations(created!.id);
    expect(ops.map((op) => op.kind).sort()).toEqual(["buy", "sell"]);
    expect(await store.operations.readOperations("btc_holding")).toHaveLength(1);
  });

  test("preview amount nets buys and sells", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const result = await preview(plantillaForm(), store);
    if (result.status !== "ready") throw new Error("expected a ready preview");

    expect(newRow(result, "LU00WL000002").amountMinor).toBe(280_00);
  });

  test("a crypto identifier that creates suggests itself as the provider symbol", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const result = await preview(plantillaForm(), store);
    if (result.status !== "ready") throw new Error("expected a ready preview");

    const btc = newRow(result, "bitcoin");
    expect(btc.suggestedSymbol).toBe("bitcoin");
    expect(btc.suggestedName).toBe("Bitcoin");
  });

  test("one identifier with two asset types aborts preview and confirm", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const mixed = [
      "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe",
      "01/02/2024;Fondo;LU00WL000002;Compra;10;500",
      "02/02/2024;ETF;LU00WL000002;Compra;1;50",
    ].join("\r\n");

    const result = await preview(plantillaForm(mixed), store);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.message).toContain("dos tipos de activo");

    const digest = await confirm(plantillaForm(mixed), store);
    expect(digest).toContain("error=");
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(1);
  });

  test("the downloadable template itself parses clean, BOM included", async () => {
    const template = readFileSync(
      new URL("../../../public/plantilla-operaciones.csv", import.meta.url),
      "utf8",
    );
    const parsed = parseStatement(template, "plantilla");

    if (!parsed.ok) throw new Error(parsed.errors.join(" | "));
    expect(parsed.value.rows.length).toBeGreaterThanOrEqual(7);
    expect(parsed.value.rows.some((row) => row.kind === "sell")).toBe(true);
    expect(parsed.value.directionResolved).toBe(true);
  });

  test("an .xlsx plantilla travels through the same form path", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    // A one-row workbook: enough to prove the bytes→text branch feeds the parser.
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Fecha</t></is></c><c r="B1" t="inlineStr"><is><t>Tipo de activo</t></is></c><c r="C1" t="inlineStr"><is><t>Identificador</t></is></c><c r="D1" t="inlineStr"><is><t>Operación</t></is></c><c r="E1" t="inlineStr"><is><t>Participaciones</t></is></c><c r="F1" t="inlineStr"><is><t>Importe</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>01/02/2024</t></is></c><c r="B2" t="inlineStr"><is><t>Fondo</t></is></c><c r="C2" t="inlineStr"><is><t>LU00WL000002</t></is></c><c r="D2" t="inlineStr"><is><t>Venta</t></is></c><c r="E2"><v>4</v></c><c r="F2"><v>220</v></c></row>
</sheetData></worksheet>`;
    const xlsx = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) });

    const fd = new FormData();
    fd.set("broker", "plantilla");
    fd.set("currentUrl", "/patrimonio/importar-extracto");
    fd.set(
      "file",
      new File([xlsx.buffer as ArrayBuffer], "plantilla.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    const result = await preview(fd, store);
    if (result.status !== "ready") throw new Error("expected a ready preview");
    expect(newRow(result, "LU00WL000002").executedCount).toBe(1);
  });
});
