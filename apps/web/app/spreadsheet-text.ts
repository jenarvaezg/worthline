import { strFromU8, unzipSync } from "fflate";

/**
 * Minimal .xlsx → `;`-delimited text reader (#695), so the plantilla can be
 * kept as a living Excel file and re-uploaded without a save-as-CSV dance.
 *
 * An .xlsx is a zip of XML parts; this reads exactly what the statement parser
 * needs from the FIRST worksheet — shared/inline strings, numbers, and
 * date-styled serials (converted to `dd/mm/yyyy`) — and serializes each row as
 * a `;`-joined line, quoting cells that carry `;`/`"`/newlines. The output
 * feeds `parseStatement` exactly like an uploaded CSV, so every validation
 * (and its Spanish errors) lives in one place. Deliberately NOT SheetJS: the
 * template is our own shape, a full spreadsheet model is unwarranted surface.
 *
 * Pure: bytes in, text out. Throws `SpreadsheetReadError` with a user-facing
 * Spanish message when the workbook is unreadable.
 */

export class SpreadsheetReadError extends Error {}

const UNREADABLE = "El archivo Excel no se puede leer — guarda la hoja como .xlsx.";
const MEBIBYTE = 1024 * 1024;

/** Prevent a small compressed workbook from expanding without bound in memory. */
export const MAX_SPREADSHEET_UNCOMPRESSED_BYTES = 16 * MEBIBYTE;

const METADATA_PARTS = new Set([
  "xl/_rels/workbook.xml.rels",
  "xl/sharedStrings.xml",
  "xl/styles.xml",
  "xl/workbook.xml",
]);

/** Whether the bytes look like a zip container (every .xlsx is one). */
export function isSpreadsheet(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** One named worksheet of an .xlsx as a neutral cell matrix. */
export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

/** First worksheet of an .xlsx as a neutral matrix shared by importers. */
export function spreadsheetToRows(bytes: Uint8Array): string[][] {
  if (!isSpreadsheet(bytes)) throw new SpreadsheetReadError(UNREADABLE);

  const budget = { used: 0 };
  const metadata = unzipSelected(bytes, (name) => METADATA_PARTS.has(name), budget);
  const sheetPath = firstSheetPath(metadata);
  const sheet = unzipSelected(bytes, (name) => name === sheetPath, budget);
  const sheetXml = part(sheet, sheetPath);
  if (!sheetXml) throw new SpreadsheetReadError(UNREADABLE);

  return sheetXmlToRows(sheetXml, workbookContext(metadata));
}

/**
 * Every worksheet of an .xlsx as named cell matrices, order preserved. Powers
 * the assistant's conversational reading of a workbook that is not a positions
 * table (#865): the whole book is the material to describe, not just sheet one.
 */
export function spreadsheetToAllSheets(bytes: Uint8Array): WorkbookSheet[] {
  if (!isSpreadsheet(bytes)) throw new SpreadsheetReadError(UNREADABLE);

  const budget = { used: 0 };
  const metadata = unzipSelected(bytes, (name) => METADATA_PARTS.has(name), budget);
  const entries = sheetEntries(metadata);
  const paths = new Set(entries.map((entry) => entry.path));
  const sheets = unzipSelected(bytes, (name) => paths.has(name), budget);

  const context = workbookContext(metadata);
  const read = entries
    .map((entry) => ({
      name: entry.name,
      rows: sheetXmlToRows(part(sheets, entry.path), context),
    }))
    .filter((sheet) => sheet.rows.length > 0);
  if (read.length === 0) throw new SpreadsheetReadError(UNREADABLE);
  return read;
}

interface WorkbookContext {
  shared: string[];
  dateStyles: Set<number>;
  date1904: boolean;
}

function workbookContext(metadata: Record<string, Uint8Array>): WorkbookContext {
  return {
    shared: sharedStrings(metadata),
    dateStyles: dateStyleIndexes(metadata),
    date1904: /date1904\s*=\s*"(?:1|true)"/i.test(part(metadata, "xl/workbook.xml")),
  };
}

/** A worksheet's XML rows as a cell matrix, gaps filled by column reference. */
function sheetXmlToRows(sheetXml: string, context: WorkbookContext): string[][] {
  const rows: string[][] = [];
  for (const rowXml of sheetXml.match(/<row[\s>][\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const cellXml of rowXml.match(/<c[\s>][\s\S]*?(?:<\/c>|\/>)/g) ?? []) {
      const at = columnIndexOf(cellXml);
      while (cells.length < at) cells.push("");
      cells[at] = cellText(cellXml, context.shared, context.dateStyles, context.date1904);
    }
    rows.push(cells);
  }
  return rows;
}

/** Ordered `{ name, path }` for every worksheet declared in workbook.xml. */
function sheetEntries(
  metadata: Record<string, Uint8Array>,
): { name: string; path: string }[] {
  const workbook = part(metadata, "xl/workbook.xml");
  const rels = part(metadata, "xl/_rels/workbook.xml.rels");

  const targets = new Map<string, string>();
  for (const rel of rels.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /\bId\s*=\s*"([^"]+)"/.exec(rel)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/.exec(rel)?.[1];
    if (id && target) targets.set(id, target);
  }

  const entries: { name: string; path: string }[] = [];
  for (const sheet of workbook.match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = unescapeXml(/\bname\s*=\s*"([^"]*)"/.exec(sheet)?.[1] ?? "");
    const relId = /\br:id\s*=\s*"([^"]+)"/.exec(sheet)?.[1];
    const target = relId ? targets.get(relId) : undefined;
    if (!target) continue;
    const path = target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, "")}`;
    entries.push({ name, path });
  }
  // Fallback for writers that skip rels: the conventional first-sheet path.
  return entries.length > 0 ? entries : [{ name: "", path: "xl/worksheets/sheet1.xml" }];
}

/** First worksheet of an .xlsx → `;`-delimited lines, ready for parseStatement. */
export function spreadsheetToDelimitedText(bytes: Uint8Array): string {
  return spreadsheetToRows(bytes)
    .map((cells) => cells.map(escapeCell).join(";"))
    .join("\n");
}

function unzipSelected(
  bytes: Uint8Array,
  include: (name: string) => boolean,
  budget: { used: number },
): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        if (!include(file.name)) return false;
        budget.used += file.originalSize;
        if (budget.used > MAX_SPREADSHEET_UNCOMPRESSED_BYTES) {
          throw new SpreadsheetReadError(UNREADABLE);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof SpreadsheetReadError) throw error;
    throw new SpreadsheetReadError(UNREADABLE);
  }
}

function part(files: Record<string, Uint8Array>, name: string): string {
  const bytes = files[name];
  return bytes ? strFromU8(bytes) : "";
}

/** The workbook's first sheet path, resolved through workbook.xml + its rels. */
function firstSheetPath(files: Record<string, Uint8Array>): string {
  const workbook = part(files, "xl/workbook.xml");
  const relId = /<sheet[^>]*\br:id\s*=\s*"([^"]+)"/.exec(workbook)?.[1];
  if (relId) {
    const rels = part(files, "xl/_rels/workbook.xml.rels");
    const target = new RegExp(
      `<Relationship[^>]*\\bId\\s*=\\s*"${relId}"[^>]*\\bTarget\\s*=\\s*"([^"]+)"`,
    ).exec(rels)?.[1];
    if (target) {
      const path = target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, "")}`;
      return path;
    }
  }
  // Fallback for writers that skip rels: the conventional first-sheet path.
  return "xl/worksheets/sheet1.xml";
}

/** sharedStrings.xml → flat string table (rich-text runs concatenated). */
function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const xml = part(files, "xl/sharedStrings.xml");
  if (!xml) return [];
  return (xml.match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) =>
    (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
      .map((t) => unescapeXml(/<t[^>]*>([\s\S]*?)<\/t>/.exec(t)?.[1] ?? ""))
      .join(""),
  );
}

// Built-in numFmtIds Excel renders as dates (ECMA-376 §18.8.30).
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47,
]);

/** The cellXfs style indexes whose number format renders as a date. */
function dateStyleIndexes(files: Record<string, Uint8Array>): Set<number> {
  const xml = part(files, "xl/styles.xml");
  if (!xml) return new Set();

  const customDateFormats = new Set<number>();
  for (const numFmt of xml.match(/<numFmt\b[^>]*\/?>/g) ?? []) {
    const id = Number(/numFmtId\s*=\s*"(\d+)"/.exec(numFmt)?.[1]);
    const code = /formatCode\s*=\s*"([^"]*)"/.exec(numFmt)?.[1] ?? "";
    // A format with day/year tokens (outside color/[] sections) is a date.
    if (/[dy]/i.test(code.replace(/\[[^\]]*\]/g, "")) && Number.isFinite(id)) {
      customDateFormats.add(id);
    }
  }

  const styles = new Set<number>();
  const cellXfs = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(xml)?.[0] ?? "";
  (cellXfs.match(/<xf\b[^>]*\/?>/g) ?? []).forEach((xf, index) => {
    const numFmtId = Number(/numFmtId\s*=\s*"(\d+)"/.exec(xf)?.[1] ?? "0");
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId)) {
      styles.add(index);
    }
  });
  return styles;
}

/** `A`→0, `Z`→25, `AA`→26 … from a cell reference like `C7`. */
function columnIndexOf(cellXml: string): number {
  const ref = /\br\s*=\s*"([A-Z]+)\d+"/.exec(cellXml)?.[1];
  if (!ref) return 0;
  let index = 0;
  for (const char of ref) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function cellText(
  cellXml: string,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): string {
  const type = /\bt\s*=\s*"([^"]+)"/.exec(cellXml)?.[1] ?? "n";

  if (type === "inlineStr") {
    return unescapeXml(/<t[^>]*>([\s\S]*?)<\/t>/.exec(cellXml)?.[1] ?? "");
  }

  const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? "";
  if (type === "s") return shared[Number(value)] ?? "";
  if (type === "str" || type === "b" || type === "e") return unescapeXml(value);

  // Numeric cell: a date-styled serial becomes dd/mm/yyyy; anything else stays
  // a raw dot-decimal number, which the plantilla parser accepts.
  const style = Number(/\bs\s*=\s*"(\d+)"/.exec(cellXml)?.[1] ?? "-1");
  if (dateStyles.has(style) && value !== "") {
    return serialToSpanishDate(Number(value), date1904);
  }
  return unescapeXml(value);
}

/** Excel date serial (1900 system unless date1904) → `dd/mm/yyyy`. */
function serialToSpanishDate(serial: number, date1904: boolean): string {
  // 1900 system: day 1 = 1900-01-01 with the fictitious 1900-02-29, so the
  // epoch that makes the arithmetic exact is 1899-12-30.
  const epochMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epochMs + Math.round(serial) * 86_400_000);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

function escapeCell(cell: string): string {
  return /[;"\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&amp;", "&");
}
