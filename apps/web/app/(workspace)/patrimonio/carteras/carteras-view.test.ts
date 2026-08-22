import type { ManualAsset } from "@worthline/domain";
import { describe, expect, it, test } from "vitest";
import {
  managedPortfolioMemberOptions,
  portfolioCompositionView,
  portfolioListRowView,
} from "./carteras-view";

const asset = (overrides: Partial<ManualAsset> & { id: string }): ManualAsset => ({
  currency: "EUR",
  currentValue: { amountMinor: 100_00, currency: "EUR" },
  instrument: "fund",
  isPrimaryResidence: false,
  liquidityTier: "market",
  name: overrides.id,
  ownership: [],
  type: "investment",
  ...(overrides.connectedSourceId === undefined
    ? {}
    : { connectedSourceId: overrides.connectedSourceId }),
  ...overrides,
});

describe("managedPortfolioMemberOptions", () => {
  const cash = asset({ id: "cash", instrument: "current_account", type: "cash" });
  const fund = asset({ id: "fund" });
  const synced = asset({ id: "synced", connectedSourceId: "src1" });

  it("offers only live manual investments", () => {
    expect(
      managedPortfolioMemberOptions({
        assets: [cash, fund, synced],
        memberIdsByPortfolio: new Map(),
        portfolioId: undefined,
      }),
    ).toEqual([fund]);
  });

  it("keeps the edited portfolio's own members offered even when taken", () => {
    expect(
      managedPortfolioMemberOptions({
        assets: [fund, synced],
        memberIdsByPortfolio: new Map([["p1", new Set(["fund"])]]),
        portfolioId: "p1",
      }),
    ).toEqual([fund]);
  });

  it("hides a holding that belongs to another portfolio — membership is exclusive", () => {
    expect(
      managedPortfolioMemberOptions({
        assets: [fund],
        memberIdsByPortfolio: new Map([["other", new Set(["fund"])]]),
        portfolioId: "p1",
      }),
    ).toEqual([]);
  });
});

describe("portfolioListRowView", () => {
  it("sums member values into the row's derived total and counts them", () => {
    const row = portfolioListRowView({
      portfolio: {
        holdingIds: ["f1", "cash"],
        id: "p1",
        name: "Metal",
        provider: "MyInvestor",
        scopeId: "household",
      },
      valueMinorByHoldingId: new Map([
        ["f1", 600_00],
        ["cash", 7_34],
      ]),
    });

    expect(row).toEqual({
      href: null,
      id: "p1",
      memberCount: 2,
      name: "Metal",
      provider: "MyInvestor",
      totalMinor: 607_34,
    });
  });

  it("carries the ficha link when the registry knows the portfolio", () => {
    const row = portfolioListRowView({
      publicIdByPortfolio: { p1: "wl_prt_abc" },
      portfolio: {
        holdingIds: [],
        id: "p1",
        name: "Metal",
        provider: null,
        scopeId: "household",
      },
      valueMinorByHoldingId: new Map(),
    });

    expect(row.href).toBe("/patrimonio/carteras/wl_prt_abc");
    expect(row.totalMinor).toBe(0);
    expect(row.provider).toBeNull();
  });
});

describe("portfolioCompositionView", () => {
  const portfolio = {
    holdingIds: ["f1", "cash"],
    id: "p1",
    name: "Metal",
    provider: null,
    scopeId: "household",
  };

  it("derives total, weights and labels, marking the efectivo sibling", () => {
    const view = portfolioCompositionView({
      nameById: new Map([
        ["f1", "Fondo A"],
        ["cash", "Efectivo Metal"],
      ]),
      portfolio,
      typeByHoldingId: new Map([
        ["f1", "investment"],
        ["cash", "cash"],
      ]),
      valueMinorByHoldingId: new Map([
        ["f1", 600_00],
        ["cash", 7_34],
      ]),
    });

    expect(view.totalMinor).toBe(607_34);
    expect(view.unknownMemberIds).toEqual([]);
    expect(view.rows[0]).toEqual({
      holdingId: "f1",
      href: null,
      isCash: false,
      label: "Fondo A",
      valueMinor: 600_00,
      weight: 600_00 / 607_34,
    });
    expect(view.rows[1]?.isCash).toBe(true);
    expect(view.rows[1]?.label).toBe("Efectivo Metal");
  });

  it("links a member's own ficha through the registry", () => {
    const view = portfolioCompositionView({
      nameById: new Map([["f1", "Fondo A"]]),
      portfolio,
      publicIdByHolding: { f1: "wl_hld_f1" },
      typeByHoldingId: new Map(),
      valueMinorByHoldingId: new Map([["f1", 100]]),
    });

    expect(view.rows[0]?.href).toBe("/patrimonio/wl_hld_f1/editar");
  });

  it("names members with no live holding instead of dropping them silently", () => {
    const view = portfolioCompositionView({
      nameById: new Map([["f1", "Fondo A"]]),
      portfolio: { ...portfolio, holdingIds: ["f1", "gone"] },
      typeByHoldingId: new Map(),
      valueMinorByHoldingId: new Map([["f1", 100]]),
    });

    expect(view.unknownMemberIds).toEqual(["gone"]);
    expect(view.rows.map((row) => row.holdingId)).toEqual(["f1"]);
  });
});
