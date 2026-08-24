import type { ManualAsset } from "@worthline/domain";
import { describe, expect, it, test } from "vitest";
import {
  managedPortfolioMemberOptions,
  portfolioCompositionView,
  portfolioListRowView,
  portfolioUndetailedView,
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
    /** The currency the FUNDS member is held in — unconverted (#1550). */
    fundsCurrency?: string;
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
      moneyByHoldingId: new Map([
        ...(fundsValue === null
          ? []
          : ([
              [
                "fondos",
                {
                  amountMinor: fundsValue,
                  currency: input.fundsCurrency ?? "EUR",
                },
              ],
            ] as Array<[string, { amountMinor: number; currency: string }]>)),
        ["efectivo", { amountMinor: input.cashMinor ?? 734, currency: "EUR" }],
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

  it("refuses to careo when a member is held in another currency (same rule as the signal)", () => {
    // The ficha converts for the TOTAL, but the careo reads unconverted money:
    // otherwise it would claim a drift the data-health signal cannot see (#1422).
    const result = view({ declaredMinor: DECLARED_MINOR, fundsCurrency: "USD" });

    expect(result.state).toBe("not_comparable");
    expect(result.message).toContain("no está en tu divisa");
  });

  it("says WHY a stored declared balance of zero cannot be careed", () => {
    const result = view({ declaredMinor: 0 });

    expect(result.state).toBe("not_comparable");
    expect(result.message).toContain("no es positivo");
  });

  it("refuses to careo an incomplete derived side", () => {
    const result = view({ declaredMinor: DECLARED_MINOR, fundsValue: null });

    expect(result.state).toBe("not_comparable");
    expect(result.message).toContain("incompleta");
  });
});

describe("portfolioUndetailedView", () => {
  /** The acceptance case of #1551: a 1.000 € "solo saldo" cartera. */
  const DECLARED_MINOR = 1_000_00;

  function view(input: {
    declaredMinor?: number | null;
    /** The aggregate's own value today, or null when there is no aggregate. */
    aggregateMinor: number | null;
    detailedMinor?: number;
  }) {
    const declaredMinor =
      input.declaredMinor === undefined ? DECLARED_MINOR : input.declaredMinor;
    const holdingIds = [
      "efectivo",
      ...(input.aggregateMinor === null ? [] : ["agregado"]),
      ...(input.detailedMinor === undefined ? [] : ["fondo"]),
    ];

    return portfolioUndetailedView({
      baseCurrency: "EUR",
      nameById: new Map([["agregado", "Cartera Indexada Metal (sin detallar)"]]),
      portfolio: {
        holdingIds,
        id: "prt_metal",
        name: "Cartera Indexada Metal",
        provider: "MyInvestor",
        scopeId: "household",
        witness:
          declaredMinor === null
            ? null
            : {
                declaredDate: "2026-08-24",
                declaredValue: { amountMinor: declaredMinor, currency: "EUR" },
              },
      },
      typeByHoldingId: new Map([
        ["efectivo", "cash"],
        ...(input.aggregateMinor === null
          ? []
          : ([["agregado", "manual"]] as Array<[string, string]>)),
        ...(input.detailedMinor === undefined
          ? []
          : ([["fondo", "investment"]] as Array<[string, string]>)),
      ]),
      valueMinorByHoldingId: new Map([
        ["efectivo", 0],
        ...(input.aggregateMinor === null
          ? []
          : ([["agregado", input.aggregateMinor]] as Array<[string, number]>)),
        ...(input.detailedMinor === undefined
          ? []
          : ([["fondo", input.detailedMinor]] as Array<[string, number]>)),
      ]),
    });
  }

  it("is absent for a portfolio registered with its composition", () => {
    expect(view({ aggregateMinor: null, detailedMinor: 400_00 })).toBeNull();
  });

  it("stands for the whole cartera while nothing is detailed", () => {
    const result = view({ aggregateMinor: DECLARED_MINOR })!;

    expect(result.holdingId).toBe("agregado");
    expect(result.valueMinor).toBe(DECLARED_MINOR);
    expect(result.detailedMinor).toBe(0);
    expect(result.remainderMinor).toBe(DECLARED_MINOR);
    expect(result.isSettled).toBe(true);
    expect(result.suggestsWithdrawal).toBe(false);
  });

  it("suggests 600 € once a 400 € fund is detailed — the gross stays at 1.000 €", () => {
    const result = view({ aggregateMinor: DECLARED_MINOR, detailedMinor: 400_00 })!;

    expect(result.detailedMinor).toBe(400_00);
    expect(result.remainderMinor).toBe(600_00);
    expect(result.isSettled).toBe(false);
    expect(result.suggestsWithdrawal).toBe(false);
    expect(result.message).toContain("quedan 600");
  });

  it("the container's cash never enters the subtraction (23-08 note)", () => {
    // Same case as above but with 7,34 € in the cash box: if the cash were
    // subtracted the suggestion would come out 7,34 € short and the gross would
    // drop for no reason.
    const result = portfolioUndetailedView({
      baseCurrency: "EUR",
      nameById: new Map(),
      portfolio: {
        holdingIds: ["efectivo", "agregado", "fondo"],
        id: "prt_metal",
        name: "Metal",
        provider: null,
        scopeId: "household",
        witness: {
          declaredDate: "2026-08-24",
          declaredValue: { amountMinor: DECLARED_MINOR, currency: "EUR" },
        },
      },
      typeByHoldingId: new Map([
        ["efectivo", "cash"],
        ["agregado", "manual"],
        ["fondo", "investment"],
      ]),
      valueMinorByHoldingId: new Map([
        ["efectivo", 734],
        ["agregado", DECLARED_MINOR],
        ["fondo", 400_00],
      ]),
    })!;

    expect(result.remainderMinor).toBe(600_00);
  });

  it("suggests retiring it once the detail covers the declared balance", () => {
    const result = view({ aggregateMinor: 600_00, detailedMinor: 1_200_00 })!;

    expect(result.remainderMinor).toBe(0);
    expect(result.suggestsWithdrawal).toBe(true);
    expect(result.message).toContain("retira");
  });

  it("suggests nothing without a declared balance — it asks for one instead", () => {
    const result = view({ aggregateMinor: 1_000_00, declaredMinor: null })!;

    expect(result.remainderMinor).toBeNull();
    expect(result.suggestsWithdrawal).toBe(false);
    expect(result.isSettled).toBe(false);
    expect(result.message).toContain("saldo declarado");
  });
});
