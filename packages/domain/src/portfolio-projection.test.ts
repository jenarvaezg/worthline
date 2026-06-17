import { describe, expect, test } from "vitest";

import {
  calculateNetWorth,
  createLiability,
  createManualAsset,
  createWorkspace,
} from "./index";
import {
  projectPortfolio,
  type PortfolioProjectionInput,
  type ProjectedAssetRow,
  type ProjectedLiabilityRow,
} from "./portfolio-projection";

// ── fixtures ────────────────────────────────────────────────────────────────

const workspace = createWorkspace({
  members: [
    { id: "member_ana", name: "Ana" },
    { id: "member_jose", name: "Jose" },
  ],
  mode: "household",
});

const sharedCash = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 100_000,
  id: "asset_cash",
  liquidityTier: "cash",
  name: "Cuenta compartida",
  ownership: [
    { memberId: "member_ana", shareBps: 5_000 },
    { memberId: "member_jose", shareBps: 5_000 },
  ],
  type: "cash",
});

const joseBroker = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 80_000,
  id: "asset_broker",
  liquidityTier: "market",
  name: "Broker Jose",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "investment",
});

const home = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 30_000_000,
  id: "asset_home",
  isPrimaryResidence: true,
  liquidityTier: "illiquid",
  name: "Vivienda",
  ownership: [
    { memberId: "member_ana", shareBps: 5_000 },
    { memberId: "member_jose", shareBps: 5_000 },
  ],
  type: "real_estate",
});

const mortgage = createLiability(workspace, {
  associatedAssetId: "asset_home",
  balanceMinor: 18_000_000,
  currency: "EUR",
  id: "debt_mortgage",
  name: "Hipoteca",
  ownership: [
    { memberId: "member_ana", shareBps: 5_000 },
    { memberId: "member_jose", shareBps: 5_000 },
  ],
  type: "mortgage",
});

const personalDebt = createLiability(workspace, {
  balanceMinor: 5_000,
  currency: "EUR",
  id: "debt_personal",
  name: "Deuda personal Ana",
  ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
  type: "debt",
});

// ── household scope ──────────────────────────────────────────────────────────

describe("projectPortfolio — household scope", () => {
  const input: PortfolioProjectionInput = {
    assets: [sharedCash, joseBroker, home],
    liabilities: [mortgage],
    scope: { id: "household", label: "Hogar", type: "household" },
    workspace,
  };

  test("returns two sections: assets and liabilities", () => {
    const result = projectPortfolio(input);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]!.kind).toBe("assets");
    expect(result.sections[1]!.kind).toBe("liabilities");
  });

  test("asset rows carry full unweighted values under household scope", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    const cash = assets.find((r) => r.id === "asset_cash")!;
    expect(cash.valueMinor).toBe(100_000);
  });

  test("investment rows flag their value as derived (units × price, ADR 0006)", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    const broker = assets.find((r) => r.id === "asset_broker")! as ProjectedAssetRow;
    expect(broker.valueIsDerived).toBe(true);
  });

  test("non-investment asset rows do NOT flag a derived value", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    const cash = assets.find((r) => r.id === "asset_cash")! as ProjectedAssetRow;
    expect(cash.valueIsDerived).toBe(false);
  });

  test("EVERY asset row carries its ficha detail link — investments are no longer ghosts (#154)", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    for (const row of assets) {
      expect(row.detailHref).toBe(`/patrimonio/${row.id}/editar`);
    }
  });

  test("rows expose their instrument so the list can group/filter by it (#154)", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    const cash = assets.find((r) => r.id === "asset_cash")!;
    expect(cash.instrument).toBe("current_account");
    const broker = assets.find((r) => r.id === "asset_broker")!;
    expect(broker.instrument).toBe("fund");
    const housing = assets.find((r) => r.id === "asset_home")!;
    expect(housing.instrument).toBe("property");
  });

  test("ownership data is present on every row in household mode", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    for (const row of assets) {
      expect(row.ownership).toBeDefined();
    }
  });

  test("liability rows carry full unweighted balances", () => {
    const result = projectPortfolio(input);
    const liabilities = result.sections[1]!.rows as ProjectedLiabilityRow[];
    const hyp = liabilities.find((r) => r.id === "debt_mortgage")!;
    expect(hyp.balanceMinor).toBe(18_000_000);
  });

  test("liquidity tier labels are translated Spanish strings, not raw enum", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    const cash = assets.find((r) => r.id === "asset_cash")!;
    expect(cash.tierLabel).toBe("Caja");
    const broker = assets.find((r) => r.id === "asset_broker")!;
    expect(broker.tierLabel).toBe("Mercado");
    const housing = assets.find((r) => r.id === "asset_home")!;
    expect(housing.tierLabel).toBe("Vivienda");
  });

  test("reconciliation: asset row sum equals grossAssets from calculateNetWorth", () => {
    const result = projectPortfolio(input);
    const summary = calculateNetWorth({
      assets: input.assets,
      liabilities: input.liabilities,
      scopeId: input.scope.id,
      workspace,
    });
    const rowSum = (result.sections[0]!.rows as ProjectedAssetRow[]).reduce(
      (acc, r) => acc + r.valueMinor,
      0,
    );
    expect(rowSum).toBe(summary.grossAssets.amountMinor);
  });

  test("reconciliation: liability row sum equals debts from calculateNetWorth", () => {
    const result = projectPortfolio(input);
    const summary = calculateNetWorth({
      assets: input.assets,
      liabilities: input.liabilities,
      scopeId: input.scope.id,
      workspace,
    });
    const rowSum = (result.sections[1]!.rows as ProjectedLiabilityRow[]).reduce(
      (acc, r) => acc + r.balanceMinor,
      0,
    );
    expect(rowSum).toBe(summary.debts.amountMinor);
  });

  test("summary totals match calculateNetWorth", () => {
    const result = projectPortfolio(input);
    const summary = calculateNetWorth({
      assets: input.assets,
      liabilities: input.liabilities,
      scopeId: "household",
      workspace,
    });
    expect(result.totalGrossAssets.amountMinor).toBe(summary.grossAssets.amountMinor);
    expect(result.totalDebts.amountMinor).toBe(summary.debts.amountMinor);
  });
});

// ── member scope ─────────────────────────────────────────────────────────────

describe("projectPortfolio — member scope (Ana)", () => {
  const input: PortfolioProjectionInput = {
    assets: [sharedCash, joseBroker, home],
    liabilities: [mortgage, personalDebt],
    scope: { id: "member_ana", label: "Ana", type: "member" },
    workspace,
  };

  test("asset values are weighted by Ana's share", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    const cash = assets.find((r) => r.id === "asset_cash")!;
    // Ana owns 50% of 100_000 = 50_000
    expect(cash.valueMinor).toBe(50_000);
  });

  test("rows where Ana holds 0% are excluded (joseBroker is Jose-only)", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    expect(assets.find((r) => r.id === "asset_broker")).toBeUndefined();
  });

  test("liability rows are weighted by Ana's share and zero-share excluded", () => {
    const result = projectPortfolio(input);
    const liabilities = result.sections[1]!.rows as ProjectedLiabilityRow[];
    const hyp = liabilities.find((r) => r.id === "debt_mortgage")!;
    // Ana owns 50% of 18_000_000 = 9_000_000
    expect(hyp.balanceMinor).toBe(9_000_000);
  });

  test("member scope: ownership data is still present on rows", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    for (const row of assets) {
      expect(row.ownership).toBeDefined();
    }
  });

  test("share exposed in ownership reflects Ana's actual bps", () => {
    const result = projectPortfolio(input);
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    const cash = assets.find((r) => r.id === "asset_cash")!;
    // sharedCash: Ana has shareBps=5000 (50%)
    expect(cash.ownership!.totalShareBps).toBe(5_000);
  });

  test("reconciliation invariant holds for member scope", () => {
    const result = projectPortfolio(input);
    const summary = calculateNetWorth({
      assets: input.assets,
      liabilities: input.liabilities,
      scopeId: "member_ana",
      workspace,
    });
    const assetRowSum = (result.sections[0]!.rows as ProjectedAssetRow[]).reduce(
      (acc, r) => acc + r.valueMinor,
      0,
    );
    const liabilityRowSum = (result.sections[1]!.rows as ProjectedLiabilityRow[]).reduce(
      (acc, r) => acc + r.balanceMinor,
      0,
    );
    expect(assetRowSum).toBe(summary.grossAssets.amountMinor);
    expect(liabilityRowSum).toBe(summary.debts.amountMinor);
  });
});

// ── single-member workspace ──────────────────────────────────────────────────

describe("projectPortfolio — single-member workspace (individual mode)", () => {
  const soloWorkspace = createWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const soloAsset = createManualAsset(soloWorkspace, {
    currency: "EUR",
    currentValueMinor: 42_000,
    id: "asset_solo",
    liquidityTier: "term-locked",
    name: "Pensión",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "manual",
  });

  test("household scope in individual mode gives full values", () => {
    const result = projectPortfolio({
      assets: [soloAsset],
      liabilities: [],
      scope: { id: "household", label: "Hogar", type: "household" },
      workspace: soloWorkspace,
    });
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    expect(assets[0]!.valueMinor).toBe(42_000);
  });

  test("member scope in individual mode gives same full value (100% ownership)", () => {
    const result = projectPortfolio({
      assets: [soloAsset],
      liabilities: [],
      scope: { id: "member_jose", label: "Jose", type: "member" },
      workspace: soloWorkspace,
    });
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    expect(assets[0]!.valueMinor).toBe(42_000);
    expect(result.totalGrossAssets.amountMinor).toBe(42_000);
  });

  test("term-locked tier label is 'A plazo'", () => {
    const result = projectPortfolio({
      assets: [soloAsset],
      liabilities: [],
      scope: { id: "household", label: "Hogar", type: "household" },
      workspace: soloWorkspace,
    });
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    expect(assets[0]!.tierLabel).toBe("A plazo");
  });
});

// ── tier label coverage ──────────────────────────────────────────────────────

describe("tier label translation", () => {
  const soloWorkspace = createWorkspace({
    members: [{ id: "m1", name: "Solo" }],
    mode: "individual",
  });
  const own = [{ memberId: "m1", shareBps: 10_000 }];

  const illiquidAsset = createManualAsset(soloWorkspace, {
    currency: "EUR",
    currentValueMinor: 1_000,
    id: "a_illiquid",
    liquidityTier: "illiquid",
    name: "Ilíquido",
    ownership: own,
    type: "manual",
  });

  test("illiquid tier label is 'Ilíquido'", () => {
    const result = projectPortfolio({
      assets: [illiquidAsset],
      liabilities: [],
      scope: { id: "household", label: "Hogar", type: "household" },
      workspace: soloWorkspace,
    });
    const assets = result.sections[0]!.rows as ProjectedAssetRow[];
    expect(assets[0]!.tierLabel).toBe("Ilíquido");
  });
});
