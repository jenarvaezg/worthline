import type {
  ContributionAllowance,
  ContributionAllowanceUsage,
  InvestmentOperation,
  ManualAsset,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  contributionAllowanceDestinationOptions,
  contributionAllowanceOperations,
  contributionAllowanceRowView,
  withDerivedAllowanceDestinations,
} from "./contribution-allowance-view";

const allowance: ContributionAllowance = {
  annualCapMinor: 150_000,
  holdingIds: ["pp1"],
  id: "cupo-1",
  label: "Planes de pensiones",
  scopeId: "household",
};

function usage(
  overrides: Partial<ContributionAllowanceUsage>,
): ContributionAllowanceUsage {
  const consumedMinor = overrides.consumedMinor ?? 0;
  const capMinor = overrides.capMinor ?? 150_000;
  return {
    allowanceId: "cupo-1",
    capMinor,
    consumedMinor,
    consumedRatio: capMinor > 0 ? consumedMinor / capMinor : null,
    entries: [],
    exceeded: consumedMinor > capMinor,
    remainingMinor: capMinor - consumedMinor,
    skippedForeignCount: 0,
    year: 2026,
    ...overrides,
  };
}

const names = new Map([
  ["pp1", "MyInvestor Value PP"],
  ["pp2", "Plan de empleo"],
]);

describe("contributionAllowanceRowView", () => {
  test("prints what is left while there is room", () => {
    const view = contributionAllowanceRowView({
      allowance,
      holdingNameById: names,
      usage: usage({ consumedMinor: 130_000 }),
    });

    expect(view.remainderWord).toBe("quedan");
    expect(view.remainderAmountMinor).toBe(20_000);
    expect(view.tone).toBe("ok");
    expect(view.barPercent).toBeCloseTo(86.666, 2);
  });

  test("no inventa un umbral de «casi»: hasta pasarse, el tono es el mismo", () => {
    // #1427 difiere el aviso al pasarse a salud de datos (PRD #654). Un tercer tono
    // al 90 % sería una cifra que nadie declaró, y el color a solas no dice nada:
    // la línea impresa es la que lleva la verdad.
    const view = contributionAllowanceRowView({
      allowance,
      holdingNameById: names,
      usage: usage({ consumedMinor: 149_999 }),
    });

    expect(view.tone).toBe("ok");
    expect(view.remainderWord).toBe("quedan");
  });

  test("carries the allowance and its entries, so the panel resolves nothing itself", () => {
    const entries = [
      {
        amountMinor: 130_000,
        dateISO: "2026-02-10",
        holdingId: "pp1",
        operationId: "op-1",
      },
    ];
    const view = contributionAllowanceRowView({
      allowance,
      holdingNameById: names,
      usage: usage({ consumedMinor: 130_000, entries }),
    });

    expect(view.allowance).toBe(allowance);
    expect(view.entries).toBe(entries);
  });

  test("an exceeded cupo prints the overshoot as a positive amount", () => {
    const view = contributionAllowanceRowView({
      allowance,
      holdingNameById: names,
      usage: usage({ consumedMinor: 180_000 }),
    });

    expect(view.tone).toBe("exceeded");
    expect(view.remainderWord).toBe("excedido");
    expect(view.remainderAmountMinor).toBe(30_000);
    expect(view.remainingMinor).toBe(-30_000);
  });

  test("an overshoot fills the bar instead of overflowing it", () => {
    const view = contributionAllowanceRowView({
      allowance,
      holdingNameById: names,
      usage: usage({ consumedMinor: 450_000 }),
    });

    expect(view.barPercent).toBe(100);
  });

  test("names every destination and counts the ones it cannot see", () => {
    const view = contributionAllowanceRowView({
      allowance: { ...allowance, holdingIds: ["pp1", "pp2", "fantasma"] },
      holdingNameById: names,
      usage: usage({ consumedMinor: 0 }),
    });

    expect(view.destinationNames).toEqual(["MyInvestor Value PP", "Plan de empleo"]);
    expect(view.unknownDestinationCount).toBe(1);
  });

  test("carries the foreign-currency count through untouched (#1401)", () => {
    const view = contributionAllowanceRowView({
      allowance,
      holdingNameById: names,
      usage: usage({ consumedMinor: 0, skippedForeignCount: 2 }),
    });

    expect(view.skippedForeignCount).toBe(2);
  });
});

describe("contributionAllowanceDestinationOptions", () => {
  test("offers only pension plans, not every holding with a ledger (#1567)", () => {
    const assets = [
      {
        id: "pp1",
        instrument: "pension_plan",
        isPrimaryResidence: false,
        name: "PP",
        type: "investment",
      },
      {
        id: "etf",
        instrument: "etf",
        isPrimaryResidence: false,
        name: "World",
        type: "investment",
      },
      { id: "cc", isPrimaryResidence: false, name: "Cuenta", type: "cash" },
    ] as unknown as ManualAsset[];

    expect(contributionAllowanceDestinationOptions(assets).map((a) => a.id)).toEqual([
      "pp1",
    ]);
  });

  test("offers only pension plans with an operation ledger", () => {
    const assets = [
      {
        id: "pp1",
        instrument: "pension_plan",
        isPrimaryResidence: false,
        name: "PP",
        type: "investment",
      },
      { id: "cc", isPrimaryResidence: false, name: "Cuenta", type: "cash" },
      { id: "piso", isPrimaryResidence: false, name: "Piso", type: "real_estate" },
    ] as unknown as ManualAsset[];

    expect(contributionAllowanceDestinationOptions(assets).map((a) => a.id)).toEqual([
      "pp1",
    ]);
  });

  test("deja fuera un holding de fuente conectada: se valora por posiciones, no por operaciones", () => {
    const assets = [
      {
        connectedSourceId: "src_binance",
        id: "binance",
        isPrimaryResidence: false,
        name: "Binance",
        type: "investment",
      },
    ] as unknown as ManualAsset[];

    expect(contributionAllowanceDestinationOptions(assets)).toEqual([]);
  });
});

describe("withDerivedAllowanceDestinations — el instrumento manda, no el join (#1567)", () => {
  const pp = (id: string) =>
    ({
      id,
      instrument: "pension_plan",
      isPrimaryResidence: false,
      name: id,
      type: "investment",
    }) as unknown as ManualAsset;

  test("un plan nuevo cuenta aunque el cupo se guardara sin él", () => {
    expect(
      withDerivedAllowanceDestinations(allowance, [
        pp("pp1"),
        pp("pp-nuevo"),
        {
          id: "etf",
          instrument: "etf",
          isPrimaryResidence: false,
          name: "World",
          type: "investment",
        } as unknown as ManualAsset,
      ]).holdingIds,
    ).toEqual(["pp1", "pp-nuevo"]);
  });

  test("un ETF marcado en el snapshot deja de contar si sigue vivo", () => {
    expect(
      withDerivedAllowanceDestinations({ ...allowance, holdingIds: ["pp1", "etf"] }, [
        pp("pp1"),
        {
          id: "etf",
          instrument: "etf",
          isPrimaryResidence: false,
          name: "World",
          type: "investment",
        } as unknown as ManualAsset,
      ]).holdingIds,
    ).toEqual(["pp1"]);
  });

  test("un plan en la papelera sigue contando si es un PP (#1509)", () => {
    expect(
      withDerivedAllowanceDestinations(allowance, [pp("pp1"), pp("borrado")]).holdingIds,
    ).toEqual(["pp1", "borrado"]);
  });

  test("un ETF en la papelera no cuenta, aunque el snapshot lo marcara (#1567)", () => {
    expect(
      withDerivedAllowanceDestinations(
        { ...allowance, holdingIds: ["pp1", "etf-borrado"] },
        [
          pp("pp1"),
          {
            id: "etf-borrado",
            instrument: "etf",
            isPrimaryResidence: false,
            name: "World",
            type: "investment",
          } as unknown as ManualAsset,
        ],
      ).holdingIds,
    ).toEqual(["pp1"]);
  });
});

describe("contributionAllowanceOperations — un destino en la papelera sigue contando (#1509)", () => {
  const op = (
    assetId: string,
    id: string,
    kind: InvestmentOperation["kind"] = "buy",
  ): InvestmentOperation =>
    ({
      assetId,
      currency: "EUR",
      executedAt: "2026-05-05",
      feesMinor: 0,
      id,
      kind,
      pricePerUnit: "10",
      units: "15",
    }) as InvestmentOperation;

  test("añade las operaciones del destino marcado que ya no está vivo", () => {
    // El caso real: un PP traspasado se vacía y se manda a la papelera, y sus
    // aportaciones de este año siguen habiendo consumido cupo.
    const operations = contributionAllowanceOperations({
      allowances: [{ ...allowance, holdingIds: ["pp1", "borrado"] }],
      liveHoldingIds: new Set(["pp1"]),
      liveOperations: [op("pp1", "o1")],
      operationsByAsset: new Map([
        ["pp1", [op("pp1", "o1")]],
        ["borrado", [op("borrado", "o2"), op("borrado", "o3")]],
      ]),
    });

    expect(operations.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
  });

  test("no duplica un destino que sí está vivo", () => {
    const operations = contributionAllowanceOperations({
      allowances: [allowance],
      liveHoldingIds: new Set(["pp1"]),
      liveOperations: [op("pp1", "o1")],
      operationsByAsset: new Map([["pp1", [op("pp1", "o1")]]]),
    });

    expect(operations.map((o) => o.id)).toEqual(["o1"]);
  });

  test("ignora un holding borrado que ningún cupo marca", () => {
    const operations = contributionAllowanceOperations({
      allowances: [allowance],
      liveHoldingIds: new Set(["pp1"]),
      liveOperations: [op("pp1", "o1")],
      operationsByAsset: new Map([
        ["pp1", [op("pp1", "o1")]],
        ["otro-borrado", [op("otro-borrado", "o9")]],
      ]),
    });

    expect(operations.map((o) => o.id)).toEqual(["o1"]);
  });

  test("sin cupos no añade nada", () => {
    const operations = contributionAllowanceOperations({
      allowances: [],
      liveHoldingIds: new Set(["pp1"]),
      liveOperations: [op("pp1", "o1")],
      operationsByAsset: new Map([["borrado", [op("borrado", "o2")]]]),
    });

    expect(operations.map((o) => o.id)).toEqual(["o1"]);
  });

  test("un destino marcado sin operación ninguna no rompe nada", () => {
    const operations = contributionAllowanceOperations({
      allowances: [{ ...allowance, holdingIds: ["pp1", "fantasma"] }],
      liveHoldingIds: new Set(["pp1"]),
      liveOperations: [op("pp1", "o1")],
      operationsByAsset: new Map([["pp1", [op("pp1", "o1")]]]),
    });

    expect(operations.map((o) => o.id)).toEqual(["o1"]);
  });
});

describe("un destino en la papelera se nombra, no se cuenta como invisible (#1509)", () => {
  const withTrash = new Map([...names, ["borrado", "Planes traspasados"]]);

  test("deja de contar como destino no visto y dice que está en la papelera", () => {
    const view = contributionAllowanceRowView({
      allowance: { ...allowance, holdingIds: ["pp1", "borrado"] },
      holdingNameById: withTrash,
      trashedHoldingIds: new Set(["borrado"]),
      usage: usage({ consumedMinor: 130_000 }),
    });

    expect(view.unknownDestinationCount).toBe(0);
    expect(view.destinationNames).toEqual([
      "MyInvestor Value PP",
      "Planes traspasados (en la papelera)",
    ]);
  });

  test("un asset_id que no existe en absoluto SIGUE contando como no visto", () => {
    const view = contributionAllowanceRowView({
      allowance: { ...allowance, holdingIds: ["pp1", "fantasma"] },
      holdingNameById: withTrash,
      trashedHoldingIds: new Set(["borrado"]),
      usage: usage({ consumedMinor: 0 }),
    });

    expect(view.unknownDestinationCount).toBe(1);
    expect(view.destinationNames).toEqual(["MyInvestor Value PP"]);
  });

  test("sin papelera se comporta igual que antes", () => {
    const view = contributionAllowanceRowView({
      allowance: { ...allowance, holdingIds: ["pp1", "pp2"] },
      holdingNameById: names,
      usage: usage({ consumedMinor: 0 }),
    });

    expect(view.unknownDestinationCount).toBe(0);
    expect(view.destinationNames).toEqual(["MyInvestor Value PP", "Plan de empleo"]);
  });
});
