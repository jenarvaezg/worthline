import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import {
  buildStatementImportPlan,
  findUnresolvedStatementChoice,
  resolveStatementImportBuckets,
  type StatementPortfolioInvestment,
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
        securityId: { kind: "isin" as const, value: "ES00WL000009" },
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
        securityId: { kind: "isin" as const, value: "LU00WL000022" },
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
  const claimants = (): StatementPortfolioInvestment[] => [
    {
      assetId: "asset_closed",
      securityId: { kind: "isin" as const, value: "ES00WL000009" },
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
      securityId: { kind: "isin" as const, value: "ES00WL000009" },
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
    // The symbol lane, on a file whose identifier IS a symbol: since #1748 an
    // ISIN in the file no longer meets a holding that carries it as a pricing
    // handle — the namespace keeps identity and quote route apart.
    const crypto = parseStatement(
      [
        "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
        "05/01/2026;Cripto;Bitcoin;Compra;0,0100;600;;",
      ].join("\r\n"),
      "plantilla",
    );
    if (!crypto.ok) throw new Error(crypto.errors.join(" | "));

    const buckets = resolveStatementImportBuckets(crypto.value, [
      {
        assetId: "asset_a",
        name: "Cripto A",
        operations: [],
        providerSymbol: "bitcoin",
      },
      {
        assetId: "asset_b",
        name: "Cripto B",
        operations: [],
        providerSymbol: "Bitcoin",
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

describe("routing by TYPED identifier (#1748, ADR 0055 amendment)", () => {
  const HEADER =
    "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre";

  function parsed(
    identifier: string,
    type = "Plan de pensiones",
    name = "",
  ): ReturnType<typeof parsedMultiIsin> {
    const result = parseStatement(
      [
        HEADER,
        `05/01/2026;${type};${identifier};Compra;34,2857;1200;;${name}`,
        `05/02/2026;${type};${identifier};Compra;33,9120;1200;;${name}`,
      ].join("\r\n"),
      "plantilla",
    );
    if (!result.ok) throw new Error(result.errors.join(" | "));
    return result.value;
  }

  test("a bare plan code routes to the holding that DECLARES that DGS code", () => {
    const [bucket] = resolveStatementImportBuckets(parsed("N5394"), [
      {
        assetId: "asset_plan",
        instrument: "pension_plan",
        name: "Plan Indexado Global",
        operations: [],
        securityId: { kind: "dgs" as const, value: "N5394" },
      },
    ]);

    expect(bucket?.bucket).toBe("matched");
    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.assetId).toBe("asset_plan");
    // Matched by the identifier itself — there is nothing to offer to backfill.
    expect(bucket.offeredSecurityId).toBeUndefined();
    // The dash of a scanned code is the same code.
    expect(bucket.isin).toBe("N5394");
    expect(
      resolveStatementImportBuckets(parsed("N-5394"), [
        {
          assetId: "asset_plan",
          instrument: "pension_plan",
          name: "Plan Indexado Global",
          operations: [],
          securityId: { kind: "dgs" as const, value: "N5394" },
        },
      ])[0]?.bucket,
    ).toBe("matched");
  });

  test("the finect slug keeps routing as a provider symbol", () => {
    const [bucket] = resolveStatementImportBuckets(
      parsed("N5394-Myinvestor_indexado_global_pp"),
      [
        {
          assetId: "asset_plan",
          instrument: "pension_plan",
          name: "Plan Indexado Global",
          operations: [],
          providerSymbol: "N5394-Myinvestor_indexado_global_pp",
          securityId: { kind: "dgs" as const, value: "N5394" },
        },
      ],
    );

    expect(bucket?.bucket).toBe("matched");
    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.assetId).toBe("asset_plan");
  });

  test("a plan code never meets the same characters sitting in another lane", () => {
    // The holding's pair says `isin`, so `N5394` from the file (a DGS by shape)
    // does not reach it: a mistyped identifier is delated as «sin match» instead
    // of matching by value.
    const [mistyped] = resolveStatementImportBuckets(parsed("N5394"), [
      {
        assetId: "asset_plan",
        instrument: "pension_plan",
        name: "Plan Indexado Global",
        operations: [],
        securityId: { kind: "isin" as const, value: "N5394" },
      },
    ]);
    expect(mistyped?.bucket).toBe("new");

    // Nor does it reach a holding whose finect code sits in the provider symbol.
    const [asSymbol] = resolveStatementImportBuckets(parsed("N5394"), [
      {
        assetId: "asset_plan",
        instrument: "pension_plan",
        name: "Otro plan",
        operations: [],
        providerSymbol: "N5394",
      },
    ]);
    expect(asSymbol?.bucket).toBe("new");
  });

  test("a preserved value with no kind claims no identifier (invariant 2 of #1741)", () => {
    const [bucket] = resolveStatementImportBuckets(parsed("N5394"), [
      {
        assetId: "asset_plan",
        instrument: "pension_plan",
        name: "Plan Indexado Global",
        operations: [],
        // What the v70 backfill leaves for a value it could not read (#1743).
        securityId: { kind: null, value: "N5394" },
      },
    ]);

    expect(bucket?.bucket).toBe("new");
  });
});

describe("the offered identifier backfill (#1748, the new weak arm)", () => {
  const HEADER =
    "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre";

  function planFile(identifier = "N5394", name = "Plan Indexado Global") {
    const result = parseStatement(
      [
        HEADER,
        `05/01/2026;Plan de pensiones;${identifier};Compra;34,2857;1200;;${name}`,
      ].join("\r\n"),
      "plantilla",
    );
    if (!result.ok) throw new Error(result.errors.join(" | "));
    return result.value;
  }

  const emptyHoldingPlan = {
    assetId: "asset_plan",
    instrument: "pension_plan" as const,
    name: "Plan Indexado Global",
    operations: [],
  };

  test("exact name + compatible instrument + empty hole → matched, with the fill OFFERED", () => {
    const buckets = resolveStatementImportBuckets(planFile(), [emptyHoldingPlan]);
    const [bucket] = buckets;

    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.assetId).toBe("asset_plan");
    expect(bucket.offeredSecurityId).toEqual({ kind: "dgs", value: "N5394" });
    expect(bucket.ambiguous).toBeUndefined();

    // Confirming the fund is what accepts the offer; the plan carries the write.
    const plan = buildStatementImportPlan(buckets, [
      { action: "include", isin: "N5394" },
    ]);
    const [fund] = plan.included;
    if (fund?.kind !== "matched") throw new Error("expected a matched fund");
    expect(fund.backfillSecurityId).toEqual({ kind: "dgs", value: "N5394" });
  });

  test("an accented name is the same name; a merely similar one is not", () => {
    const [accented] = resolveStatementImportBuckets(
      planFile("N5394", "Plan Índexado  Global"),
      [emptyHoldingPlan],
    );
    expect(accented?.bucket).toBe("matched");

    const [similar] = resolveStatementImportBuckets(
      planFile("N5394", "Plan Indexado Global Sostenible"),
      [emptyHoldingPlan],
    );
    // Never fuzzy: a substring is not a name (#1373's false positive).
    expect(similar?.bucket).toBe("new");
  });

  test("an occupied hole is never overwritten — not even one holding a value with no kind", () => {
    const [declared] = resolveStatementImportBuckets(planFile(), [
      { ...emptyHoldingPlan, securityId: { kind: "dgs" as const, value: "N5396" } },
    ]);
    expect(declared?.bucket).toBe("new");

    const [preserved] = resolveStatementImportBuckets(planFile(), [
      { ...emptyHoldingPlan, securityId: { kind: null, value: "algo-que-nadie-leyo" } },
    ]);
    expect(preserved?.bucket).toBe("new");
  });

  test("an incompatible instrument is not the same instrument", () => {
    const [bucket] = resolveStatementImportBuckets(planFile(), [
      { ...emptyHoldingPlan, instrument: "fund" },
    ]);
    expect(bucket?.bucket).toBe("new");
  });

  test("nothing is offered that the holding's instrument could not carry (#1453)", () => {
    // Name and instrument agree, the hole is empty — and the offer is still
    // refused, because no crypto holding carries an ISIN: an identifier written
    // where it does not validate is the one thing the guard forbids.
    const cryptoFile = parseStatement(
      [HEADER, "05/01/2026;Cripto;ES00WL000009;Compra;0,0100;600;;Cartera Cripto"].join(
        "\r\n",
      ),
      "plantilla",
    );
    if (!cryptoFile.ok) throw new Error(cryptoFile.errors.join(" | "));

    const [bucket] = resolveStatementImportBuckets(cryptoFile.value, [
      {
        assetId: "asset_crypto",
        instrument: "crypto",
        name: "Cartera Cripto",
        operations: [],
      },
    ]);
    expect(bucket?.bucket).toBe("new");
  });

  test("a group that only carries a symbol offers nothing: there is no identifier to fill", () => {
    const [bucket] = resolveStatementImportBuckets(planFile("N5394-Myinvestor_pp"), [
      emptyHoldingPlan,
    ]);
    expect(bucket?.bucket).toBe("new");
  });

  test("two empty-hole namesakes are a CHOICE, never a resolved offer", () => {
    const buckets = resolveStatementImportBuckets(planFile(), [
      emptyHoldingPlan,
      { ...emptyHoldingPlan, assetId: "asset_plan_2" },
    ]);
    const [bucket] = buckets;

    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.ambiguous).toBe(true);
    expect(bucket.claimants.map((claimant) => claimant.assetId)).toEqual([
      "asset_plan",
      "asset_plan_2",
    ]);
    expect(
      findUnresolvedStatementChoice(buckets, [{ action: "include", isin: "N5394" }]),
    ).toBe("N5394");

    // Y cuando elige, el código se rellena en la que eligió — no en la primera.
    const plan = buildStatementImportPlan(buckets, [
      { action: "include", assetId: "asset_plan_2", isin: "N5394" },
    ]);
    expect(plan.included[0]).toMatchObject({
      assetId: "asset_plan_2",
      backfillSecurityId: { kind: "dgs", value: "N5394" },
    });
  });

  test("a strong claimant wins: the weak arm never competes with the identifier", () => {
    const [bucket] = resolveStatementImportBuckets(planFile(), [
      emptyHoldingPlan,
      {
        assetId: "asset_declared",
        instrument: "pension_plan",
        name: "Otro nombre",
        operations: [],
        securityId: { kind: "dgs" as const, value: "N5394" },
      },
    ]);

    if (bucket?.bucket !== "matched") throw new Error("expected matched bucket");
    expect(bucket.claimants.map((claimant) => claimant.assetId)).toEqual([
      "asset_declared",
    ]);
    expect(bucket.offeredSecurityId).toBeUndefined();
    expect(bucket.ambiguous).toBeUndefined();
  });
});
