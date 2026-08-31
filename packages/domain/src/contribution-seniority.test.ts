import { describe, expect, it } from "vitest";
import { readLedgerSeniority } from "./contribution-seniority";
import type { InvestmentOperation } from "./investment-types";

function op(overrides: Partial<InvestmentOperation>): InvestmentOperation {
  return {
    id: overrides.id ?? "op",
    assetId: "pp",
    kind: "buy",
    executedAt: "2014-03-01",
    units: "1",
    pricePerUnit: "4000",
    currency: "EUR",
    feesMinor: 0,
    ...overrides,
  };
}

describe("readLedgerSeniority (#1687)", () => {
  it("fecha una aportación real por el día en que se hizo", () => {
    const report = readLedgerSeniority([
      op({ executedAt: "2014-03-01", id: "a", pricePerUnit: "4000" }),
      op({ executedAt: "2022-06-15", id: "b", pricePerUnit: "1500" }),
    ]);

    expect(report.entries).toEqual([
      { amountMinor: 400_000, seniorityAt: "2014-03-01" },
      { amountMinor: 150_000, seniorityAt: "2022-06-15" },
    ]);
    expect(report.gaps).toEqual([]);
  });

  it("ordena de antes a después, sea cual sea el orden del libro", () => {
    const report = readLedgerSeniority([
      op({ executedAt: "2022-06-15", id: "b" }),
      op({ executedAt: "2014-03-01", id: "a" }),
    ]);

    expect(report.entries.map((entry) => entry.seniorityAt)).toEqual([
      "2014-03-01",
      "2022-06-15",
    ]);
  });

  // La regla de #1518: una movilización conserva la antigüedad de las aportaciones que
  // la generaron, y `executedAt` es el día en que aterrizó el trámite.
  it("una movilización con antigüedad declarada se fecha por ella, nunca por la fila", () => {
    const report = readLedgerSeniority([
      op({
        executedAt: "2025-12-05",
        id: "mov",
        kind: "transfer_in",
        transferCostMinor: 497_955,
        transferSeniorityAt: "2014-03-01",
      }),
    ]);

    expect(report.entries).toEqual([{ amountMinor: 497_955, seniorityAt: "2014-03-01" }]);
  });

  // El caso de la cartera real: dos movilizaciones mudas y ninguna aportación propia.
  it("una movilización sin antigüedad no se fecha, y el hueco sale con nombre", () => {
    const report = readLedgerSeniority([
      op({
        executedAt: "2025-12-05",
        id: "mov",
        kind: "transfer_in",
        transferCostMinor: 497_955,
      }),
    ]);

    expect(report.entries).toEqual([]);
    expect(report.gaps).toEqual([
      { amountMinor: 497_955, reason: "transfer_without_seniority" },
    ]);
  });

  // Una apertura fabrica fecha y precio para poder abrir la posición (#1490).
  it("una apertura no es una aportación: no se fecha y se dice", () => {
    const report = readLedgerSeniority([
      op({ executedAt: "2025-01-01", id: "ap", source: "opening" }),
    ]);

    expect(report.entries).toEqual([]);
    expect(report.gaps).toEqual([{ amountMinor: 400_000, reason: "opening" }]);
  });

  it("suma los huecos de la misma razón en vez de repetir la razón", () => {
    const report = readLedgerSeniority([
      op({
        executedAt: "2025-12-05",
        id: "m1",
        kind: "transfer_in",
        transferCostMinor: 497_955,
      }),
      op({
        executedAt: "2026-01-23",
        id: "m2",
        kind: "transfer_in",
        transferCostMinor: 9_546,
      }),
    ]);

    expect(report.gaps).toEqual([
      { amountMinor: 507_501, reason: "transfer_without_seniority" },
    ]);
  });

  // El libro no dice de qué aportación salió el dinero, y repartirlo por FIFO
  // inventaría descuadres: el coste aquí es medio, y este reparto es de liquidez.
  it("una salida no resta de ningún tramo", () => {
    const report = readLedgerSeniority([
      op({ executedAt: "2014-03-01", id: "a" }),
      op({ executedAt: "2024-01-01", id: "s", kind: "sell", pricePerUnit: "1000" }),
      op({
        executedAt: "2024-02-01",
        id: "t",
        kind: "transfer_out",
        pricePerUnit: "500",
      }),
    ]);

    expect(report.entries).toEqual([{ amountMinor: 400_000, seniorityAt: "2014-03-01" }]);
    expect(report.gaps).toEqual([]);
  });

  it("un libro vacío no propone nada y tampoco inventa huecos", () => {
    expect(readLedgerSeniority([])).toEqual({ entries: [], gaps: [] });
  });

  it("mezcla aportaciones propias con una movilización fechada", () => {
    const report = readLedgerSeniority([
      op({ executedAt: "2016-05-01", id: "a", pricePerUnit: "2000" }),
      op({
        executedAt: "2025-12-05",
        id: "mov",
        kind: "transfer_in",
        transferCostMinor: 497_955,
        transferSeniorityAt: "2014-03-01",
      }),
      op({ executedAt: "2025-01-10", id: "ap", source: "opening", pricePerUnit: "300" }),
    ]);

    expect(report.entries).toEqual([
      { amountMinor: 497_955, seniorityAt: "2014-03-01" },
      { amountMinor: 200_000, seniorityAt: "2016-05-01" },
    ]);
    expect(report.gaps).toEqual([{ amountMinor: 30_000, reason: "opening" }]);
  });
});
