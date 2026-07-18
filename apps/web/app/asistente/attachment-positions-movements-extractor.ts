import type { WorkbookSheet } from "@web/spreadsheet-text";

import {
  type AttachmentExtractionResult,
  checkAttachmentLimits,
  type ExtractedHolding,
  type ExtractedMovement,
  extractedHoldingSchema,
  extractedMovementSchema,
  isValidIsin,
  type MovementKind,
  normalizeExtractedNumber,
  parseExtractionResult,
  resolveHoldingFidelity,
} from "./attachment-extraction-contract";
import {
  normalizeHeader,
  readSpreadsheetGrids,
  type SpreadsheetGridInput,
} from "./attachment-spreadsheet-grid";

/**
 * Deterministic extractor for the **positions + movements** document (PRD #1103
 * S4, ADR 0063). It reads an arbitrary portfolio spreadsheet into the shared
 * contract: a holdings table (name, type, ISIN, value, currency, optional declared
 * cost) plus an optional dated movements table (buys/sells/contributions). From
 * those it derives each holding's **honest cost-basis tier** — never inventing one
 * (ADR 0048): movements → real cost basis, a declared cost → declared, only a value
 * → the "sin coste real" mark.
 *
 * Security (prompt-injection boundary, shared with S5): this route runs no model,
 * so the untrusted spreadsheet never reaches a language model. The only free text
 * that survives extraction is the schema-bounded holding/movement names, which the
 * branded contract length-caps and which reach chat only through `JSON.stringify`
 * framed as data, not instructions — the exact #865 invariant. No workspace write
 * capability is granted; any mutation stays behind the preview-and-confirm boundary.
 */

export type PositionsMovementsExtractionInput = SpreadsheetGridInput & {
  mimeType: string;
};

type HoldingColumn = "name" | "type" | "isin" | "value" | "currency" | "declaredCost";
type MovementColumn =
  | "date"
  | "operation"
  | "isin"
  | "name"
  | "units"
  | "amount"
  | "currency";

const HOLDING_ALIASES: Record<HoldingColumn, readonly string[]> = {
  name: ["nombre", "name", "descripción", "descripcion", "instrumento", "producto"],
  type: ["tipo", "type", "categoría", "categoria", "clase"],
  isin: ["isin", "código isin", "codigo isin"],
  value: [
    "valor",
    "value",
    "valor actual",
    "importe",
    "valoración",
    "valoracion",
    "saldo",
  ],
  currency: ["divisa", "currency", "moneda"],
  declaredCost: [
    "coste",
    "costo",
    "cost",
    "coste declarado",
    "precio de coste",
    "coste de adquisición",
    "coste de adquisicion",
    "aportado",
  ],
};

const MOVEMENT_ALIASES: Record<MovementColumn, readonly string[]> = {
  date: ["fecha", "date", "fecha operación", "fecha operacion", "fecha valor"],
  operation: [
    "operación",
    "operacion",
    "movimiento",
    "tipo de operación",
    "tipo operación",
  ],
  isin: ["isin", "código isin", "codigo isin"],
  name: ["nombre", "name", "instrumento", "producto", "descripción", "descripcion"],
  units: ["unidades", "units", "participaciones", "títulos", "titulos", "cantidad"],
  amount: ["importe", "amount", "total", "efectivo", "importe efectivo"],
  currency: ["divisa", "currency", "moneda"],
};

const OPERATION_KINDS: Record<MovementKind, readonly string[]> = {
  buy: [
    "compra",
    "compras",
    "buy",
    "purchase",
    "adquisición",
    "adquisicion",
    "suscripción",
  ],
  sell: ["venta", "ventas", "sell", "sale", "reembolso", "reembolsos"],
  contribution: [
    "aportación",
    "aportacion",
    "aportaciones",
    "aporte",
    "contribution",
    "ingreso",
    "ingresos",
  ],
};

const HOLDING_REQUIRED: readonly HoldingColumn[] = ["name", "type", "value", "currency"];
const HOLDING_OPTIONAL: readonly HoldingColumn[] = ["isin", "declaredCost"];
const MOVEMENT_REQUIRED: readonly MovementColumn[] = [
  "date",
  "operation",
  "amount",
  "currency",
];
const MOVEMENT_OPTIONAL: readonly MovementColumn[] = ["isin", "name", "units"];

function aliasSets<Column extends string>(
  aliases: Record<Column, readonly string[]>,
): Record<Column, ReadonlySet<string>> {
  const entries = Object.entries(aliases) as [Column, readonly string[]][];
  return Object.fromEntries(
    entries.map(([column, values]) => [column, new Set(values.map(normalizeHeader))]),
  ) as unknown as Record<Column, ReadonlySet<string>>;
}

const HOLDING_ALIAS_SETS = aliasSets(HOLDING_ALIASES);
const MOVEMENT_ALIAS_SETS = aliasSets(MOVEMENT_ALIASES);

function resolveColumns<Column extends string>(
  header: readonly string[],
  required: readonly Column[],
  optional: readonly Column[],
  sets: Record<Column, ReadonlySet<string>>,
): Partial<Record<Column, number>> | null {
  const normalized = header.map(normalizeHeader);
  const resolved: Partial<Record<Column, number>> = {};
  for (const column of required) {
    const index = normalized.findIndex((value) => sets[column].has(value));
    if (index === -1) return null;
    resolved[column] = index;
  }
  for (const column of optional) {
    const index = normalized.findIndex((value) => sets[column].has(value));
    if (index !== -1) resolved[column] = index;
  }
  return resolved;
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? "" : (row[index] ?? "").trim();
}

function dataRows(sheet: WorkbookSheet): { header: string[]; body: string[][] } | null {
  const rows = sheet.rows.filter((row) => row.some((value) => value.trim() !== ""));
  if (rows.length === 0) return null;
  return { body: rows.slice(1), header: rows[0]! };
}

function unsupportedDocument(message: string): AttachmentExtractionResult {
  return {
    code: "unsupported_document",
    failure: "permanent",
    message,
    status: "failure",
  };
}

const UNRECOGNIZED_MESSAGE =
  "No reconozco una tabla de posiciones con nombre, tipo, valor y divisa en esta hoja.";

// The contract accepts at most 20 warnings; a messy sheet can drop more rows than
// that, so the last slot summarizes the overflow instead of losing it silently.
const MAX_WARNINGS = 20;

function capWarnings(warnings: readonly string[]): string[] {
  if (warnings.length <= MAX_WARNINGS) return [...warnings];
  const kept = warnings.slice(0, MAX_WARNINGS - 1);
  kept.push(`y ${warnings.length - (MAX_WARNINGS - 1)} avisos más sin mostrar.`);
  return kept;
}

/** Map a Spanish/English operation label to a movement kind, or null if unknown. */
function resolveOperationKind(value: string): MovementKind | null {
  const normalized = normalizeHeader(value);
  for (const kind of Object.keys(OPERATION_KINDS) as MovementKind[]) {
    if (OPERATION_KINDS[kind].some((alias) => normalized.includes(alias))) return kind;
  }
  return null;
}

/**
 * Normalize a date cell to ISO `YYYY-MM-DD`, or null if it is not a recognizable
 * calendar date. Accepts an already-ISO value and the `dd/mm/yyyy` that the XLSX
 * reader emits from date-styled serials (and that Spanish CSV exports use) — a
 * deterministic reformat, never an invented date. A same-day validity check keeps
 * a `32/13/2026` from slipping through.
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

interface HoldingsSheet {
  header: string[];
  body: string[][];
  columns: Partial<Record<HoldingColumn, number>>;
}

interface MovementsSheet {
  body: string[][];
  columns: Partial<Record<MovementColumn, number>>;
}

/**
 * Classify each worksheet. A sheet with a date + operation + amount is the
 * movements table; a sheet with name + type + value + currency (and no date) is
 * the holdings table. The first of each wins; extra sheets are ignored.
 */
function classifySheets(sheets: readonly WorkbookSheet[]): {
  holdings: HoldingsSheet | null;
  movements: MovementsSheet | null;
} {
  let holdings: HoldingsSheet | null = null;
  let movements: MovementsSheet | null = null;

  for (const sheet of sheets) {
    const parsed = dataRows(sheet);
    if (!parsed) continue;

    if (!movements) {
      const columns = resolveColumns(
        parsed.header,
        MOVEMENT_REQUIRED,
        MOVEMENT_OPTIONAL,
        MOVEMENT_ALIAS_SETS,
      );
      // A movements sheet must also carry a link key (ISIN or name) — without one
      // no movement could ever attribute to a holding, so treat it as not-movements.
      if (columns && (columns.isin !== undefined || columns.name !== undefined)) {
        movements = { body: parsed.body, columns };
        continue;
      }
    }
    if (!holdings) {
      const columns = resolveColumns(
        parsed.header,
        HOLDING_REQUIRED,
        HOLDING_OPTIONAL,
        HOLDING_ALIAS_SETS,
      );
      if (columns) holdings = { body: parsed.body, columns, header: parsed.header };
    }
  }

  return { holdings, movements };
}

/** A non-empty ISIN cell that is a real ISIN once uppercased, else undefined. */
function validIsinOrUndefined(raw: string): string | undefined {
  return raw && isValidIsin(raw) ? raw.trim().toUpperCase() : undefined;
}

/**
 * Read the movements table leniently. An arbitrary Excel is not a broker statement,
 * so a row we cannot confidently read (unknown operation, unparseable date/amount,
 * no link key) is **skipped with a warning**, never invented and never a dead-end —
 * the remaining rows still extract and the skipped rows are visible. A holding whose
 * only movement was skipped simply keeps a lower, honest fidelity tier.
 */
function readMovements(sheet: MovementsSheet): {
  movements: ExtractedMovement[];
  warnings: string[];
} {
  const movements: ExtractedMovement[] = [];
  const warnings: string[] = [];
  const skip = (index: number, reason: string) =>
    warnings.push(`Fila ${index + 2} de movimientos: ${reason}; se ha omitido.`);

  for (const [index, row] of sheet.body.entries()) {
    const operation = cell(row, sheet.columns.operation);
    const kind = resolveOperationKind(operation);
    if (kind === null) {
      skip(index, `no reconozco la operación «${operation}»`);
      continue;
    }
    const isoDate = toIsoDate(cell(row, sheet.columns.date));
    if (isoDate === null) {
      skip(index, "la fecha no es una fecha válida");
      continue;
    }
    const isin = validIsinOrUndefined(cell(row, sheet.columns.isin));
    const nameCell = cell(row, sheet.columns.name);
    const unitsCell = cell(row, sheet.columns.units);
    const candidate = {
      amount: normalizeExtractedNumber(cell(row, sheet.columns.amount)),
      currency: cell(row, sheet.columns.currency).toUpperCase(),
      date: isoDate,
      kind,
      ...(isin ? { isin } : {}),
      ...(nameCell ? { name: nameCell } : {}),
      ...(unitsCell ? { units: normalizeExtractedNumber(unitsCell) } : {}),
    };
    const parsed = extractedMovementSchema.safeParse(candidate);
    if (!parsed.success) {
      skip(index, "faltan datos o no son válidos");
      continue;
    }
    movements.push(parsed.data);
  }
  return { movements, warnings };
}

/**
 * Read the holdings table leniently. Malformed optional fields (a bad ISIN, a
 * non-numeric declared cost) are dropped-and-warned on an otherwise valid row; a
 * row missing a required field (name, value, currency) — a subtotal or "Total"
 * line, or a genuine gap — is skipped with a warning rather than failing the whole
 * document. Nothing is ever guessed (ADR 0048).
 */
function readHoldings(
  sheet: HoldingsSheet,
  movements: readonly ExtractedMovement[],
): { holdings: ExtractedHolding[]; warnings: string[] } {
  const holdings: ExtractedHolding[] = [];
  const warnings: string[] = [];
  for (const [index, row] of sheet.body.entries()) {
    const rawIsin = cell(row, sheet.columns.isin);
    const validIsin = validIsinOrUndefined(rawIsin);
    const rawCost = cell(row, sheet.columns.declaredCost);
    const declaredCost = rawCost ? normalizeExtractedNumber(rawCost) : null;

    let uncertain = false;
    if (rawIsin && !validIsin) {
      uncertain = true;
      warnings.push(
        `Fila ${index + 2}: el ISIN «${rawIsin}» no es válido y se ha ignorado.`,
      );
    }
    if (rawCost && declaredCost === null) {
      uncertain = true;
      warnings.push(
        `Fila ${index + 2}: el coste declarado «${rawCost}» no es un número y se ha ignorado.`,
      );
    }

    const base = {
      currency: cell(row, sheet.columns.currency).toUpperCase(),
      name: cell(row, sheet.columns.name),
      type: cell(row, sheet.columns.type),
      value: normalizeExtractedNumber(cell(row, sheet.columns.value)),
      ...(validIsin ? { isin: validIsin } : {}),
      ...(declaredCost !== null ? { declaredCost } : {}),
      ...(uncertain ? { uncertain: true } : {}),
    };
    const fidelity = resolveHoldingFidelity(
      { declaredCost: declaredCost ?? undefined, isin: validIsin, name: base.name },
      movements,
    );
    const parsed = extractedHoldingSchema.safeParse({ ...base, fidelity });
    if (!parsed.success) {
      warnings.push(
        `Fila ${index + 2} de posiciones: faltan datos (nombre, tipo, valor o divisa); se ha omitido.`,
      );
      continue;
    }
    holdings.push(parsed.data);
  }
  return { holdings, warnings };
}

/**
 * Deterministically map a portfolio spreadsheet into the positions + movements
 * contract. Returns `unrecognized` when no holdings table is present, so the caller
 * can fall back to the broker-positions recognizer and then to unstructured context.
 */
export function extractPositionsAndMovementsFromSpreadsheet(
  input: PositionsMovementsExtractionInput,
): AttachmentExtractionResult {
  const initialLimit = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "spreadsheet",
    mimeType: input.mimeType,
    rowCount: 0,
    sizeBytes: input.bytes.byteLength,
  });
  if (initialLimit) return initialLimit;

  const grids = readSpreadsheetGrids({ bytes: input.bytes, fileName: input.fileName });
  if (grids.status === "unreadable") {
    return unsupportedDocument("La hoja no se puede leer.");
  }

  const { holdings: holdingsSheet, movements: movementsSheet } = classifySheets(
    grids.sheets,
  );
  if (!holdingsSheet) return { message: UNRECOGNIZED_MESSAGE, status: "unrecognized" };

  const holdingRows = holdingsSheet.body.filter((row) =>
    row.some((value) => value.trim() !== ""),
  );
  const rowLimit = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "spreadsheet",
    mimeType: input.mimeType,
    rowCount: holdingRows.length + (movementsSheet ? movementsSheet.body.length : 0),
    sizeBytes: input.bytes.byteLength,
  });
  if (rowLimit) return rowLimit;

  const movementsRead = movementsSheet
    ? readMovements(movementsSheet)
    : { movements: [], warnings: [] };
  const holdingsRead = readHoldings(holdingsSheet, movementsRead.movements);

  // A recognized sheet that yielded no usable holding is not a portfolio after all;
  // fall back so the broker-positions recognizer and then #865 unstructured context
  // still get a turn rather than dead-ending on a failure card.
  if (holdingsRead.holdings.length === 0) {
    return { message: UNRECOGNIZED_MESSAGE, status: "unrecognized" };
  }

  return parseExtractionResult({
    data: {
      documentType: "positions_movements",
      holdings: holdingsRead.holdings,
      movements: movementsRead.movements,
      warnings: capWarnings([...holdingsRead.warnings, ...movementsRead.warnings]),
    },
    status: "valid",
  });
}
