import {
  SpreadsheetReadError,
  spreadsheetToAllSheets,
  spreadsheetToRows,
  type WorkbookSheet,
} from "@web/spreadsheet-text";

import {
  type AttachmentExtractionResult,
  checkAttachmentLimits,
  extractedPositionSchema,
  normalizeExtractedNumber,
  parseExtractionResult,
} from "./attachment-extraction-contract";

export interface SpreadsheetExtractionInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

type PositionColumn = "ticker" | "name" | "units" | "marketValueEur" | "currency";

const HEADER_ALIASES: Record<PositionColumn, readonly string[]> = {
  ticker: ["ticker", "símbolo", "simbolo", "symbol"],
  name: ["nombre", "name", "descripción", "descripcion", "instrumento", "producto"],
  units: [
    "unidades",
    "units",
    "participaciones",
    "títulos",
    "titulos",
    "cantidad",
    "quantity",
  ],
  marketValueEur: [
    "valor de mercado eur",
    "valor mercado eur",
    "market value eur",
    "valor eur",
    "importe eur",
  ],
  currency: ["divisa", "currency", "moneda"],
};

const COLUMNS = Object.keys(HEADER_ALIASES) as PositionColumn[];
const DELIMITERS = [";", ",", "\t"] as const;
const UNRECOGNIZED_MESSAGE =
  "No reconozco las cabeceras de esta hoja de posiciones. Revisa que incluya símbolo, nombre, unidades, valor de mercado en EUR y divisa.";

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const NORMALIZED_ALIASES: Record<PositionColumn, ReadonlySet<string>> = {
  ticker: new Set(HEADER_ALIASES.ticker.map(normalizeHeader)),
  name: new Set(HEADER_ALIASES.name.map(normalizeHeader)),
  units: new Set(HEADER_ALIASES.units.map(normalizeHeader)),
  marketValueEur: new Set(HEADER_ALIASES.marketValueEur.map(normalizeHeader)),
  currency: new Set(HEADER_ALIASES.currency.map(normalizeHeader)),
};

function resolveColumns(
  header: readonly string[],
): Record<PositionColumn, number> | null {
  const normalized = header.map(normalizeHeader);
  const resolved = {} as Record<PositionColumn, number>;
  for (const column of COLUMNS) {
    const index = normalized.findIndex((value) => NORMALIZED_ALIASES[column].has(value));
    if (index === -1) return null;
    resolved[column] = index;
  }
  return resolved;
}

function parseDelimited(text: string, delimiter: string): string[][] | null {
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

  if (quoted) return null;
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

  for (const delimiter of DELIMITERS) {
    const rows = parseDelimited(text, delimiter);
    if (rows?.[0] && resolveColumns(rows[0])) return rows;
  }
  return parseDelimited(text, ";");
}

function permanentFailure(
  code: "extractor_rejected" | "unsupported_document",
  message: string,
): AttachmentExtractionResult {
  return {
    code,
    failure: "permanent",
    message,
    status: "failure",
  };
}

function isXlsx(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(".xlsx");
}

/** Deterministically map a known CSV/XLSX positions table into the shared contract. */
export function extractPositionsFromSpreadsheet(
  input: SpreadsheetExtractionInput,
): AttachmentExtractionResult {
  const initialLimit = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "spreadsheet",
    mimeType: input.mimeType,
    rowCount: 0,
    sizeBytes: input.bytes.byteLength,
  });
  if (initialLimit) return initialLimit;

  let rows: string[][] | null;
  if (isXlsx(input.fileName)) {
    try {
      rows = spreadsheetToRows(input.bytes);
    } catch (error) {
      if (error instanceof SpreadsheetReadError) {
        return permanentFailure(
          "unsupported_document",
          "El archivo XLSX no se puede leer.",
        );
      }
      throw error;
    }
  } else {
    rows = csvToRows(input.bytes);
  }

  if (!rows || rows.length === 0) {
    return permanentFailure(
      "unsupported_document",
      "La hoja de posiciones no se puede leer.",
    );
  }

  const columns = resolveColumns(rows[0]!);
  if (!columns) return { message: UNRECOGNIZED_MESSAGE, status: "unrecognized" };

  const dataRows = rows
    .slice(1)
    .filter((row) => row.some((value) => value.trim() !== ""));
  const rowLimit = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "spreadsheet",
    mimeType: input.mimeType,
    rowCount: dataRows.length,
    sizeBytes: input.bytes.byteLength,
  });
  if (rowLimit) return rowLimit;

  const positions = [];
  for (const [index, row] of dataRows.entries()) {
    const candidate = {
      currency: (row[columns.currency] ?? "").trim().toUpperCase(),
      marketValueEur: normalizeExtractedNumber(row[columns.marketValueEur]),
      name: (row[columns.name] ?? "").trim(),
      ticker: (row[columns.ticker] ?? "").trim(),
      units: normalizeExtractedNumber(row[columns.units]),
    };
    const parsed = extractedPositionSchema.safeParse(candidate);
    if (!parsed.success) {
      return permanentFailure(
        "extractor_rejected",
        `La fila ${index + 2} contiene datos incompletos o no válidos.`,
      );
    }
    positions.push(parsed.data);
  }

  return parseExtractionResult({
    data: {
      documentType: "positions",
      positions,
      totalEur: positions.reduce((total, position) => total + position.marketValueEur, 0),
      warnings: [],
    },
    status: "valid",
  });
}

/** Card message when a readable spreadsheet is handed to the model to discuss. */
export const UNSTRUCTURED_SPREADSHEET_MESSAGE =
  "No es una tabla de posiciones para importar. Te comento lo que veo del archivo aquí debajo.";

// Bounds keep an arbitrary workbook from flooding the model prompt. A quick
// read of the shape is enough to converse; the whole book is not needed.
const MAX_CONTEXT_SHEETS = 8;
const MAX_CONTEXT_ROWS_PER_SHEET = 60;
const MAX_CONTEXT_COLS = 20;
const MAX_CONTEXT_CELL_CHARS = 120;
const MAX_CONTEXT_CHARS = 12_000;

/**
 * Render a readable-but-unrecognized spreadsheet as bounded plain text so the
 * assistant can describe what it sees instead of dead-ending (#865). Reads
 * every worksheet of an .xlsx, or the delimited grid of a CSV. Returns null
 * when the bytes cannot be read at all — the caller then falls back to the
 * honest canned failure.
 */
export function renderSpreadsheetForContext(
  input: SpreadsheetExtractionInput,
): string | null {
  let sheets: WorkbookSheet[];
  try {
    sheets = isXlsx(input.fileName)
      ? spreadsheetToAllSheets(input.bytes)
      : csvSheets(input.bytes);
  } catch {
    return null;
  }
  // Drop whitespace-only sheets so they do not render as "0 fila(s)" noise.
  const nonEmpty = sheets.filter((sheet) =>
    sheet.rows.some((row) => row.some((cell) => cell.trim() !== "")),
  );
  if (nonEmpty.length === 0) return null;

  const rendered = nonEmpty.slice(0, MAX_CONTEXT_SHEETS).map(renderSheet).join("\n\n");
  const extraSheets = nonEmpty.length - MAX_CONTEXT_SHEETS;
  const suffix = extraSheets > 0 ? `\n\n(y ${extraSheets} hoja(s) más sin mostrar)` : "";
  const text = `${rendered}${suffix}`;
  return text.length > MAX_CONTEXT_CHARS
    ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n(contenido truncado)`
    : text;
}

function csvSheets(bytes: Uint8Array): WorkbookSheet[] {
  const rows = csvToRows(bytes);
  return rows && rows.length > 0 ? [{ name: "", rows }] : [];
}

function renderSheet(sheet: WorkbookSheet, index: number): string {
  const dataRows = sheet.rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  const cols = Math.min(
    MAX_CONTEXT_COLS,
    dataRows.reduce((max, row) => Math.max(max, row.length), 0),
  );
  const shown = dataRows.slice(0, MAX_CONTEXT_ROWS_PER_SHEET);
  const body = shown
    .map((row) =>
      Array.from({ length: cols }, (_, col) => clampCell(row[col] ?? "")).join(" | "),
    )
    .join("\n");

  const title = sheet.name.trim() || `Hoja ${index + 1}`;
  const extraRows = dataRows.length - shown.length;
  const more = extraRows > 0 ? `\n(y ${extraRows} fila(s) más)` : "";
  return `Hoja «${title}» (${dataRows.length} fila(s) × ${cols} columna(s)):\n${body}${more}`;
}

function clampCell(cell: string): string {
  const value = cell.trim().replace(/\s+/g, " ");
  return value.length > MAX_CONTEXT_CELL_CHARS
    ? `${value.slice(0, MAX_CONTEXT_CELL_CHARS)}…`
    : value;
}
