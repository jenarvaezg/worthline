/**
 * The series the user TYPED, read by worthline itself (#1418).
 *
 * Two invariants, and the second is the one this ticket exists for. Every acceptance is
 * deterministic and every ambiguity FAILS CLOSED — this parser is what reopens a
 * bulk-import lane the evidence gate closed, so a column it guessed wrong would be a
 * write nobody validated. And every refusal says WHICH refusal it is: «I saw no series»
 * and «I saw one and could not read it» are different things to tell a person, and
 * collapsing them is exactly how Jorge got told to do the work he had just done.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  MIN_TYPED_BALANCE_SERIES_ROWS,
  parseTypedBalanceSeries,
  type TypedBalanceRow,
  typedBalanceSeriesInTurn,
} from "./typed-balance-series";

function userMessage(text: string): UIMessage {
  return { id: "u1", parts: [{ text, type: "text" }], role: "user" };
}

/** The rows a text yields. Fails the test when the reading was not a series. */
function rowsOf(text: string): TypedBalanceRow[] {
  const reading = parseTypedBalanceSeries(text);
  expect(reading.status).toBe("read");
  return reading.status === "read" ? reading.rows : [];
}

function statusOf(text: string): string {
  return parseTypedBalanceSeries(text).status;
}

/** `count` dated lines with unique dates and a strictly falling balance. */
function seriesLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, "0");
    const month = String((index % 12) + 1).padStart(2, "0");
    const year = 2000 + Math.floor(index / 12);
    return `${day}/${month}/${year} ${600000 - index},00`;
  });
}

describe("parseTypedBalanceSeries · what it reads (#1418)", () => {
  it("reads a plain «fecha saldo» series in Spanish notation", () => {
    expect(
      rowsOf(
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
    expect(rowsOf("2025-10-01\t198456,78 €\n2025-11-01\t197900,12 €")).toEqual([
      { balanceMinor: 19845678, date: "2025-10-01" },
      { balanceMinor: 19790012, date: "2025-11-01" },
    ]);
  });

  it("recovers a dot-decimal CSV, which a comma split would otherwise swallow", () => {
    // The comma is never the FIRST separator (it is the Spanish decimal mark), so only a
    // token that fails to normalize is re-cut on it. `198.456,78` never gets there.
    expect(rowsOf("2025-10-01,1000.00,2.5\n2025-11-01,900.00,2.5")).toEqual([
      { balanceMinor: 100000, date: "2025-10-01" },
      { balanceMinor: 90000, date: "2025-11-01" },
    ]);
  });

  it("picks the column that behaves like a balance out of a pasted table", () => {
    // Nº · fecha · cuota · intereses · capital · saldo — the ordinary amortization row.
    expect(
      rowsOf(
        [
          "Nº Fecha Cuota Intereses Capital Saldo",
          "1 01/10/2025 850,00 320,15 529,85 198.456,78",
          "2 01/11/2025 850,00 318,90 531,10 197.925,68",
          "3 01/12/2025 850,00 317,64 532,36 197.393,32",
        ].join("\n"),
      ).map((row) => row.balanceMinor),
    ).toEqual([19845678, 19792568, 19739332]);
  });

  it("keeps the balance column when it is not the last one", () => {
    expect(
      rowsOf(
        [
          "01/10/2025 198.456,78 850,00 2,50%",
          "01/11/2025 197.925,68 850,00 2,50%",
          "01/12/2025 197.393,32 850,00 2,50%",
        ].join("\n"),
      ).map((row) => row.balanceMinor),
    ).toEqual([19845678, 19792568, 19739332]);
  });

  it("tolerates a carencia — a balance that holds flat for a month", () => {
    expect(
      rowsOf(
        ["01/10/2025 198.456,78", "01/11/2025 198.456,78", "01/12/2025 197.925,68"].join(
          "\n",
        ),
      ),
    ).toHaveLength(3);
  });

  it("reads a debt written with a negative sign as its magnitude", () => {
    expect(rowsOf("01/10/2025 -198.456,78\n01/11/2025 -197.925,68")).toEqual([
      { balanceMinor: 19845678, date: "2025-10-01" },
      { balanceMinor: 19792568, date: "2025-11-01" },
    ]);
  });

  it("sorts the series when the paste is reverse-chronological", () => {
    expect(rowsOf("01/12/2025 197.393,32\n01/10/2025 198.456,78")).toEqual([
      { balanceMinor: 19845678, date: "2025-10-01" },
      { balanceMinor: 19739332, date: "2025-12-01" },
    ]);
  });

  it("reads the local date DAY first, like the rest of worthline's es-ES", () => {
    // Not «ambiguous, so refuse»: refusing would kill the commonest series there is, a
    // mortgage paid on the 1st of every month. The number reader settles the same class
    // of ambiguity the same way.
    expect(rowsOf("03/04/2025 198.456,78\n03/05/2025 197.925,68")[0]?.date).toBe(
      "2025-04-03",
    );
  });

  it("ignores prose around the series", () => {
    expect(
      rowsOf(
        [
          "Te paso los saldos de la hipoteca, que no me deja subir el archivo:",
          "01/10/2025 198.456,78",
          "01/11/2025 197.925,68",
          "Y eso es todo, dime si falta algo.",
        ].join("\n"),
      ),
    ).toHaveLength(2);
  });

  it("survives a phone number in the prose around the series", () => {
    // Without the digit fence on the date patterns, `600.12.3456` matches from its
    // second digit, yields no real day, and takes the whole series down with it.
    expect(
      rowsOf(
        [
          "Si hace falta llámame al 600.12.3456, te paso los saldos:",
          "01/10/2025 198.456,78",
          "01/11/2025 197.925,68",
        ].join("\n"),
      ),
    ).toHaveLength(2);
  });

  it("accepts exactly the document contract's row cap", () => {
    expect(rowsOf(seriesLines(500).join("\n"))).toHaveLength(500);
  });
});

describe("parseTypedBalanceSeries · «I saw nothing» (#1418)", () => {
  it("says absent for an empty message", () => {
    expect(statusOf("")).toBe("absent");
  });

  it("says absent for ordinary prose", () => {
    expect(statusOf("¿cuánto me queda de la hipoteca?")).toBe("absent");
  });

  it("says absent for ONE dated figure: a single fact is not a series", () => {
    // And it has its own open door while the gate bites — `propose_correction`.
    expect(MIN_TYPED_BALANCE_SERIES_ROWS).toBe(2);
    expect(statusOf("el 01/10/2025 tenía 198.456,78")).toBe("absent");
  });
});

describe("parseTypedBalanceSeries · «I saw one and could not read it» (#1418)", () => {
  /**
   * Every case here is a person who did the work. Answering `absent` would send back the
   * copy that asks for the series — the disease this ticket is named after.
   */
  it("says unreadable when no column goes down", () => {
    expect(statusOf("01/10/2025 850,00\n01/11/2025 850,00\n01/12/2025 850,00")).toBe(
      "unreadable",
    );
  });

  it("says unreadable when the balance goes UP", () => {
    expect(statusOf("01/10/2025 197.925,68\n01/11/2025 198.456,78")).toBe("unreadable");
  });

  it("says unreadable when the rows do not have the same shape", () => {
    expect(statusOf("01/10/2025 850,00 198.456,78\n01/11/2025 197.925,68")).toBe(
      "unreadable",
    );
  });

  it("says unreadable when a date repeats — the series would be ambiguous", () => {
    expect(statusOf("01/10/2025 198.456,78\n01/10/2025 197.925,68")).toBe("unreadable");
  });

  it("says unreadable for an impossible date instead of shifting it", () => {
    // Which is also what a month-first paste gets once its day passes twelve.
    expect(statusOf("31/02/2025 198.456,78\n01/03/2025 197.925,68")).toBe("unreadable");
  });

  it("says unreadable past the document contract's row cap", () => {
    expect(statusOf(seriesLines(501).join("\n"))).toBe("unreadable");
  });
});

describe("typedBalanceSeriesInTurn (#1418)", () => {
  it("reads only the LAST user message — the series has to be typed in this turn", () => {
    const reading = typedBalanceSeriesInTurn([
      userMessage("01/10/2025 198.456,78\n01/11/2025 197.925,68"),
      { id: "a1", parts: [{ text: "Entendido.", type: "text" }], role: "assistant" },
      userMessage("01/03/2026 190.000,00\n01/04/2026 189.000,00"),
    ]);

    expect(reading).toEqual({
      rows: [
        { balanceMinor: 19000000, date: "2026-03-01" },
        { balanceMinor: 18900000, date: "2026-04-01" },
      ],
      status: "read",
    });
  });

  it("ignores a series the ASSISTANT wrote", () => {
    // The model reciting the document worthline could not validate is precisely what the
    // gate protects against, so its prose is never the user's own text.
    expect(
      typedBalanceSeriesInTurn([
        userMessage("¿Puedes con esto?"),
        {
          id: "a1",
          parts: [{ text: "01/10/2025 198.456,78\n01/11/2025 197.925,68", type: "text" }],
          role: "assistant",
        },
      ]),
    ).toEqual({ status: "absent" });
  });

  it("finds nothing when there is no user message at all", () => {
    expect(typedBalanceSeriesInTurn([])).toEqual({ status: "absent" });
  });
});
