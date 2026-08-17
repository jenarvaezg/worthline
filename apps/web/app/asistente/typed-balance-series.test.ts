/**
 * The series the user TYPED, read by worthline itself (#1418). The point of these
 * tests is that every acceptance is deterministic and every ambiguity FAILS CLOSED:
 * this parser is what reopens a bulk-import lane the evidence gate closed, so a
 * column it guessed wrong would be a write nobody validated.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  MIN_TYPED_BALANCE_SERIES_ROWS,
  parseTypedBalanceSeries,
  typedBalanceSeriesInTurn,
} from "./typed-balance-series";

function userMessage(text: string): UIMessage {
  return { id: "u1", parts: [{ text, type: "text" }], role: "user" };
}

describe("parseTypedBalanceSeries (#1418)", () => {
  it("reads a plain «fecha saldo» series in Spanish notation", () => {
    expect(
      parseTypedBalanceSeries(
        ["01/10/2025 198.456,78", "01/11/2025 197.900,12", "01/12/2025 197.340,55"].join(
          "\n",
        ),
      ),
    ).toEqual([
      { balanceMinor: 19845678, date: "2025-10-01" },
      { balanceMinor: 19790012, date: "2025-11-01" },
      { balanceMinor: 19734055, date: "2025-12-01" },
    ]);
  });

  it("reads ISO dates and a currency symbol", () => {
    expect(
      parseTypedBalanceSeries("2025-10-01\t198456,78 €\n2025-11-01\t197900,12 €"),
    ).toEqual([
      { balanceMinor: 19845678, date: "2025-10-01" },
      { balanceMinor: 19790012, date: "2025-11-01" },
    ]);
  });

  it("picks the column that behaves like a balance out of a pasted table", () => {
    // Nº · fecha · cuota · intereses · capital · saldo — the ordinary amortization row.
    const series = parseTypedBalanceSeries(
      [
        "Nº Fecha Cuota Intereses Capital Saldo",
        "1 01/10/2025 850,00 320,15 529,85 198.456,78",
        "2 01/11/2025 850,00 318,90 531,10 197.925,68",
        "3 01/12/2025 850,00 317,64 532,36 197.393,32",
      ].join("\n"),
    );
    expect(series.map((row) => row.balanceMinor)).toEqual([19845678, 19792568, 19739332]);
  });

  it("keeps the balance column when it is not the last one", () => {
    const series = parseTypedBalanceSeries(
      [
        "01/10/2025 198.456,78 850,00 2,50%",
        "01/11/2025 197.925,68 850,00 2,50%",
        "01/12/2025 197.393,32 850,00 2,50%",
      ].join("\n"),
    );
    expect(series.map((row) => row.balanceMinor)).toEqual([19845678, 19792568, 19739332]);
  });

  it("tolerates a carencia — a balance that holds flat for a month", () => {
    const series = parseTypedBalanceSeries(
      ["01/10/2025 198.456,78", "01/11/2025 198.456,78", "01/12/2025 197.925,68"].join(
        "\n",
      ),
    );
    expect(series).toHaveLength(3);
  });

  it("reads a debt written with a negative sign as its magnitude", () => {
    expect(
      parseTypedBalanceSeries("01/10/2025 -198.456,78\n01/11/2025 -197.925,68"),
    ).toEqual([
      { balanceMinor: 19845678, date: "2025-10-01" },
      { balanceMinor: 19792568, date: "2025-11-01" },
    ]);
  });

  it("sorts the series when the paste is reverse-chronological", () => {
    expect(
      parseTypedBalanceSeries("01/12/2025 197.393,32\n01/10/2025 198.456,78"),
    ).toEqual([
      { balanceMinor: 19845678, date: "2025-10-01" },
      { balanceMinor: 19739332, date: "2025-12-01" },
    ]);
  });

  it("ignores prose around the series", () => {
    const series = parseTypedBalanceSeries(
      [
        "Te paso los saldos de la hipoteca, que no me deja subir el archivo:",
        "01/10/2025 198.456,78",
        "01/11/2025 197.925,68",
        "Y eso es todo, dime si falta algo.",
      ].join("\n"),
    );
    expect(series).toHaveLength(2);
  });

  it("finds nothing when no column goes down", () => {
    expect(
      parseTypedBalanceSeries("01/10/2025 850,00\n01/11/2025 850,00\n01/12/2025 850,00"),
    ).toEqual([]);
  });

  it("finds nothing when the rows do not have the same shape", () => {
    expect(
      parseTypedBalanceSeries(
        ["01/10/2025 850,00 198.456,78", "01/11/2025 197.925,68"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("finds nothing when a date repeats — the series would be ambiguous", () => {
    expect(
      parseTypedBalanceSeries("01/10/2025 198.456,78\n01/10/2025 197.925,68"),
    ).toEqual([]);
  });

  it("refuses a single observation: one figure is not a series", () => {
    expect(MIN_TYPED_BALANCE_SERIES_ROWS).toBe(2);
    expect(parseTypedBalanceSeries("01/10/2025 198.456,78")).toEqual([]);
  });

  it("refuses an impossible date instead of shifting it", () => {
    expect(
      parseTypedBalanceSeries("31/02/2025 198.456,78\n01/03/2025 197.925,68"),
    ).toEqual([]);
  });

  it("refuses a series longer than the document contract admits", () => {
    const lines = Array.from({ length: 501 }, (_, index) => {
      const day = String((index % 28) + 1).padStart(2, "0");
      const month = String((index % 12) + 1).padStart(2, "0");
      const year = 2000 + Math.floor(index / 12);
      return `${day}/${month}/${year} ${(600000 - index).toString()},00`;
    });
    expect(parseTypedBalanceSeries(lines.join("\n"))).toEqual([]);
    expect(parseTypedBalanceSeries(lines.slice(0, 500).join("\n"))).toHaveLength(500);
  });

  it("finds nothing in an empty message", () => {
    expect(parseTypedBalanceSeries("")).toEqual([]);
  });
});

describe("typedBalanceSeriesInTurn (#1418)", () => {
  it("reads only the LAST user message — the series has to be typed in this turn", () => {
    const series = typedBalanceSeriesInTurn([
      userMessage("01/10/2025 198.456,78\n01/11/2025 197.925,68"),
      { id: "a1", parts: [{ text: "Entendido.", type: "text" }], role: "assistant" },
      userMessage("01/03/2026 190.000,00\n01/04/2026 189.000,00"),
    ]);
    expect(series).toEqual([
      { balanceMinor: 19000000, date: "2026-03-01" },
      { balanceMinor: 18900000, date: "2026-04-01" },
    ]);
  });

  it("ignores a series the ASSISTANT wrote", () => {
    expect(
      typedBalanceSeriesInTurn([
        userComposedTurn(),
        {
          id: "a1",
          parts: [{ text: "01/10/2025 198.456,78\n01/11/2025 197.925,68", type: "text" }],
          role: "assistant",
        },
      ]),
    ).toEqual([]);
  });

  it("finds nothing when there is no user message at all", () => {
    expect(typedBalanceSeriesInTurn([])).toEqual([]);
  });
});

function userComposedTurn(): UIMessage {
  return userMessage("¿Puedes con esto?");
}
