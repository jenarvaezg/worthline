import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import {
  buildStatementImportPlan,
  isProviderSymbolShaped,
  resolveStatementImportBuckets,
} from "./statement-import-plan";
import { parseStatement } from "./statement-parse";

const MULTI_ISIN_FIXTURE = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "05/01/2026;Fondo;ES00WL000001;Compra;34,2857;1200;;",
  "05/02/2026;Fondo;ES00WL000001;Compra;33,9120;1200;;",
  "10/01/2026;Fondo;LU00WL000002;Compra;12,3456;600;;",
  "10/02/2026;Fondo;LU00WL000002;Compra;12,4011;600;;",
  "15/01/2026;Fondo;IE00WL000003;Compra;21,0000;900;;",
  "15/02/2026;Fondo;IE00WL000003;Compra;20,7500;900;;",
].join("\r\n");

function parsedMultiIsin() {
  const result = parseStatement(MULTI_ISIN_FIXTURE, "plantilla");
  if (!result.ok) throw new Error(result.errors.join(" | "));
  return result.value;
}

function op(id: string, assetId: string, executedAt: string): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: "1",
    units: "1",
  };
}

describe("multi-ISIN statement import plan (ADR 0055)", () => {
  test("groups a synthetic broker file by ISIN, resolves matched/new buckets, and honors include/ignore decisions", () => {
    const statement = parsedMultiIsin();

    expect(statement.isins).toEqual(["ES00WL000001", "LU00WL000002", "IE00WL000003"]);

    const buckets = resolveStatementImportBuckets(statement, [
      {
        assetId: "asset_existing",
        isin: "ES00WL000001",
        name: "Fondo existente",
        operations: [op("op_existing", "asset_existing", "2026-01-05")],
      },
    ]);

    expect(
      buckets.map((bucket) => ({
        bucket: bucket.bucket,
        isin: bucket.isin,
        rows: bucket.rows.length,
        skipped: bucket.skipped.length,
      })),
    ).toEqual([
      { bucket: "matched", isin: "ES00WL000001", rows: 2, skipped: 0 },
      { bucket: "new", isin: "LU00WL000002", rows: 2, skipped: 0 },
      { bucket: "new", isin: "IE00WL000003", rows: 2, skipped: 0 },
    ]);
    const matched = buckets[0];
    expect(matched?.bucket).toBe("matched");
    if (matched?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(matched.mergePlan.toOverwrite.map((row) => row.operationId)).toEqual([
      "op_existing",
    ]);
    expect(matched.mergePlan.toCreate.map((row) => row.dateKey)).toEqual(["2026-02-05"]);

    const plan = buildStatementImportPlan(buckets, [
      { action: "include", isin: "ES00WL000001" },
      {
        action: "include",
        creation: {
          assetId: "asset_lu",
          currency: "EUR",
          name: "Fondo Brújula FAKE",
          ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          providerSymbol: "BRUJULA.FAKE",
        },
        isin: "LU00WL000002",
      },
      { action: "ignore", isin: "IE00WL000003" },
    ]);

    expect(plan.included.map((fund) => [fund.kind, fund.isin])).toEqual([
      ["matched", "ES00WL000001"],
      ["new", "LU00WL000002"],
    ]);
    expect(plan.ignored.map((fund) => fund.isin)).toEqual(["IE00WL000003"]);
  });

  test("a re-upload resolves a previously-created ISIN as matched and creates no duplicate operation dates", () => {
    const statement = parsedMultiIsin();

    const buckets = resolveStatementImportBuckets(statement, [
      {
        assetId: "asset_lu",
        isin: "LU00WL000002",
        name: "Fondo Brújula FAKE",
        operations: [
          op("op_lu_jan", "asset_lu", "2026-01-10"),
          op("op_lu_feb", "asset_lu", "2026-02-10"),
        ],
      },
    ]);

    const lu = buckets.find((bucket) => bucket.isin === "LU00WL000002");
    expect(lu?.bucket).toBe("matched");
    if (lu?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(lu.mergePlan.toCreate).toEqual([]);
    expect(lu.mergePlan.toOverwrite.map((row) => row.operationId).sort()).toEqual([
      "op_lu_feb",
      "op_lu_jan",
    ]);
  });
});

describe("isProviderSymbolShaped — what may be stamped as a provider symbol (#1330)", () => {
  test("accepts tickers, CoinGecko ids and fund codes", () => {
    for (const identifier of [
      "VUSA.L",
      "SPOG.L",
      "bitcoin",
      "N5572-myinvestor",
      "N5394",
    ]) {
      expect(isProviderSymbolShaped(identifier)).toBe(true);
    }
  });

  test("rejects a fund name — whitespace or over 20 characters is not a symbol", () => {
    for (const identifier of [
      "Vanguard US Equity Index Fund EUR Hedged",
      "Cartera Indexada Metal",
      "FondoConNombreLarguisimoSinEspacios",
      "",
      "   ",
      "Fondo/Plan (2024)",
    ]) {
      expect(isProviderSymbolShaped(identifier)).toBe(false);
    }
  });

  test("trims surrounding whitespace before judging", () => {
    expect(isProviderSymbolShaped("  VUSA.L  ")).toBe(true);
  });
});
