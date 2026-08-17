import { describe, expect, it } from "vitest";

import {
  markProjectedBalances,
  projectedBalancesWarning,
} from "./attachment-balance-projection";
import {
  type AttachmentExtractionResult,
  parseExtractionResult,
} from "./attachment-extraction-contract";

const TODAY = "2026-08-17";

function balanceSeries(
  balances: Array<{ date: string; amount: number }>,
  warnings: string[] = [],
): AttachmentExtractionResult {
  return parseExtractionResult({
    data: {
      balances: balances.map((balance) => ({ ...balance, currency: "EUR" })),
      documentType: "balance_series",
      warnings,
    },
    status: "valid",
  });
}

function balancesOf(result: AttachmentExtractionResult) {
  if (result.status !== "valid" || result.data.documentType !== "balance_series") {
    throw new Error(`Expected a valid balance series, got ${result.status}`);
  }
  return result.data;
}

describe("markProjectedBalances", () => {
  it("marks the rows dated after the turn and leaves the observed ones alone", () => {
    // Los cuatro últimos saldos del cuadro de Jorge: 2026 ya pasó, el resto es lo
    // que el banco proyecta si nada cambia — y el euríbor de 2027 no existe todavía.
    const marked = balancesOf(
      markProjectedBalances(
        balanceSeries([
          { amount: 52857.24, date: "2026-06-01" },
          { amount: 46985.97, date: "2027-06-01" },
          { amount: 14700.72, date: "2032-05-01" },
          { amount: 0, date: "2034-06-01" },
        ]),
        TODAY,
      ),
    );

    expect(marked.balances.map((balance) => balance.projected)).toEqual([
      undefined,
      true,
      true,
      true,
    ]);
  });

  it("says how many rows are a forecast, in the reading's own warnings", () => {
    const marked = balancesOf(
      markProjectedBalances(
        balanceSeries([
          { amount: 52857.24, date: "2026-06-01" },
          { amount: 46985.97, date: "2027-06-01" },
        ]),
        TODAY,
      ),
    );

    expect(marked.warnings[0]).toBe(projectedBalancesWarning(1, 2, TODAY));
    expect(marked.warnings[0]).toContain("1 de los 2 saldos");
  });

  it("keeps the reading's own warnings under the projection notice", () => {
    const marked = balancesOf(
      markProjectedBalances(
        balanceSeries([{ amount: 46985.97, date: "2027-06-01" }], ["Aviso previo."]),
        TODAY,
      ),
    );

    expect(marked.warnings).toEqual([
      projectedBalancesWarning(1, 1, TODAY),
      "Aviso previo.",
    ]);
  });

  it("treats a balance dated today as observed", () => {
    // El corte es «posterior a hoy», no «hoy o después»: la cuota de este mes ya
    // se ha pagado, y excluirla sería tirar la observación más valiosa de todas.
    const marked = balancesOf(
      markProjectedBalances(balanceSeries([{ amount: 52857.24, date: TODAY }]), TODAY),
    );

    expect(marked.balances[0]?.projected).toBeUndefined();
    expect(marked.warnings).toEqual([]);
  });

  it("returns a fully observed series untouched", () => {
    const result = balanceSeries([{ amount: 52857.24, date: "2026-06-01" }]);

    expect(markProjectedBalances(result, TODAY)).toBe(result);
  });

  it("leaves every other document and verdict alone", () => {
    const positions = parseExtractionResult({
      data: {
        documentType: "positions",
        positions: [
          {
            currency: "EUR",
            marketValueEur: 13450.32,
            name: "Vanguard FTSE All-World",
          },
        ],
        warnings: [],
      },
      status: "valid",
    });
    const unrecognized: AttachmentExtractionResult = {
      message: "No reconozco el documento.",
      status: "unrecognized",
    };

    expect(markProjectedBalances(positions, TODAY)).toBe(positions);
    expect(markProjectedBalances(unrecognized, TODAY)).toBe(unrecognized);
  });

  it("does not guess when the turn's date is not a calendar day", () => {
    // Comparar fechas contra basura marcaría todas las filas o ninguna, y ambas
    // mienten. Sin fecha del turno no hay frontera que dibujar: se deja la lectura
    // como estaba, que es lo que un adjunto anterior a #1424 ya significaba.
    const result = balanceSeries([{ amount: 46985.97, date: "2027-06-01" }]);

    expect(markProjectedBalances(result, "")).toBe(result);
    expect(markProjectedBalances(result, "hoy")).toBe(result);
    expect(markProjectedBalances(result, "2026-02-30")).toBe(result);
  });
});

describe("projectedBalancesWarning", () => {
  it("agrees in number with what it counts", () => {
    expect(projectedBalancesWarning(1, 49, TODAY)).toContain("1 de los 49 saldos es");
    expect(projectedBalancesWarning(4, 49, TODAY)).toContain("4 de los 49 saldos son");
  });

  it("fits the contract's per-warning cap", () => {
    expect(projectedBalancesWarning(500, 500, TODAY).length).toBeLessThanOrEqual(300);
  });
});
