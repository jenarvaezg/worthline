import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import { readSpreadsheetContext } from "./attachment-spreadsheet-context";

/** Comfortably above what any fixture here needs, so nothing is cut by accident. */
const WIDE_BUDGET = 200_000;
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const WORKSHEET_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

function csv(lines: string[]): { bytes: Uint8Array; fileName: string } {
  return { bytes: new TextEncoder().encode(lines.join("\n")), fileName: "libro.csv" };
}

function columnRef(index: number): string {
  let ref = "";
  for (let n = index; ; n = Math.floor(n / 26) - 1) {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    if (Math.floor(n / 26) - 1 < 0) break;
  }
  return ref;
}

function worksheet(rows: string[][]): string {
  const body = rows
    .map(
      (cells, row) =>
        `<row r="${row + 1}">${cells
          .map(
            (cell, column) =>
              `<c r="${columnRef(column)}${row + 1}" t="inlineStr"><is><t>${cell}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  return `<worksheet xmlns="${MAIN}"><sheetData>${body}</sheetData></worksheet>`;
}

function xlsx(sheets: { name: string; rows: string[][] }[]): {
  bytes: Uint8Array;
  fileName: string;
} {
  const relationships = sheets
    .map(
      (_unused, index) =>
        `<Relationship Id="rId${index + 1}" Type="${WORKSHEET_REL}" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  const declarations = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  const files: Record<string, Uint8Array> = {
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="${RELS}">${relationships}</Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<workbook xmlns="${MAIN}" xmlns:r="${RELS}"><sheets>${declarations}</sheets></workbook>`,
    ),
  };
  for (const [index, sheet] of sheets.entries()) {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheet(sheet.rows));
  }
  return { bytes: zipSync(files), fileName: "libro.xlsx" };
}

/** The reported document's shape: a 425-row amortisation plan (#1419). */
function amortisationRows(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `Cuota ${index + 1};${100_000 - index * 200}`,
  );
}

function keptRowNumbers(text: string): number[] {
  return [...text.matchAll(/^Cuota (\d+) \|/gm)].map((match) => Number(match[1]));
}

function render(
  input: { bytes: Uint8Array; fileName: string },
  budgetChars = WIDE_BUDGET,
): string | null {
  return readSpreadsheetContext(input)?.render(budgetChars) ?? null;
}

describe("readSpreadsheetContext (#865)", () => {
  test("renders every worksheet of an xlsx as named text", () => {
    const text = render(
      xlsx([
        { name: "Posiciones", rows: [["VWCE", "Vanguard FTSE All-World"]] },
        { name: "Otra", rows: [["No debe perderse"]] },
      ]),
    );

    expect(text).toContain("«Posiciones»");
    expect(text).toContain("VWCE | Vanguard FTSE All-World");
    expect(text).toContain("«Otra»");
    expect(text).toContain("No debe perderse");
  });

  test("renders a delimited CSV as a single sheet", () => {
    const text = render(csv(["Activo;2024;2023", "Inmovilizado;100;90"]));

    expect(text).toContain("Activo | 2024 | 2023");
    expect(text).toContain("Inmovilizado | 100 | 90");
  });

  test("stays silent about a cut that did not happen", () => {
    const text = render(csv(["Concepto;Saldo", "Cuenta;10,00"]));

    // A notice on every sheet would be noise, and noise is what got ignored.
    expect(text).not.toContain("LECTURA PARCIAL");
  });

  test("returns null when the bytes cannot be read at all", () => {
    expect(
      render({ bytes: strToU8("not a workbook"), fileName: "roto.xlsx" }),
    ).toBeNull();
  });
});

/**
 * The reported case (#1419): a 13-sheet mortgage workbook whose 425-row amortisation
 * plan reached the model cut at row 60 — its first five years of thirty — while five
 * whole sheets never arrived at all. The model then offered a 2020 what-if it found in
 * one of the personal-analysis sheets as a historical balance, because nothing in the
 * text distinguished the document from the notes around it.
 */
describe("readSpreadsheetContext without count-shaped bounds (#1419)", () => {
  test("hands over more than eight sheets", () => {
    const book = Array.from({ length: 13 }, (_unused, index) => ({
      name: `Hoja ${index + 1}`,
      rows: [[`contenido ${index + 1}`]],
    }));

    const text = render(xlsx(book));

    expect(text).toContain("contenido 13");
    expect(text).toContain("Hoja 13/13");
    expect(text).not.toContain("LECTURA PARCIAL");
  });

  test("hands over more than sixty rows: the whole plan, ending where it ends", () => {
    const text = render(csv(["Concepto;Saldo", ...amortisationRows(425)]));

    expect(keptRowNumbers(text!)).toHaveLength(425);
    expect(text).toContain("Cuota 425 |");
    expect(text).not.toContain("LECTURA PARCIAL");
  });

  test("hands over more than twenty columns", () => {
    const wide = Array.from({ length: 25 }, (_unused, index) => `c${index + 1}`);

    const text = render(xlsx([{ name: "Ancha", rows: [wide] }]));

    expect(text).toContain("25 columna(s)");
    expect(text).toContain("c25");
  });

  test("names every sheet by its place in the book and its shape", () => {
    const text = render(
      xlsx([
        {
          name: "Plan",
          rows: [
            ["a", "b"],
            ["c", "d"],
            ["e", "f"],
          ],
        },
        { name: "Notas", rows: [["nota"]] },
      ]),
    );

    expect(text).toContain("Hoja 1/2 «Plan» (3 fila(s) × 2 columna(s)):");
    expect(text).toContain("Hoja 2/2 «Notas» (1 fila(s) × 1 columna(s)):");
  });
});

describe("readSpreadsheetContext under a tight budget (#1419)", () => {
  /**
   * The whole point of the slice: a prefix of a dated series is the WORST of the three
   * possible readings — it answers neither «how did this start» nor «where does it
   * stand» — while a sample answers both and admits what it is.
   */
  test("samples head, tail and a regular step instead of truncating", () => {
    const text = render(csv(["Concepto;Saldo", ...amortisationRows(425)]), 3_000);
    const kept = keptRowNumbers(text!);

    expect(text).toContain("MUESTRA");
    expect(kept.length).toBeLessThan(425);
    // The head opens the series and the tail is where it stands today.
    expect(kept[0]).toBe(1);
    expect(kept.at(-1)).toBe(425);
    // And the middle is walked, which is what a prefix never does.
    expect(kept.some((row) => row > 100 && row < 325)).toBe(true);
    expect(new Set(kept).size).toBe(kept.length);
  });

  test("says the rows are a sample, and that they are not consecutive", () => {
    const text = render(csv(["Concepto;Saldo", ...amortisationRows(425)]), 3_000);

    expect(text).toContain("LECTURA PARCIAL");
    expect(text).toContain("NO son consecutivas");
    // The one claim a prefix could never make, and the reason a sample is better.
    expect(text).toContain("La última fila mostrada SÍ es la última de la hoja.");
  });

  test("keeps the whole book inside the budget it was handed", () => {
    const book = xlsx([
      { name: "Plan", rows: amortisationRows(425).map((row) => row.split(";")) },
      { name: "Análisis", rows: amortisationRows(120).map((row) => row.split(";")) },
      { name: "Notas", rows: [["una nota corta"]] },
    ]);

    for (const budget of [2_000, 8_000, 40_000]) {
      const text = render(book, budget);
      expect(text!.length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      // Every sheet still has a place in the book, however small its share.
      expect(text, `budget ${budget}`).toContain("«Notas»");
    }
  });

  test("spends the budget where the document is, not equally", () => {
    const text = render(
      xlsx([
        { name: "Notas", rows: [["una nota corta"]] },
        { name: "Plan", rows: amortisationRows(425).map((row) => row.split(";")) },
      ]),
      8_000,
    );

    // The small sheet takes what it needs and leaves the rest to the big one.
    expect(text).toContain("una nota corta");
    expect(keptRowNumbers(text!).length).toBeGreaterThan(60);
  });

  test("drops whole sheets only as a last resort, and says so", () => {
    const book = Array.from({ length: 30 }, (_unused, index) => ({
      name: `Hoja ${index + 1}`,
      rows: [[`contenido ${index + 1}`]],
    }));

    const text = render(xlsx(book), 600);

    expect(text).toContain("hojas");
    expect(text).toContain("no caben en el espacio disponible");
    expect(text).toContain("El documento CONTINÚA más allá de lo visible");
  });
});
