import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import { parseStatement } from "@worthline/domain";

import {
  isSpreadsheet,
  spreadsheetToDelimitedText,
  SpreadsheetReadError,
} from "./spreadsheet-text";

/**
 * Builds a real (minimal) .xlsx in-memory: zip + workbook rels + styles with a
 * date format + shared strings — the same parts Excel writes. Fecha cells are
 * date-styled serials (what Excel actually stores), not text.
 */
function xlsxFixture(): Uint8Array {
  const sharedValues = [
    "Fecha",
    "Tipo de activo",
    "Identificador",
    "Operación",
    "Participaciones",
    "Importe",
    "Comisión",
    "Nombre",
    "Fondo",
    "IE00BYX5NX33",
    "Compra",
    "Cartera; la de siempre",
    "Cripto",
    "bitcoin",
    "Venta",
  ];
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedValues.length}" uniqueCount="${sharedValues.length}">${sharedValues
    .map((value) => `<si><t>${value.replace("&", "&amp;")}</t></si>`)
    .join("")}</sst>`;

  // Style 1 → numFmtId 14 (built-in dd/mm/yyyy): the Fecha cells use s="1".
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

  // 46054 = 2026-02-01 in the 1900 serial system (epoch 1899-12-30).
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c><c r="G1" t="s"><v>6</v></c><c r="H1" t="s"><v>7</v></c></row>
<row r="2"><c r="A2" s="1"><v>46054</v></c><c r="B2" t="s"><v>8</v></c><c r="C2" t="s"><v>9</v></c><c r="D2" t="s"><v>10</v></c><c r="E2"><v>7.226</v></c><c r="F2"><v>100</v></c><c r="H2" t="s"><v>11</v></c></row>
<row r="3"><c r="A3" s="1"><v>46096</v></c><c r="B3" t="s"><v>12</v></c><c r="C3" t="s"><v>13</v></c><c r="D3" t="s"><v>14</v></c><c r="E3"><v>0.015</v></c><c r="F3"><v>850</v></c><c r="G3"><v>1.5</v></c></row>
</sheetData></worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Operaciones" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  return zipSync({
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/sharedStrings.xml": strToU8(sharedStrings),
    "xl/styles.xml": strToU8(styles),
  });
}

describe("spreadsheetToDelimitedText (#695)", () => {
  test("detects the zip magic", () => {
    expect(isSpreadsheet(xlsxFixture())).toBe(true);
    expect(isSpreadsheet(strToU8("Fecha;Tipo de activo"))).toBe(false);
  });

  test("first sheet round-trips into the plantilla parser: date serials, numbers and quoted names", () => {
    const text = spreadsheetToDelimitedText(xlsxFixture());
    const parsed = parseStatement(text, "plantilla");

    if (!parsed.ok) throw new Error(parsed.errors.join(" | "));
    expect(parsed.value.rows).toHaveLength(2);
    expect(parsed.value.rows[0]).toMatchObject({
      dateKey: "2026-02-01",
      instrument: "fund",
      isin: "IE00BYX5NX33",
      kind: "buy",
      name: "Cartera; la de siempre",
      units: "7.226",
    });
    expect(parsed.value.rows[1]).toMatchObject({
      dateKey: "2026-03-15",
      feesMinor: 150,
      instrument: "crypto",
      isin: "bitcoin",
      kind: "sell",
    });
  });

  test("a non-workbook zip fails with the Spanish message, not a crash", () => {
    const zip = zipSync({ "hola.txt": strToU8("nada") });
    expect(() => spreadsheetToDelimitedText(zip)).toThrow(SpreadsheetReadError);
  });
});
