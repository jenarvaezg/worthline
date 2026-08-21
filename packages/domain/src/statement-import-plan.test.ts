import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import {
  buildStatementImportPlan,
  findUnresolvedStatementChoice,
  resolveStatementImportBuckets,
} from "./statement-import-plan";
import { parseStatement } from "./statement-parse";

const MULTI_ISIN_FIXTURE = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "05/01/2026;Fondo;ES00WL000009;Compra;34,2857;1200;;",
  "05/02/2026;Fondo;ES00WL000009;Compra;33,9120;1200;;",
  "10/01/2026;Fondo;LU00WL000022;Compra;12,3456;600;;",
  "10/02/2026;Fondo;LU00WL000022;Compra;12,4011;600;;",
  "15/01/2026;Fondo;IE00WL000001;Compra;21,0000;900;;",
  "15/02/2026;Fondo;IE00WL000001;Compra;20,7500;900;;",
].join("\r\n");

function parsedMultiIsin() {
  const result = parseStatement(MULTI_ISIN_FIXTURE, "plantilla");
  if (!result.ok) throw new Error(result.errors.join(" | "));
  return result.value;
}

function op(
  id: string,
  assetId: string,
  executedAt: string,
  overrides: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: "1",
    units: "1",
    ...overrides,
  };
}

describe("multi-ISIN statement import plan (ADR 0055)", () => {
  test("groups a synthetic broker file by ISIN, resolves matched/new buckets, and honors include/ignore decisions", () => {
    const statement = parsedMultiIsin();

    expect(statement.isins).toEqual(["ES00WL000009", "LU00WL000022", "IE00WL000001"]);

    const buckets = resolveStatementImportBuckets(statement, [
      {
        assetId: "asset_existing",
        isin: "ES00WL000009",
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
      { bucket: "matched", isin: "ES00WL000009", rows: 2, skipped: 0 },
      { bucket: "new", isin: "LU00WL000022", rows: 2, skipped: 0 },
      { bucket: "new", isin: "IE00WL000001", rows: 2, skipped: 0 },
    ]);
    const matched = buckets[0];
    expect(matched?.bucket).toBe("matched");
    if (matched?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(matched.mergePlan.toOverwrite.map((row) => row.operationId)).toEqual([
      "op_existing",
    ]);
    expect(matched.mergePlan.toCreate.map((row) => row.dateKey)).toEqual(["2026-02-05"]);

    const plan = buildStatementImportPlan(buckets, [
      { action: "include", isin: "ES00WL000009" },
      {
        action: "include",
        creation: {
          assetId: "asset_lu",
          currency: "EUR",
          name: "Fondo Brújula FAKE",
          ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          providerSymbol: "BRUJULA.FAKE",
        },
        isin: "LU00WL000022",
      },
      { action: "ignore", isin: "IE00WL000001" },
    ]);

    expect(plan.included.map((fund) => [fund.kind, fund.isin])).toEqual([
      ["matched", "ES00WL000009"],
      ["new", "LU00WL000022"],
    ]);
    expect(plan.ignored.map((fund) => fund.isin)).toEqual(["IE00WL000001"]);
  });

  test("a re-upload resolves a previously-created ISIN as matched and creates no duplicate operation dates", () => {
    const statement = parsedMultiIsin();

    const buckets = resolveStatementImportBuckets(statement, [
      {
        assetId: "asset_lu",
        isin: "LU00WL000022",
        name: "Fondo Brújula FAKE",
        operations: [
          op("op_lu_jan", "asset_lu", "2026-01-10"),
          op("op_lu_feb", "asset_lu", "2026-02-10"),
        ],
      },
    ]);

    const lu = buckets.find((bucket) => bucket.isin === "LU00WL000022");
    expect(lu?.bucket).toBe("matched");
    if (lu?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(lu.mergePlan.toCreate).toEqual([]);
    expect(lu.mergePlan.toOverwrite.map((row) => row.operationId).sort()).toEqual([
      "op_lu_feb",
      "op_lu_jan",
    ]);
  });
});

describe("an identifier claimed by two investments (#1366)", () => {
  /**
   * The father's real portfolio: the same fund at two brokers — an old, fully-sold
   * position (created first) and the live one. The file cannot say which is which,
   * so the router must not pick by creation order (#1331's fix, on this surface).
   */
  const claimants = () => [
    {
      assetId: "asset_closed",
      isin: "ES00WL000009",
      name: "Fondo viejo (bróker antiguo)",
      operations: [
        op("op_closed_opening", "asset_closed", "2025-12-01", {
          source: "opening",
          units: "10",
        }),
        op("op_closed_sell", "asset_closed", "2026-03-05", {
          kind: "sell" as const,
          units: "10",
        }),
      ],
    },
    {
      assetId: "asset_live",
      isin: "ES00WL000009",
      name: "Fondo vivo (bróker actual)",
      operations: [op("op_live", "asset_live", "2026-02-05", { units: "5" })],
    },
  ];

  test("does not resolve itself: the bucket carries every claimant, live before closed", () => {
    const [bucket] = resolveStatementImportBuckets(parsedMultiIsin(), claimants());

    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.ambiguous).toBe(true);
    expect(bucket.claimants.map((claimant) => claimant.assetId)).toEqual([
      "asset_live",
      "asset_closed",
    ]);
    expect(bucket.claimants.map((claimant) => claimant.closed)).toEqual([false, true]);
  });

  test("including it without naming a holding is refused, never resolved by order", () => {
    const buckets = resolveStatementImportBuckets(parsedMultiIsin(), claimants());
    const selections = [
      { action: "include", isin: "ES00WL000009" } as const,
      { action: "ignore", isin: "LU00WL000022" } as const,
      { action: "ignore", isin: "IE00WL000001" } as const,
    ];

    expect(findUnresolvedStatementChoice(buckets, selections)).toBe("ES00WL000009");
    expect(() => buildStatementImportPlan(buckets, selections)).toThrow(/ES00WL000009/);
  });

  test("an assetId no claimant carries is refused too — a stale preview never writes", () => {
    const buckets = resolveStatementImportBuckets(parsedMultiIsin(), claimants());

    expect(
      findUnresolvedStatementChoice(buckets, [
        { action: "include", assetId: "asset_gone", isin: "ES00WL000009" },
      ]),
    ).toBe("ES00WL000009");
  });

  test("the chosen holding is the only one written: the other's operations survive", () => {
    const buckets = resolveStatementImportBuckets(parsedMultiIsin(), claimants());
    const selections = [
      { action: "include", assetId: "asset_live", isin: "ES00WL000009" } as const,
    ];

    expect(findUnresolvedStatementChoice(buckets, selections)).toBeNull();
    const plan = buildStatementImportPlan(buckets, selections);
    const [fund] = plan.included;
    if (fund?.kind !== "matched") throw new Error("expected a matched fund");

    expect(fund.assetId).toBe("asset_live");
    expect(fund.mergePlan.toOverwrite.map((row) => row.operationId)).toEqual(["op_live"]);
    expect(fund.mergePlan.toDelete).toEqual([]);
    expect(fund.mergePlan.toCreate.map((row) => row.dateKey)).toEqual(["2026-01-05"]);
  });

  test("choosing the closed holding is the user's call, and then it is the one written", () => {
    const buckets = resolveStatementImportBuckets(parsedMultiIsin(), claimants());
    const plan = buildStatementImportPlan(buckets, [
      { action: "include", assetId: "asset_closed", isin: "ES00WL000009" },
    ]);
    const [fund] = plan.included;
    if (fund?.kind !== "matched") throw new Error("expected a matched fund");

    expect(fund.assetId).toBe("asset_closed");
    expect(fund.mergePlan.toDelete.map((operation) => operation.id)).toEqual([
      "op_closed_opening",
    ]);
  });

  test("a provider symbol claimed twice, in either case, is ambiguous as well", () => {
    const buckets = resolveStatementImportBuckets(parsedMultiIsin(), [
      {
        assetId: "asset_a",
        isin: null,
        name: "Cripto A",
        operations: [],
        providerSymbol: "es00wl000009",
      },
      {
        assetId: "asset_b",
        isin: null,
        name: "Cripto B",
        operations: [],
        providerSymbol: "ES00WL000009",
      },
    ]);

    const [bucket] = buckets;
    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.ambiguous).toBe(true);
    expect(bucket.claimants.map((claimant) => claimant.assetId)).toEqual([
      "asset_a",
      "asset_b",
    ]);
  });

  test("a single claimant stays resolved: one claimant, no ambiguity, no choice needed", () => {
    const buckets = resolveStatementImportBuckets(parsedMultiIsin(), [claimants()[1]!]);

    const [bucket] = buckets;
    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.ambiguous).toBeUndefined();
    expect(bucket.claimants.map((claimant) => claimant.assetId)).toEqual(["asset_live"]);
    expect(
      findUnresolvedStatementChoice(buckets, [
        { action: "include", isin: "ES00WL000009" },
      ]),
    ).toBeNull();
  });

  test("the group's own name breaks the tie before liveness does", () => {
    const named = parseStatement(
      [
        "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
        "05/01/2026;Fondo;ES00WL000009;Compra;34,2857;1200;;Fondo viejo (bróker antiguo)",
      ].join("\r\n"),
      "plantilla",
    );
    if (!named.ok) throw new Error(named.errors.join(" | "));

    const [bucket] = resolveStatementImportBuckets(named.value, claimants());
    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.claimants.map((claimant) => claimant.assetId)).toEqual([
      "asset_closed",
      "asset_live",
    ]);
  });
});
