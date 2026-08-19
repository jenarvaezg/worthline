import type {
  FireAgeSource,
  FireProjection,
  FireScopeConfig,
  ScopeFireResult,
} from "@worthline/domain";
import {
  calculateFireForScope,
  createWorkspace,
  fireReturnMix,
  projectFireFromContext,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  fireAssumptionRows,
  fireReturnMixPrintRows,
  fireReturnMixTotal,
} from "./fire-assumptions-view";

const formatMoney = (amountMinor: number) =>
  `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(
    Math.round(amountMinor / 100),
  )} €`;

/** Jorge's shape: two thirds brick, a fund sleeve, a pension and 2.000 €/mes. */
function jorge(overrides: Partial<FireScopeConfig> = {}): {
  config: FireScopeConfig;
  projection: FireProjection;
  result: ScopeFireResult;
} {
  const config: FireScopeConfig = {
    currentAge: 63,
    monthlySavingsCapacityMinor: 10_000,
    monthlySpendingMinor: 200_000,
    safeWithdrawalRate: 0.035,
    targetRetirementAge: 67,
    ...overrides,
  };
  const workspace = createWorkspace({
    baseCurrency: "EUR",
    members: [{ id: "member_jorge", name: "Jorge" }],
    mode: "individual",
  });
  const result = calculateFireForScope(
    config,
    [
      {
        currency: "EUR",
        currentValue: { amountMinor: 143_370_75, currency: "EUR" },
        id: "asset_etf",
        isPrimaryResidence: false,
        liquidityTier: "market",
        name: "Fondos",
        ownership: [{ memberId: "member_jorge", shareBps: 10_000 }],
        type: "investment",
      },
      {
        currency: "EUR",
        currentValue: { amountMinor: 370_000_00, currency: "EUR" },
        id: "asset_rental",
        isPrimaryResidence: false,
        liquidityTier: "housing",
        name: "Piso de Plasencia",
        ownership: [{ memberId: "member_jorge", shareBps: 10_000 }],
        type: "real_estate",
      },
    ],
    [],
    workspace,
    "household",
  );

  return {
    config,
    projection: projectFireFromContext(result.context, {
      monthlyContributionMinor: config.monthlySavingsCapacityMinor ?? 0,
    }),
    result,
  };
}

const ageSource: FireAgeSource = {
  age: 63,
  birthYear: 1963,
  memberId: "member_jorge",
  memberName: "Jorge",
};

describe("fireAssumptionRows (#1426)", () => {
  test("prints the FIRE number with the division that produced it", () => {
    const { config, projection, result } = jorge();

    const rows = fireAssumptionRows({
      ageSource,
      config,
      formatMoney,
      projection,
      result,
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    expect(byKey.get("spending")).toMatchObject({
      gloss: "2000 €/mes, el gasto que declaras",
      value: "24.000 €/año",
    });
    expect(byKey.get("swr")?.value).toBe("3,5 %");
    expect(byKey.get("fireNumber")).toMatchObject({
      gloss: "24.000 € ÷ 3,5 %",
      value: "685.714 €",
    });
  });

  test("quotes the rates the scenarios actually counted years with", () => {
    const { config, projection, result } = jorge();

    const rows = fireAssumptionRows({
      ageSource,
      config,
      formatMoney,
      projection,
      result,
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const base = projection.scenarios.find((scenario) => scenario.label === "base")!;
    const optimistic = projection.scenarios.find(
      (scenario) => scenario.label === "optimistic",
    )!;

    // Not a hardcoded 5 %: the base is Jorge's weighted mix (mostly brick).
    expect(byKey.get("return-base")?.value).toBe(
      `${(base.annualReturn * 100).toFixed(1).replace(".", ",")} %`,
    );
    expect(byKey.get("return-base")?.gloss).toContain("ponderada por tu mezcla");
    expect(byKey.get("return-optimistic")?.value).toBe(
      `${(optimistic.annualReturn * 100).toFixed(1).replace(".", ",")} %`,
    );
  });

  test("says the rate is a manual override when the config fixed it", () => {
    const { config, projection, result } = jorge({ expectedRealReturn: 0.05 });

    const rows = fireAssumptionRows({
      ageSource,
      config,
      formatMoney,
      projection,
      result,
    });

    const row = rows.find((item) => item.key === "return-base")!;
    expect(row.value).toBe("5,0 %");
    expect(row.gloss).toContain("a mano");
  });

  test("cites the birth year behind the age, and says so when there is none", () => {
    const { config, projection, result } = jorge();

    const derived = fireAssumptionRows({
      ageSource,
      config,
      formatMoney,
      projection,
      result,
    }).find((row) => row.key === "ages")!;
    expect(derived.value).toBe("63 / 67");
    expect(derived.gloss).toContain("1963");

    const typed = fireAssumptionRows({
      ageSource: null,
      config,
      formatMoney,
      projection,
      result,
    }).find((row) => row.key === "ages")!;
    // Sin derivación la edad viene de una config antigua, y la glosa dice dónde se
    // arregla — el año de nacimiento es del miembro, no del FIRE (#1450).
    expect(typed.gloss).toContain("configuración antigua");
    expect(typed.gloss).toContain("Miembros");

    // Y si NO hay ninguna edad, no se le puede decir que la tiene puesta a mano:
    // la fila existe por la edad objetivo, y la glosa habla del hueco real.
    const { currentAge: _dropped, ...withoutAge } = config;
    const absent = fireAssumptionRows({
      ageSource: null,
      config: withoutAge,
      formatMoney,
      projection,
      result,
    }).find((row) => row.key === "ages")!;
    expect(absent.gloss).toContain("sin fecha de nacimiento");
    expect(absent.gloss).not.toContain("configuración antigua");
  });

  test("prints the declared savings scalar, zero included", () => {
    const { config, projection, result } = jorge();
    // An undeclared capacity is read as 0 by the projection (ADR 0074), so the fold
    // says «0 €/mes» rather than leaving the row out and looking like an oversight.
    const { monthlySavingsCapacityMinor: _undeclared, ...withoutSavings } = config;

    const row = fireAssumptionRows({
      ageSource,
      config: withoutSavings,
      formatMoney,
      projection,
      result,
    }).find((item) => item.key === "savings")!;

    expect(row.value).toBe("0 €/mes");
  });

  test("leaves the shifted rates out when there is no projection to read them off", () => {
    const { config, result } = jorge();

    const keys = fireAssumptionRows({
      ageSource,
      config,
      formatMoney,
      projection: null,
      result,
    }).map((row) => row.key);

    expect(keys).not.toContain("return-optimistic");
    expect(keys).not.toContain("return-pessimistic");
    expect(keys).toContain("return-base");
  });
});

describe("fireReturnMixPrintRows (#1426)", () => {
  test("turns the weighting into rows whose contributions add up to the rate", () => {
    const { result } = jorge();

    const rows = fireReturnMixPrintRows(result.returnMix);
    const total = fireReturnMixTotal(result.returnMix);

    expect(rows.map((row) => row.label)).toEqual(["Mercado", "Vivienda"]);
    // 143.370,75 of 513.370,75 is 27,93 % at 5 %; the rest is brick at 3 %.
    expect(rows[0]).toMatchObject({
      contribution: "1,40 %",
      isAsset: false,
      rate: "5,0 %",
      weight: "27,93 %",
    });
    expect(total).toEqual({ contribution: "3,56 %", weight: "100,00 %" });
  });

  test("marks a rung's own-rate asset as the subdivision it is (#1448)", () => {
    const mix = fireReturnMix({
      assetLabelById: { asset_rental: "Piso de Plasencia" },
      assetRateOverrides: [
        { amountMinor: 300_000, assetId: "asset_rental", rate: 0.042, tier: "housing" },
      ],
      eligibleByTierMinor: { housing: 400_000 },
    });

    const rows = fireReturnMixPrintRows(mix);

    expect(rows.map((row) => [row.label, row.isAsset])).toEqual([
      ["Vivienda", false],
      ["Piso de Plasencia", true],
    ]);
  });

  test("has nothing to print for an empty pool", () => {
    const mix = fireReturnMix({ eligibleByTierMinor: {} });

    expect(fireReturnMixPrintRows(mix)).toEqual([]);
  });
});
