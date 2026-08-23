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

  test("every holding carries its id and a direction discriminant", () => {
    for (const group of groups) {
      for (const h of group.holdings) {
        // No ficha href here on purpose (#1318): the web layer builds it from the
        // holding's public `wl_hld_…` id, the only id that may appear in a URL.
        expect(h.id).not.toBe("");
        expect(h.direction === "asset" || h.direction === "liability").toBe(true);
      }
    }
  });
});

// ── rung ───────────────────────────────────────────────────────────────────────

describe("groupPortfolio — by rung", () => {
  const groups = groupPortfolio(projection, "rung");

  test("groups follow ladder order and only non-empty rungs appear", () => {
    // Housing is the last rung now (ADR 0022); the home + mortgage land there.
    expect(groups.map((g) => g.label)).toEqual(["Caja", "Mercado", "Vivienda"]);
  });

  test("the market rung holds the investment; housing holds home + its mortgage", () => {
    const market = groups.find((g) => g.key === "market")!;
    expect(market.holdings.map((h) => h.id)).toEqual(["asset_broker"]);
    const housing = groups.find((g) => g.key === "housing")!;
    expect(housing.holdings.map((h) => h.id).sort()).toEqual(
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

// ── signed group totals (#154 review) ────────────────────────────────────────
// The per-group header figure nets two row types into one signed total: an asset
// ADDS its value, a liability SUBTRACTS its balance. This is the only net-of-mixed
// -holdings figure on /patrimonio; pin the sign convention so a flipped sign,
// dropped contribution, or double-count can never pass green.

describe("groupPortfolio — signed group totals", () => {
  test("a liability subtracts: the Pasivos group total is negative", () => {
    const groups = groupPortfolio(projection, "direction");
    const pasivos = groups.find((g) => g.key === "liabilities")!;
    expect(pasivos.totalMinor.amountMinor).toBe(-18_000_000);
  });

  test("a mixed rung group nets asset value minus liability balance", () => {
    const groups = groupPortfolio(projection, "rung");
    // the mortgage is associated to the home → both land on the illiquid rung
    const illiquid = groups.find((g) =>
      g.holdings.some((h) => h.id === "debt_mortgage"),
    )!;
    expect(illiquid.holdings.map((h) => h.id).sort()).toEqual([
      "asset_home",
      "debt_mortgage",
    ]);
    // 30_000_000 (home, stored) − 18_000_000 (mortgage balance)
    expect(illiquid.totalMinor.amountMinor).toBe(12_000_000);
  });

  test("every grouping conserves the net and lists each holding exactly once", () => {
    const ALL_IDS = ["asset_broker", "asset_cash", "asset_home", "debt_mortgage"];
    // Net derived from the default grouping so the assertion is robust to how an
    // investment's value is computed; every axis must agree on the same total and
    // partition the same rows (no drop, no double-count).
    const net = groupPortfolio(projection, "direction").reduce(
      (acc, g) => acc + g.totalMinor.amountMinor,
      0,
    );
    for (const key of PORTFOLIO_GROUP_KEYS) {
      const groups = groupPortfolio(projection, key);
      expect(groups.reduce((acc, g) => acc + g.totalMinor.amountMinor, 0)).toBe(net);
      expect(groups.flatMap((g) => g.holdings.map((h) => h.id)).sort()).toEqual(ALL_IDS);
    }
  });
});

// ── managed portfolios as summands (#1548, ADR 0085) ─────────────────────────

/**
 * Jorge's Cartera Indexada Metal in miniature: funds of different sizes plus
 * the container's cash sibling, so the dominance rules have something to
 * choose between and the cash rung has a chance to leak.
 */
const metalFundBig = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 58_998,
  id: "asset_metal_us",
  instrument: "fund",
  liquidityTier: "market",
  name: "iShares US Equity Index S",
  ownership: own,
  type: "investment",
});

const metalFundSmall = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 3_977,
  id: "asset_metal_pacific",
  instrument: "fund",
  liquidityTier: "market",
  name: "Fidelity MSCI Pacific ex-Japan",
  ownership: own,
  type: "investment",
});

const metalCash = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 734,
  id: "asset_metal_cash",
  instrument: "current_account",
  liquidityTier: "cash",
  name: "Efectivo de la cartera",
  ownership: own,
  type: "investment",
});

const metal = {
  holdingIds: ["asset_metal_us", "asset_metal_pacific", "asset_metal_cash"],
  id: "mp_metal",
  name: "Cartera Indexada Metal",
  provider: "MyInvestor",
};

const withMetal = projectPortfolio({
  assets: [cash, broker, metalFundBig, metalFundSmall, metalCash, home],
  liabilities: [mortgage],
  scope: { id: "household", label: "Hogar", type: "household" },
  workspace,
});

const metalTotal = 58_998 + 3_977 + 734;

describe("groupPortfolio — a managed portfolio is one summand", () => {
  const groups = groupPortfolio(withMetal, "direction", [metal]);
  const assets = groups.find((g) => g.key === "assets")!;

  test("the portfolio renders as a single unit, not as its members", () => {
    const portfolios = assets.units.filter((u) => u.kind === "portfolio");
    expect(portfolios).toHaveLength(1);
    expect(portfolios[0]!.key).toBe("mp_metal");
    expect(assets.units.map((u) => u.key)).not.toContain("asset_metal_us");
  });

  test("the block's value is the sum of its members", () => {
    const block = assets.units.find((u) => u.kind === "portfolio")!;
    expect(block.signedMinor).toBe(metalTotal);
  });

  test("members stay in `holdings`, so the group's total is unchanged", () => {
    expect(assets.holdings.map((h) => h.id)).toContain("asset_metal_us");
    const withoutGrouping = groupPortfolio(withMetal, "direction");
    expect(assets.totalMinor.amountMinor).toBe(
      withoutGrouping.find((g) => g.key === "assets")!.totalMinor.amountMinor,
    );
  });

  test("Σ summands = the group total, on every axis", () => {
    for (const key of PORTFOLIO_GROUP_KEYS) {
      for (const group of groupPortfolio(withMetal, key, [metal])) {
        const sum = group.units.reduce((acc, u) => acc + u.signedMinor, 0);
        expect(sum).toBe(group.totalMinor.amountMinor);
      }
    }
  });

  test("members are ordered largest first", () => {
    const block = assets.units.find((u) => u.kind === "portfolio")!;
    expect(block.kind === "portfolio" && block.members.map((m) => m.id)).toEqual([
      "asset_metal_us",
      "asset_metal_pacific",
      "asset_metal_cash",
    ]);
  });
});

describe("groupPortfolio — the portfolio rules over the axes", () => {
  test("Instrumento: the block inherits its dominant instrument, undivided", () => {
    const groups = groupPortfolio(withMetal, "instrument", [metal]);
    const funds = groups.find((g) => g.key === "fund")!;
    // The loose Broker and the Metal block — never the Metal's own funds.
    expect(funds.units.map((u) => u.key).sort()).toEqual(["asset_broker", "mp_metal"]);
  });

  test("Instrumento: the container's cash does not leak into Cuenta corriente", () => {
    const groups = groupPortfolio(withMetal, "instrument", [metal]);
    const currentAccounts = groups.find((g) => g.key === "current_account");
    expect(currentAccounts?.units.map((u) => u.key) ?? []).not.toContain(
      "asset_metal_cash",
    );
  });

  test("Liquidez: the block sits on its dominant rung, not on its members'", () => {
    const groups = groupPortfolio(withMetal, "rung", [metal]);
    expect(groups.find((g) => g.key === "market")!.units.map((u) => u.key)).toContain(
      "mp_metal",
    );
    expect(groups.find((g) => g.key === "cash")!.units.map((u) => u.key)).not.toContain(
      "asset_metal_cash",
    );
  });

  test("the net worth is the same with and without the grouping", () => {
    for (const key of PORTFOLIO_GROUP_KEYS) {
      const net = (portfolios: (typeof metal)[]) =>
        groupPortfolio(withMetal, key, portfolios).reduce(
          (acc, g) => acc + g.totalMinor.amountMinor,
          0,
        );
      expect(net([metal])).toBe(net([]));
    }
  });
});

describe("groupPortfolio — portfolios with nobody present", () => {
  test("a portfolio whose members are absent produces no summand", () => {
    const groups = groupPortfolio(withMetal, "direction", [
      { holdingIds: ["asset_gone"], id: "mp_empty", name: "Vacía", provider: null },
    ]);
    expect(groups.flatMap((g) => g.units).map((u) => u.key)).not.toContain("mp_empty");
  });

  test("a portfolio built from whoever IS present quotes only them", () => {
    const groups = groupPortfolio(withMetal, "direction", [
      { ...metal, holdingIds: ["asset_metal_us", "asset_not_in_this_scope"] },
    ]);
    const block = groups.flatMap((g) => g.units).find((u) => u.key === "mp_metal")!;
    expect(block.signedMinor).toBe(58_998);
  });
});
