import { parseStatement } from "@worthline/domain";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import {
  isSpreadsheet,
  MAX_SPREADSHEET_UNCOMPRESSED_BYTES,
  SpreadsheetReadError,
  spreadsheetToAllSheets,
  spreadsheetToDelimitedText,
  spreadsheetToRows,
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

/**
 * The same workbook written the way ClosedXML/EPPlus (and the generator Jorge's
 * ChatGPT used) do it: every OOXML element carries an `x:` namespace prefix,
 * strings travel as `t="str"` literals instead of a shared table, and the date
 * column is a serial styled through a prefixed `<x:cellXfs>` (#1404).
 */
function prefixedXlsxFixture(): Uint8Array {
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:styleSheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:numFmts count="1"><x:numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></x:numFmts><x:cellXfs count="2"><x:xf numFmtId="0"/><x:xf numFmtId="164" applyNumberFormat="1"/></x:cellXfs></x:styleSheet>`;

  // 38126 = 2004-05-19 in the 1900 serial system (epoch 1899-12-30).
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
<x:row r="1"><x:c r="A1" t="str"><x:v>Fecha</x:v></x:c><x:c r="B1" t="str"><x:v>Tipo de activo</x:v></x:c><x:c r="C1" t="str"><x:v>Identificador</x:v></x:c><x:c r="D1" t="str"><x:v>Operación</x:v></x:c><x:c r="E1" t="str"><x:v>Participaciones</x:v></x:c><x:c r="F1" t="str"><x:v>Importe</x:v></x:c><x:c r="G1" t="str"><x:v>Comisión</x:v></x:c><x:c r="H1" t="str"><x:v>Nombre</x:v></x:c></x:row>
<x:row r="2"><x:c r="A2" s="1"><x:v>38126</x:v></x:c><x:c r="B2" t="str"><x:v>Fondo</x:v></x:c><x:c r="C2" t="str"><x:v>IE00BYX5NX33</x:v></x:c><x:c r="D2" t="str"><x:v>Compra</x:v></x:c><x:c r="E2"><x:v>7.226</x:v></x:c><x:c r="F2"><x:v>100</x:v></x:c><x:c r="H2" t="str"><x:v>Cartera; la de siempre</x:v></x:c></x:row>
</x:sheetData></x:worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Movimientos" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`;

  return zipSync({
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/styles.xml": strToU8(styles),
    "xl/workbook.xml": strToU8(workbook),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

describe("namespace-prefixed OOXML (#1404)", () => {
  test("reads a prefixed workbook's rows instead of calling it empty", () => {
    const rows = spreadsheetToRows(prefixedXlsxFixture());

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      "Fecha",
      "Tipo de activo",
      "Identificador",
      "Operación",
      "Participaciones",
      "Importe",
      "Comisión",
      "Nombre",
    ]);
    expect(rows[1]?.[7]).toBe("Cartera; la de siempre");
  });

  test("a prefixed date style still converts the serial, not a raw 38126", () => {
    const rows = spreadsheetToRows(prefixedXlsxFixture());

    expect(rows[1]?.[0]).toBe("19/05/2004");
  });

  test("round-trips into the plantilla parser like an unprefixed workbook", () => {
    const parsed = parseStatement(
      spreadsheetToDelimitedText(prefixedXlsxFixture()),
      "plantilla",
    );

    if (!parsed.ok) throw new Error(parsed.errors.join(" | "));
    expect(parsed.value.rows).toHaveLength(1);
    expect(parsed.value.rows[0]).toMatchObject({
      dateKey: "2004-05-19",
      instrument: "fund",
      isin: "IE00BYX5NX33",
      kind: "buy",
      name: "Cartera; la de siempre",
      units: "7.226",
    });
  });

  test("the assistant path reads every prefixed sheet by name too", () => {
    expect(spreadsheetToAllSheets(prefixedXlsxFixture())).toEqual([
      {
        name: "Movimientos",
        rows: [
          [
            "Fecha",
            "Tipo de activo",
            "Identificador",
            "Operación",
            "Participaciones",
            "Importe",
            "Comisión",
            "Nombre",
          ],
          [
            "19/05/2004",
            "Fondo",
            "IE00BYX5NX33",
            "Compra",
            "7.226",
            "100",
            "",
            "Cartera; la de siempre",
          ],
        ],
      },
    ]);
  });

  test("a prefixed shared-string table and a prefixed rels part resolve too", () => {
    const shared = `<?xml version="1.0"?>
<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><x:si><x:t>Cuota</x:t></x:si><x:si><x:t xml:space="preserve">Capital </x:t></x:si></x:sst>`;
    const sheet = `<?xml version="1.0"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
    const workbook = `<?xml version="1.0"?>
<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Cuadro" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`;
    const rels = `<?xml version="1.0"?>
<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships"><rel:Relationship Id="rId1" Target="./worksheets/cuadro.xml"/></rel:Relationships>`;
    const bytes = zipSync({
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/sharedStrings.xml": strToU8(shared),
      "xl/workbook.xml": strToU8(workbook),
      "xl/worksheets/cuadro.xml": strToU8(sheet),
    });

    expect(spreadsheetToRows(bytes)).toEqual([["Cuota", "Capital "]]);
  });

  test("a relationship id full of regex metacharacters resolves, it doesn't crash the upload", () => {
    const sheet = `<?xml version="1.0"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>Activo</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
    const workbook = `<?xml version="1.0"?>
<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Hoja" sheetId="1" r:id="rId1(*"/></x:sheets></x:workbook>`;
    const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1(*" Target="worksheets/otra.xml"/></Relationships>`;
    const bytes = zipSync({
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/workbook.xml": strToU8(workbook),
      "xl/worksheets/otra.xml": strToU8(sheet),
    });

    expect(spreadsheetToRows(bytes)).toEqual([["Activo"]]);
  });

  test("a readable workbook with no rows says so instead of reaching the parser's «archivo vacío»", () => {
    const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;
    const bytes = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) });

    expect(() => spreadsheetToDelimitedText(bytes)).toThrow(
      /no he podido leer ninguna fila/i,
    );
  });
});

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

  test("exposes the first worksheet as a neutral cell matrix", () => {
    const rows = spreadsheetToRows(xlsxFixture());

    expect(rows[0]).toEqual([
      "Fecha",
      "Tipo de activo",
      "Identificador",
      "Operación",
      "Participaciones",
      "Importe",
      "Comisión",
      "Nombre",
    ]);
    expect(rows[1]?.[7]).toBe("Cartera; la de siempre");
  });

  test("reads every worksheet in workbook order with its name (#865)", () => {
    const balance = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Activo</t></is></c><c r="B1"><v>100</v></c></row>
</sheetData></worksheet>`;
    const pyg = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Ingresos</t></is></c><c r="B1"><v>50</v></c></row>
</sheetData></worksheet>`;
    const workbook = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Balance" sheetId="1" r:id="rId1"/><sheet name="PyG" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
    const bytes = zipSync({
      "xl/workbook.xml": strToU8(workbook),
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/worksheets/sheet1.xml": strToU8(balance),
      "xl/worksheets/sheet2.xml": strToU8(pyg),
    });

    const sheets = spreadsheetToAllSheets(bytes);
    expect(sheets).toEqual([
      { name: "Balance", rows: [["Activo", "100"]] },
      { name: "PyG", rows: [["Ingresos", "50"]] },
    ]);
  });

  test("rejects a workbook whose selected parts exceed the uncompressed cap", () => {
    const halfCap = Math.floor(MAX_SPREADSHEET_UNCOMPRESSED_BYTES / 2) + 1;
    const oversized = zipSync({
      "xl/sharedStrings.xml": new Uint8Array(halfCap),
      "xl/worksheets/sheet1.xml": new Uint8Array(halfCap),
    });

    expect(() => spreadsheetToRows(oversized)).toThrow(SpreadsheetReadError);
  });
});
