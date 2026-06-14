import { describe, expect, test } from "vitest";

import { createLiability, createManualAsset, createWorkspace } from "./index";
import { groupPortfolio, PORTFOLIO_GROUP_KEYS } from "./portfolio-grouping";
import { projectPortfolio } from "./portfolio-projection";

// ── fixtures ────────────────────────────────────────────────────────────────

const workspace = createWorkspace({
  members: [{ id: "m", name: "Solo" }],
  mode: "individual",
});
const own = [{ memberId: "m", shareBps: 10_000 }];

const cash = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 100_000,
  id: "asset_cash",
  liquidityTier: "cash",
  name: "Cuenta",
  ownership: own,
  type: "cash",
});

const broker = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 80_000,
  id: "asset_broker",
  liquidityTier: "market",
  name: "Broker",
  ownership: own,
  type: "investment",
});

const home = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 30_000_000,
  id: "asset_home",
  isPrimaryResidence: true,
  liquidityTier: "illiquid",
  name: "Vivienda",
  ownership: own,
  type: "real_estate",
});

const mortgage = createLiability(workspace, {
  associatedAssetId: "asset_home",
  balanceMinor: 18_000_000,
  currency: "EUR",
  id: "debt_mortgage",
  name: "Hipoteca",
  ownership: own,
  type: "mortgage",
});

const projection = projectPortfolio({
  assets: [cash, broker, home],
  liabilities: [mortgage],
  scope: { id: "household", label: "Hogar", type: "household" },
  workspace,
});

// ── direction (default) ───────────────────────────────────────────────────────

describe("groupPortfolio — by direction (default)", () => {
  const groups = groupPortfolio(projection, "direction");

  test("produces exactly two groups: Activos then Pasivos", () => {
    expect(groups.map((g) => g.label)).toEqual(["Activos", "Pasivos"]);
  });

  test("the Activos group holds every asset row (investment included, not a ghost)", () => {
    const activos = groups.find((g) => g.key === "assets")!;
    const ids = activos.holdings.map((h) => h.id);
    expect(ids).toContain("asset_cash");
    expect(ids).toContain("asset_broker");
    expect(ids).toContain("asset_home");
  });

  test("the Pasivos group holds the liability rows", () => {
    const pasivos = groups.find((g) => g.key === "liabilities")!;
    expect(pasivos.holdings.map((h) => h.id)).toEqual(["debt_mortgage"]);
  });

  test("every holding carries a ficha detailHref and a direction discriminant", () => {
    for (const group of groups) {
      for (const h of group.holdings) {
        expect(h.detailHref).toBe(`/patrimonio/${h.id}/editar`);
        expect(h.direction === "asset" || h.direction === "liability").toBe(true);
      }
    }
  });
});

// ── rung ───────────────────────────────────────────────────────────────────────

describe("groupPortfolio — by rung", () => {
  const groups = groupPortfolio(projection, "rung");

  test("groups follow ladder order and only non-empty rungs appear", () => {
    expect(groups.map((g) => g.label)).toEqual(["Caja", "Mercado", "Ilíquido"]);
  });

  test("the market rung holds the investment; illiquid holds home + its mortgage", () => {
    const market = groups.find((g) => g.key === "market")!;
    expect(market.holdings.map((h) => h.id)).toEqual(["asset_broker"]);
    const illiquid = groups.find((g) => g.key === "illiquid")!;
    expect(illiquid.holdings.map((h) => h.id).sort()).toEqual(
      ["asset_home", "debt_mortgage"].sort(),
    );
  });
});

// ── instrument ───────────────────────────────────────────────────────────────

describe("groupPortfolio — by instrument", () => {
  const groups = groupPortfolio(projection, "instrument");

  test("groups by instrument with Spanish labels", () => {
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.label]));
    expect(byKey["current_account"]).toBe("Cuenta corriente");
    expect(byKey["fund"]).toBe("Fondo");
    expect(byKey["property"]).toBe("Inmueble");
    expect(byKey["mortgage"]).toBe("Hipoteca");
  });

  test("the fund instrument group holds the investment row", () => {
    const fund = groups.find((g) => g.key === "fund")!;
    expect(fund.holdings.map((h) => h.id)).toEqual(["asset_broker"]);
  });
});

// ── key vocabulary ──────────────────────────────────────────────────────────

describe("PORTFOLIO_GROUP_KEYS", () => {
  test("lists the three grouping axes, direction first (default)", () => {
    expect(PORTFOLIO_GROUP_KEYS).toEqual(["direction", "rung", "instrument"]);
  });
});
