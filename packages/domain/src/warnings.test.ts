import { describe, expect, test } from "vitest";

import type { AssetType, InvestmentOperation, ManualAsset } from "./index";
import { CLOSED_POSITION_UNITS_EPSILON, collectWarnings } from "./warnings";

function asset(
  id: string,
  name: string,
  amountMinor: number,
  type: AssetType = "cash",
  providerSymbol?: string,
  connectedSourceId?: string,
): ManualAsset {
  return {
    id,
    name,
    type,
    currentValue: { amountMinor, currency: "EUR" },
    ...(providerSymbol ? { providerSymbol } : {}),
    ...(connectedSourceId ? { connectedSourceId } : {}),
  } as ManualAsset;
}

describe("collectWarnings", () => {
  test("flags zero-value assets as overrideable", () => {
    const warnings = collectWarnings([
      asset("a1", "Cuenta", 0),
      asset("a2", "Piso", 100),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "ZERO_VALUE_ASSET",
      entityId: "a1",
      entityType: "asset",
      severity: "overrideable",
    });
  });

  test("does not flag a freshly-created derived holding at 0 (it reads 0 until its first operation)", () => {
    // Symbol'd so this fixture stays scoped to the zero-value exemption — its
    // provider-symbol state is covered separately below.
    const warnings = collectWarnings([
      asset("inv1", "ETF MSCI World", 0, "investment", "MSCI.FAKE"),
      asset("a1", "Cuenta", 0, "cash"),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "ZERO_VALUE_ASSET", entityId: "a1" });
  });

  test("suppresses an overrideable warning that has a matching override", () => {
    const warnings = collectWarnings(
      [asset("a1", "Cuenta", 0)],
      [{ code: "ZERO_VALUE_ASSET", entityId: "a1" }],
    );

    expect(warnings).toEqual([]);
  });

  test("an override for a different entity or code does not suppress the warning", () => {
    expect(
      collectWarnings(
        [asset("a1", "Cuenta", 0)],
        [{ code: "ZERO_VALUE_ASSET", entityId: "other" }],
      ),
    ).toHaveLength(1);
    expect(
      collectWarnings(
        [asset("a1", "Cuenta", 0)],
        [{ code: "OTHER_CODE", entityId: "a1" }],
      ),
    ).toHaveLength(1);
  });
});

describe("collectWarnings — MISSING_PROVIDER_SYMBOL (ADR 0055)", () => {
  test("flags a derived investment with no provider symbol as overrideable", () => {
    const warnings = collectWarnings([
      asset("inv1", "Fondo sin símbolo", 100_00, "investment"),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "MISSING_PROVIDER_SYMBOL",
      entityId: "inv1",
      entityType: "asset",
      severity: "overrideable",
    });
  });

  test("does not flag a derived investment that carries a provider symbol", () => {
    const warnings = collectWarnings([
      asset("inv1", "ETF MSCI World", 100_00, "investment", "MSCI.FAKE"),
    ]);

    expect(warnings).toEqual([]);
  });

  test("does not flag a non-derived (hand-valued) holding for a missing symbol", () => {
    const warnings = collectWarnings([asset("a1", "Cuenta", 100_00, "cash")]);

    expect(warnings).toEqual([]);
  });

  test("does not flag a symbol-less connected-source holding (Binance, Numista, …, #685 bug)", () => {
    const warnings = collectWarnings([
      asset("inv1", "Binance", 100_00, "investment", undefined, "source1"),
    ]);

    expect(warnings).toEqual([]);
  });

  test("suppresses the warning once overridden, for a hand-quoted fund", () => {
    const warnings = collectWarnings(
      [asset("inv1", "Fondo cotizado a mano", 100_00, "investment")],
      [{ code: "MISSING_PROVIDER_SYMBOL", entityId: "inv1" }],
    );

    expect(warnings).toEqual([]);
  });

  test("an override for a different entity or code does not suppress it", () => {
    expect(
      collectWarnings(
        [asset("inv1", "Fondo sin símbolo", 100_00, "investment")],
        [{ code: "MISSING_PROVIDER_SYMBOL", entityId: "other" }],
      ),
    ).toHaveLength(1);
    expect(
      collectWarnings(
        [asset("inv1", "Fondo sin símbolo", 100_00, "investment")],
        [{ code: "OTHER_CODE", entityId: "inv1" }],
      ),
    ).toHaveLength(1);
  });
});

describe("collectWarnings — closed positions do not need a symbol (#1348)", () => {
  const symbolless = asset("inv1", "Fondo vendido entero", 0, "investment");
  const codes = (assets: ManualAsset[], netUnits?: [string, string][]): string[] =>
    collectWarnings(
      assets,
      [],
      netUnits ? { netUnitsByAssetId: new Map(netUnits) } : {},
    ).map((warning) => warning.code);

  test("a fully-sold position is silent — it contributes nothing to today's figure", () => {
    expect(codes([symbolless], [["inv1", "0"]])).toEqual([]);
  });

  test("an open position without a symbol still warns", () => {
    expect(codes([symbolless], [["inv1", "12.5"]])).toEqual(["MISSING_PROVIDER_SYMBOL"]);
  });

  test("a closed position that reopens with a new buy warns again", () => {
    expect(codes([symbolless], [["inv1", "0"]])).toEqual([]);
    expect(codes([symbolless], [["inv1", "3"]])).toEqual(["MISSING_PROVIDER_SYMBOL"]);
  });

  test("sub-threshold dust left by a rounded sell reads as closed", () => {
    expect(codes([symbolless], [["inv1", "0.00001"]])).toEqual([]);
    expect(codes([symbolless], [["inv1", "-0.00001"]])).toEqual([]);
  });

  test("units at the threshold are still held, so the warning stands", () => {
    expect(codes([symbolless], [["inv1", CLOSED_POSITION_UNITS_EPSILON]])).toEqual([
      "MISSING_PROVIDER_SYMBOL",
    ]);
  });

  test("a holding absent from the map is read as open (caller read no ledger)", () => {
    expect(codes([symbolless])).toEqual(["MISSING_PROVIDER_SYMBOL"]);
    expect(codes([symbolless], [["other", "0"]])).toEqual(["MISSING_PROVIDER_SYMBOL"]);
  });

  test("net units never silence a non-provider-symbol warning", () => {
    // A `stored` holding at 0 is a genuine misconfiguration whatever its units say.
    expect(codes([asset("a1", "Cuenta", 0, "cash")], [["a1", "0"]])).toEqual([
      "ZERO_VALUE_ASSET",
    ]);
  });
});

describe("collectWarnings — OVERSELL / OVER_TRANSFER from the ledger (#1443)", () => {
  const jorge = asset(
    "inv1",
    "Amundi IS Core MSCI Europe IE-C",
    0,
    "investment",
    "AE.PA",
  );

  function ledger(buys: string, sells: string): InvestmentOperation[] {
    return [
      {
        assetId: "inv1",
        currency: "EUR",
        executedAt: "2026-01-01",
        feesMinor: 0,
        id: "buy",
        kind: "buy",
        pricePerUnit: "10",
        units: buys,
      },
      {
        assetId: "inv1",
        currency: "EUR",
        executedAt: "2026-02-01",
        feesMinor: 0,
        id: "sell",
        kind: "sell",
        pricePerUnit: "10",
        units: sells,
      },
    ];
  }

  test("Jorge's 31.999 vs 32 is an overrideable OVERSELL", () => {
    const warnings = collectWarnings([jorge], [], {
      operationsByAssetId: new Map([["inv1", ledger("31.999", "32")]]),
    });

    expect(warnings).toEqual([
      expect.objectContaining({
        code: "OVERSELL",
        entityId: "inv1",
        entityType: "asset",
        severity: "overrideable",
      }),
    ]);
    expect(warnings[0]?.message).toContain("Amundi IS Core MSCI Europe IE-C");
  });

  test("a persisted override silences it", () => {
    expect(
      collectWarnings([jorge], [{ code: "OVERSELL", entityId: "inv1" }], {
        operationsByAssetId: new Map([["inv1", ledger("31.999", "32")]]),
      }),
    ).toEqual([]);
  });

  test("without an oversell the ledger adds nothing", () => {
    expect(
      collectWarnings([jorge], [], {
        operationsByAssetId: new Map([["inv1", ledger("32", "31")]]),
      }).map((warning) => warning.code),
    ).toEqual([]);
  });

  test("an over-transfer is OVER_TRANSFER, not OVERSELL", () => {
    const warnings = collectWarnings([jorge], [], {
      operationsByAssetId: new Map([
        [
          "inv1",
          [
            {
              assetId: "inv1",
              currency: "EUR",
              executedAt: "2026-01-01",
              feesMinor: 0,
              id: "buy",
              kind: "buy",
              pricePerUnit: "10",
              units: "2",
            },
            {
              assetId: "inv1",
              currency: "EUR",
              executedAt: "2026-02-01",
              feesMinor: 0,
              id: "out",
              kind: "transfer_out",
              pricePerUnit: "10",
              transferId: "trf_1",
              units: "5",
            },
          ],
        ],
      ]),
    });

    expect(warnings.map((warning) => warning.code)).toEqual(["OVER_TRANSFER"]);
  });
});

describe("collectWarnings — a traspaso whose cost is pending (#1882)", () => {
  function pendingEntry(
    id: string,
    executedAt: string,
    state: InvestmentOperation["transferLegState"] = "cost_pending",
  ): InvestmentOperation {
    return {
      assetId: "plan",
      currency: "EUR",
      executedAt,
      feesMinor: 0,
      id,
      kind: "transfer_in",
      pricePerUnit: "17.43",
      source: "connected",
      transferCostMinor: 70_133,
      transferId: `myinvestor-external:${id}`,
      ...(state ? { transferLegState: state } : {}),
      units: "40.237",
    };
  }
  const plan = asset("plan", "Plan Indexado", 0, "investment", undefined, "src-mi");

  test("names the day of the entry whose cost is missing, and cannot be ignored", () => {
    const warnings = collectWarnings(
      [plan],
      [{ code: "TRANSFER_COST_PENDING", entityId: "plan" }],
      {
        operationsByAssetId: new Map([["plan", [pendingEntry("in-1", "2026-01-14")]]]),
      },
    );

    expect(warnings).toEqual([
      {
        code: "TRANSFER_COST_PENDING",
        entityId: "plan",
        entityType: "asset",
        message:
          "Falta el coste del traspaso del 14/01/2026: sin él, la ganancia no se puede medir.",
        severity: "blocking",
      },
    ]);
  });

  test("with two pending, says how many and the first day", () => {
    const warnings = collectWarnings([plan], [], {
      operationsByAssetId: new Map([
        [
          "plan",
          [pendingEntry("in-2", "2026-03-02"), pendingEntry("in-1", "2026-01-14")],
        ],
      ]),
    });

    expect(warnings[0]?.message).toBe(
      "Falta el coste de 2 traspasos, el primero del 14/01/2026: sin él, la ganancia no se puede medir.",
    );
  });

  test("an answered entry raises nothing", () => {
    const warnings = collectWarnings([plan], [], {
      operationsByAssetId: new Map([
        ["plan", [pendingEntry("in-1", "2026-01-14", "cost_declared")]],
      ]),
    });

    expect(warnings).toEqual([]);
  });
});
