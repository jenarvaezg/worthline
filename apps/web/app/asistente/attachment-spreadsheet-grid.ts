import {
  SpreadsheetReadError,
  spreadsheetToAllSheets,
  type WorkbookSheet,
} from "@web/spreadsheet-text";

/**
 * Shared CSV/XLSX grid reading for the deterministic spreadsheet extractors. It
 * returns raw worksheets — header resolution and per-document mapping stay with
 * each extractor. XLSX reading reuses the workbook parser; CSV is decoded as UTF-8
 * and split on the delimiter that yields the widest first row (`;`, `,` or tab),
 * matching the Spanish-export convention where `;` is the default separator.
 */

const DELIMITERS = [";", ",", "\t"] as const;

export interface SpreadsheetGridInput {
  fileName: string;
  bytes: Uint8Array;
}

export type SpreadsheetGridResult =
  | { status: "ok"; sheets: WorkbookSheet[] }
  | { status: "unreadable" };

/** Normalize a header cell for alias matching: strip accents, BOM, case and runs. */
export function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isXlsx(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(".xlsx");
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      pushCell();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) pushRow();
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

function csvToRows(bytes: Uint8Array): string[][] | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let best: string[][] = [];
  for (const delimiter of DELIMITERS) {
    const rows = parseDelimited(text, delimiter);
    const width = rows[0]?.length ?? 0;
    if (width > (best[0]?.length ?? 0)) best = rows;
  }
  return best.length > 0 ? best : null;
}

/**
 * Normalize a date cell to ISO `YYYY-MM-DD`, or null if it is not a recognizable
 * calendar date. Accepts an already-ISO value and the `dd/mm/yyyy` that the XLSX
 * reader emits from date-styled serials (and that Spanish CSV exports use) — a
 * deterministic reformat, never an invented date. A same-day validity check keeps
 * a `32/13/2026` from slipping through.
 *
 * It lives with the grid reader rather than with one extractor because every
 * deterministic sheet route reads the same two spellings out of the same cells.
 */
export function toIsoDate(value: string): string | null {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return isRealDay(+iso[1]!, +iso[2]!, +iso[3]!) ? trimmed : null;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (dmy) {
    const [year, month, day] = [+dmy[3]!, +dmy[2]!, +dmy[1]!];
    if (!isRealDay(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

function isRealDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Read every worksheet of an XLSX, or the single grid of a CSV. */
export function readSpreadsheetGrids(input: SpreadsheetGridInput): SpreadsheetGridResult {
  if (isXlsx(input.fileName)) {
    try {
      return { sheets: spreadsheetToAllSheets(input.bytes), status: "ok" };
    } catch (error) {
      if (error instanceof SpreadsheetReadError) return { status: "unreadable" };
      throw error;
    }
  }
  const rows = csvToRows(input.bytes);
  return rows ? { sheets: [{ name: "", rows }], status: "ok" } : { status: "unreadable" };
}
