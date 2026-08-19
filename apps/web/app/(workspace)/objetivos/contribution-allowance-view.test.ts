import type {
  ContributionAllowance,
  ContributionAllowanceUsage,
  ManualAsset,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  contributionAllowanceDestinationOptions,
  contributionAllowanceRowView,
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
  test("offers only holdings with an operation ledger", () => {
    const assets = [
      { id: "pp1", isPrimaryResidence: false, name: "PP", type: "investment" },
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
