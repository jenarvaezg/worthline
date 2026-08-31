/**
 * The source of `attachments/Transactions.xlsx`, in plain text (#1516).
 *
 * The fixture it builds is a BINARY committed to a public repo, and a binary nobody can
 * read is a fixture nobody can review: the grid below is what the workbook contains,
 * cell for cell, and `broker-transactions-fixture.test.ts` reads the committed file back
 * and asserts it still says exactly this. Change the grid, regenerate, or the test
 * fails — which is the only arrangement under which the `.xlsx` and its documented
 * content cannot drift apart in silence.
 *
 * Why a workbook at all, when the other spreadsheet fixtures are CSVs: the session
 * this question grades (2026-08-21) failed on the EXTENSION. The model told a user that
 * «worthline no puede procesar importaciones directas de operaciones a partir de un
 * archivo Excel genérico» while holding a `broker_transactions` document worthline had
 * validated perfectly — so a `.csv` fixture would quietly drop the very trigger the
 * question exists to measure. It costs nothing else: the spreadsheet route is
 * deterministic either way, and this file needs no vision credential.
 *
 * **The figures are synthetic; the SHAPE is the measured one.** Jorge's own export was
 * not recoverable when this was written, so what survives from it is everything #1487
 * and #1513 put on the record: the 17-column DEGIRO header with two unnamed currency
 * columns, eleven rows, the three ISINs the reading found
 * (`IE00B52MJY50`, `IE00BM67HK77`, `US18915M1071`), costs that add up to the 16,80 €
 * the extraction card printed, and no operation column anywhere — the sign of `Número`
 * IS the direction, which is the whole reason this document type had to be built.
 * Names, order ids and every account reference are ours.
 *
 * Two deliberate simplifications, both to keep a red here meaning what it says:
 *
 *  - every row settles in EUR, `US18915M1071` included. A row in dollars would send
 *    `buildStatementImportProposalFromDocument` through `convertStatementRows`, and a
 *    missing ECB rate would then fail the proposal — the card would vanish for a
 *    reason that has nothing to do with the model's routing, which is what this
 *    question measures;
 *  - every date sits before the harness's pinned clock (`WORTHLINE_DEMO_NOW`,
 *    2026-06-01), for the reason `attachment-proposes-one-fact` documents: a document
 *    dated in the eval's own future gives a model an honest reason to refuse.
 *
 * Regenerate with:
 *   bun run apps/web/app/asistente/eval/write-broker-transactions-fixture.ts
 *
 * This module stays pure — a grid and the bytes it builds — so that importing the file
 * NAMES from a question set does not drag the attachment pipeline in behind them. The
 * writing, and the reader it needs, live in that script.
 */

import { strToU8, zipSync } from "fflate";

/** The file name a DEGIRO export arrives with — the one the model reads in the block. */
export const BROKER_TRANSACTIONS_FIXTURE_FILE = "Transactions.xlsx";

/**
 * The header of a real DEGIRO `Transactions.xlsx` (#1487): 17 columns, two of them
 * WITHOUT a header — the currency of the figure to their left.
 */
const HEADER = [
  "Fecha",
  "Hora",
  "Producto",
  "ISIN",
  "Bolsa de referencia",
  "Centro de ejecución",
  "Número",
  "Precio",
  "",
  "Valor local",
  "",
  "Valor EUR",
  "Tipo de cambio",
  "Comisión AutoFX",
  "Costes de transacción y/o externos EUR",
  "Total EUR",
  "ID Orden",
];

interface Trade {
  date: string;
  time: string;
  product: string;
  isin: string;
  /** Negative on a sell — the only thing in the file that states a direction. */
  units: string;
  price: string;
  /** Gross, fees excluded. Negative on a buy, as the broker prints it. */
  value: string;
  /** Always negative: a cost. */
  costs: string;
  /** `value` plus `costs`, as the broker prints it. */
  total: string;
  orderId: string;
}

/** The position the question is about: five buys and the partial sell of May. */
const EX_JAPAN = "ISHARES CORE MSCI PACIFIC EX-JPN";
const WORLD_TECH = "XTRACKERS MSCI WORLD INFORMATION TECHNOLOGY";
const CLOUD = "CLOUDFLARE INC. CLASS A";

const TRADES: Trade[] = [
  {
    costs: "-1,00",
    date: "15-01-2026",
    isin: "IE00B52MJY50",
    orderId: "orden-01",
    price: "31,45",
    product: EX_JAPAN,
    time: "09:32",
    total: "-378,40",
    units: "12",
    value: "-377,40",
  },
  {
    costs: "-2,00",
    date: "20-01-2026",
    isin: "IE00BM67HK77",
    orderId: "orden-02",
    price: "62,30",
    product: WORLD_TECH,
    time: "10:02",
    total: "-251,20",
    units: "4",
    value: "-249,20",
  },
  {
    costs: "-1,90",
    date: "05-02-2026",
    isin: "US18915M1071",
    orderId: "orden-03",
    price: "88,20",
    product: CLOUD,
    time: "15:41",
    total: "-266,50",
    units: "3",
    value: "-264,60",
  },
  {
    costs: "-1,00",
    date: "16-02-2026",
    isin: "IE00B52MJY50",
    orderId: "orden-04",
    price: "32,10",
    product: EX_JAPAN,
    time: "09:14",
    total: "-386,20",
    units: "12",
    value: "-385,20",
  },
  {
    costs: "-2,00",
    date: "19-02-2026",
    isin: "IE00BM67HK77",
    orderId: "orden-05",
    price: "64,85",
    product: WORLD_TECH,
    time: "10:11",
    total: "-261,40",
    units: "4",
    value: "-259,40",
  },
  {
    costs: "-1,00",
    date: "16-03-2026",
    isin: "IE00B52MJY50",
    orderId: "orden-06",
    price: "30,88",
    product: EX_JAPAN,
    time: "09:07",
    total: "-371,56",
    units: "12",
    value: "-370,56",
  },
  {
    costs: "-2,00",
    date: "19-03-2026",
    isin: "IE00BM67HK77",
    orderId: "orden-07",
    price: "60,12",
    product: WORLD_TECH,
    time: "10:05",
    total: "-242,48",
    units: "4",
    value: "-240,48",
  },
  {
    costs: "-1,00",
    date: "15-04-2026",
    isin: "IE00B52MJY50",
    orderId: "orden-08",
    price: "32,74",
    product: EX_JAPAN,
    time: "09:21",
    total: "-393,88",
    units: "12",
    value: "-392,88",
  },
  {
    costs: "-2,00",
    date: "20-04-2026",
    isin: "IE00BM67HK77",
    orderId: "orden-09",
    price: "65,40",
    product: WORLD_TECH,
    time: "10:08",
    total: "-263,60",
    units: "4",
    value: "-261,60",
  },
  {
    // The one instrument that leaves the portfolio entirely, and one of the two rows
    // whose sign says «sell» — without them `directionSource` would be `assumed_buy`
    // and the reading would carry a doubt the real export does not have.
    costs: "-1,90",
    date: "07-05-2026",
    isin: "US18915M1071",
    orderId: "orden-10",
    price: "95,10",
    product: CLOUD,
    time: "15:52",
    total: "283,40",
    units: "-3",
    value: "285,30",
  },
  {
    costs: "-1,00",
    date: "15-05-2026",
    isin: "IE00B52MJY50",
    orderId: "orden-11",
    price: "33,05",
    product: EX_JAPAN,
    time: "09:12",
    total: "660,00",
    units: "-20",
    value: "661,00",
  },
];

function rowOf(trade: Trade): string[] {
  return [
    trade.date,
    trade.time,
    trade.product,
    trade.isin,
    "EAM",
    "XAMS",
    trade.units,
    trade.price,
    "EUR",
    trade.value,
    "EUR",
    trade.value,
    "",
    "",
    trade.costs,
    trade.total,
    trade.orderId,
  ];
}

/** The workbook's only sheet, exactly as the committed `.xlsx` carries it. */
export const BROKER_TRANSACTIONS_GRID: readonly string[][] = [
  HEADER,
  ...TRADES.map(rowOf),
];

/**
 * The three characters that would end the element early. A DEGIRO product name is a
 * plausible place for an `&` («PROCTER & GAMBLE»), and an unescaped one writes a
 * corrupt workbook that only the reader would complain about, far from here.
 */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `A`, `B`, … `Z`, `AA` — a sheet reference wide enough for a grid that grows. */
function columnRef(index: number): string {
  let ref = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
  }
  return ref;
}

function inlineCell(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

/**
 * Every cell as an inline string, which is how the figures survive the round trip:
 * DEGIRO's own decimal comma and its `DD-MM-YYYY` dates are what the reader's aliases
 * were measured against, and a numeric cell would hand it a serial and a dot instead.
 */
function sheetXml(rows: readonly string[][]): string {
  const body = rows
    .map((cells, index) => {
      const row = index + 1;
      const inline = cells
        .map((value, column) =>
          value === "" ? "" : inlineCell(`${columnRef(column)}${row}`, value),
        )
        .join("");
      return `<row r="${row}">${inline}</row>`;
    })
    .join("");
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Any grid as a one-sheet workbook. Exported so the escaping and the column references
 * can be tested on inputs this fixture does not have today — an `&` in a product name,
 * a grid past column Z — since the header above invites the next person to edit the
 * grid and regenerate, and a corrupt workbook would fail far from here.
 */
export function buildWorkbook(rows: readonly string[][]): Uint8Array {
  const workbook =
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels =
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
    `Target="worksheets/sheet1.xml"/></Relationships>`;
  return zipSync({
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(rows)),
  });
}

/** The fixture's bytes, built from {@link BROKER_TRANSACTIONS_GRID} and nothing else. */
export function buildBrokerTransactionsWorkbook(): Uint8Array {
  return buildWorkbook(BROKER_TRANSACTIONS_GRID);
}

/**
 * The name of the extraction envelope the SECOND question carries (#1516): the same
 * workbook, validated one turn earlier and reaching the turn through history — which is
 * how this actually arrives, since a user uploads the file and asks for the fix in the
 * next message.
 */
export const BROKER_TRANSACTIONS_DOCUMENT_FILE = "extracto-transacciones.json";
