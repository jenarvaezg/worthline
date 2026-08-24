import type { ManualAsset } from "@worthline/domain";
import { describe, expect, it, test } from "vitest";
import {
  managedPortfolioMemberOptions,
  portfolioCompositionView,
  portfolioListRowView,
  portfolioWitnessView,
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
        witness: null,
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
        witness: null,
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
    witness: null,
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

describe("portfolioWitnessView", () => {
  /** The real Metal: seven funds at 1.479,26 €, 7,34 € in the cash box. */
  const FUNDS_MINOR = 147_926;
  const DECLARED_MINOR = 149_737;

  function view(input: {
    declaredMinor: number | null;
    cashMinor?: number;
    declaredCurrency?: string;
    fundsValue?: number | null;
  }) {
    const fundsValue = input.fundsValue === undefined ? FUNDS_MINOR : input.fundsValue;
    return portfolioWitnessView({
      baseCurrency: "EUR",
      portfolio: {
        holdingIds: ["fondos", "efectivo"],
        id: "prt_metal",
        name: "Cartera Indexada Metal",
        provider: "MyInvestor",
        scopeId: "household",
        witness:
          input.declaredMinor === null
            ? null
            : {
                declaredDate: "2026-08-21",
                declaredValue: {
                  amountMinor: input.declaredMinor,
                  currency: input.declaredCurrency ?? "EUR",
                },
              },
      },
      typeByHoldingId: new Map([
        ["fondos", "investment"],
        ["efectivo", "cash"],
      ]),
      valueMinorByHoldingId: new Map([
        ...(fundsValue === null
          ? []
          : ([["fondos", fundsValue]] as Array<[string, number]>)),
        ["efectivo", input.cashMinor ?? 734],
      ]),
    });
  }

  it("invites a witness when none was declared, without claiming a drift", () => {
    const result = view({ declaredMinor: null });

    expect(result.state).toBe("no_witness");
    expect(result.declaredMinor).toBeNull();
    expect(result.driftLabel).toBeNull();
    expect(result.isDiverged).toBe(false);
    // The three figures still read: funds, cash apart, and the sum.
    expect(result.investmentMinor).toBe(FUNDS_MINOR);
    expect(result.cashMinor).toBe(734);
    expect(result.totalMinor).toBe(FUNDS_MINOR + 734);
  });

  it("reads the real Metal as aligned, careing the FUNDS only", () => {
    const result = view({ declaredMinor: DECLARED_MINOR });

    expect(result.state).toBe("aligned");
    expect(result.driftLabel).toBe("−1,2 %");
    expect(result.declaredDateLabel).toBe("21/08/2026");
    expect(result.message).toContain("Cuadra");
    expect(result.message).toContain("fuera del careo");
  });

  it("stays aligned with the cash box full (~157 €) — the #1550 regression", () => {
    const result = view({ cashMinor: 15_749, declaredMinor: DECLARED_MINOR });

    expect(result.state).toBe("aligned");
    expect(result.driftLabel).toBe("−1,2 %");
    expect(result.cashMinor).toBe(15_749);
  });

  it("warns when the declared balance sits 5 % away from the funds", () => {
    const result = view({ declaredMinor: Math.round(FUNDS_MINOR / 0.95) });

    expect(result.state).toBe("diverged");
    expect(result.isDiverged).toBe(true);
    expect(result.driftLabel).toBe("−5,0 %");
    expect(result.message).toContain("Manda lo que worthline calcula");
  });

  it("says WHY it cannot careo a witness in another currency", () => {
    const result = view({ declaredCurrency: "USD", declaredMinor: DECLARED_MINOR });

    expect(result.state).toBe("not_comparable");
    expect(result.isDiverged).toBe(false);
    expect(result.message).toContain("otra divisa");
  });

  it("refuses to careo an incomplete derived side", () => {
    const result = view({ declaredMinor: DECLARED_MINOR, fundsValue: null });

    expect(result.state).toBe("not_comparable");
    expect(result.message).toContain("incompleta");
  });
});
