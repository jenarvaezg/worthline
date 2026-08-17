import type { WorkbookSheet } from "@web/spreadsheet-text";

import {
  type AttachmentExtractionResult,
  capExtractionWarnings,
  checkAttachmentLimits,
  type DatedBalance,
  datedBalanceSchema,
  normalizeExtractedNumber,
  parseExtractionResult,
} from "./attachment-extraction-contract";
import {
  normalizeHeader,
  readSpreadsheetGrids,
  type SpreadsheetGridInput,
  toIsoDate,
} from "./attachment-spreadsheet-grid";

/**
 * Deterministic extractor for the **dated balance series** document from a
 * spreadsheet (#1417) — the third arm of the sheet dispatch.
 *
 * The contract, the preview card and `propose_reconstruction` behind it already
 * existed; only the vision lane could produce a `balance_series`, so the SAME
 * amortization schedule wrote history as a PDF and was refused as an `.xlsx`,
 * which then closed the unvalidated-evidence gate (#1248) for the rest of the
 * conversation. Nothing about that ordering was defensible: the workbook is the
 * exact reading, parsed rather than looked at.
 *
 * The two behaviours that are genuinely new both come from a real file (a Santander
 * schedule kept as a 13-sheet workbook):
 *
 * - **The header is searched for, not assumed.** The sibling recognizers take row
 *   one as the header; this table starts on row 20, under a wide matrix of rate
 *   revisions and a title. The first row that resolves a date column and a balance
 *   column and whose reading {@link isOneSeries} accepts is the header — see there for
 *   the three conditions and the false positive each one answers.
 * - **A sparse balance column is normal.** The bank fills the balance on 49 of
 *   ~380 monthly rows; a gap is not a defect but the absence of an observation, so
 *   it is skipped in silence. Warnings are owed only where the sheet printed
 *   something we could not read — and a figure buried in prose counts as unread, not
 *   as a balance ({@link splitCellCurrency}).
 *
 * What stays forbidden is what the contract has always forbidden (ADR 0048): only
 * *observed* balances are read. The wide matrix above the table holds the rate
 * revisions and the term, and none of it is inferred, derived or carried — that
 * modelling belongs to the deterministic schedule import, not here.
 *
 * Security: like every deterministic sheet route, no model runs, so the untrusted
 * workbook never reaches one. The only text that survives is dates, three-letter
 * currency codes and our own generated warnings.
 */

export type BalanceSeriesExtractionInput = SpreadsheetGridInput & {
  mimeType: string;
};

const DATE_ALIASES = [
  "fecha",
  "date",
  "fecha valor",
  "fecha de pago",
  "fecha pago",
  "fecha de cargo",
  "fecha cuota",
  "fecha vencimiento",
  "fecha de vencimiento",
  "vencimiento",
] as const;

/**
 * What a bank calls the balance still owed. Deliberately WITHOUT bare «capital» and
 * «cuota»: in a Spanish amortization schedule those are the principal and the
 * instalment PAID that month, so reading either as the outstanding balance would
 * turn a 665,80 € payment into a 665,80 € mortgage.
 */
const BALANCE_ALIASES = [
  "saldo",
  "saldo pendiente",
  "saldo vivo",
  "saldo deudor",
  "saldo restante",
  "saldo final",
  "capital pendiente",
  "capital vivo",
  "capital pendiente de amortizar",
  "principal pendiente",
  "deuda pendiente",
  "importe pendiente",
  "pendiente",
  "balance",
  "outstanding balance",
  "remaining balance",
] as const;

const CURRENCY_ALIASES = ["divisa", "moneda", "currency"] as const;

/**
 * What a sheet calls the THING each row is about. This document is one product's
 * balance over time and has no field to carry a per-row name, so a column like this
 * is how a sheet says it is something else — and reading it anyway would drop the
 * only column that says what each figure belongs to.
 *
 * The case is real and it is the eval's own «apuntes de la familia»: six accounts and
 * two loans, all dated the same day, under `Concepto;Saldo;Fecha`. Six balances of six
 * different things is not a series, and this is the guard that says so.
 */
const LABEL_ALIASES = [
  "concepto",
  "descripción",
  "descripcion",
  "detalle",
  "nombre",
  "name",
  "producto",
  "cuenta",
  "préstamo",
  "prestamo",
  "deuda",
  "instrumento",
] as const;

const DATE_HEADERS: ReadonlySet<string> = new Set(DATE_ALIASES.map(normalizeHeader));
const BALANCE_HEADERS: ReadonlySet<string> = new Set(
  BALANCE_ALIASES.map(normalizeHeader),
);
const CURRENCY_HEADERS: ReadonlySet<string> = new Set(
  CURRENCY_ALIASES.map(normalizeHeader),
);
const LABEL_HEADERS: ReadonlySet<string> = new Set(LABEL_ALIASES.map(normalizeHeader));

/**
 * The currency a decoration can stand for. A CLOSED, tiny vocabulary on purpose:
 * this path guesses a currency from ink next to a figure («Saldo (€)», «1.234,56 €»),
 * and any three-letter word would otherwise qualify — a «Saldo mes» column would
 * declare its balances to be in MES. A sheet in any other currency is still read in
 * full through the explicit `Divisa` column: a cell there is looked up here first (so
 * a column of «€» works) and otherwise taken verbatim as the code it claims to be.
 */
const CURRENCY_DECORATIONS: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
  chf: "CHF",
  eur: "EUR",
  gbp: "GBP",
  jpy: "JPY",
  usd: "USD",
};

/**
 * The currency a series is read in when the sheet prints NONE — the ordinary case
 * for an amortization schedule, which states no currency anywhere (measured: the
 * balance column of the real file carries Excel's plain `#,##0.00`, no symbol).
 *
 * The contract requires a currency per balance and the reading would otherwise have
 * no legal shape to land in, so the assumption is made once, HERE, and it is never
 * silent. What the USER sees is the warning below, which the preview card paints; the
 * document-level `uncertain` is the machine-readable half and reaches the model, not
 * the card (`attachment-extraction-preview.tsx` renders only per-row uncertainty, and
 * marking all 49 rows «revisar lectura» would put the caveat on the dates and amounts,
 * which are exact — the currency label is the only doubt).
 *
 * That is the frontier this whole lane is built on: an assumption stated on the card
 * of a user who must confirm before anything is written is not the invention ADR 0048
 * forbids; an assumption nobody is told about would be.
 */
const ASSUMED_CURRENCY = "EUR";

const ASSUMED_CURRENCY_WARNING =
  "La hoja no indica la divisa de los saldos; se han leído en EUR. Revísalo antes de confirmar.";

const UNRECOGNIZED_MESSAGE =
  "No reconozco una serie de saldos fechados en esta hoja. Revisa que tenga una columna de fecha y otra de saldo pendiente.";

interface BalanceColumns {
  date: number;
  balance: number;
  currency: number | undefined;
  /** Where the sheet names what each row is about — see {@link LABEL_ALIASES}. */
  label: number | undefined;
  /** The currency the balance HEADER printed, when it printed one. */
  headerCurrency: string | undefined;
}

interface BalanceTable {
  sheetName: string;
  balances: DatedBalance[];
  warnings: string[];
  /** True when at least one row fell back to {@link ASSUMED_CURRENCY}. */
  assumedCurrency: boolean;
  /** The distinct row labels read, when the table carried a label column. */
  labels: Set<string>;
}

/**
 * How much of a cell is read before deciding what it is. A header label and a money
 * cell are both short by nature, and every cell of every sheet passes through here:
 * an XLSX cell holds 32 767 characters and a CSV field more, so an unbounded scan is
 * a CPU surface the upload controls. Past this length a cell is not a header and not
 * a figure — it is prose, and prose is neither.
 */
const MAX_CELL_CHARS = 120;

/**
 * How many candidate header rows one sheet is allowed to cost. Every candidate
 * rescans the rows under it, so an unbounded search is quadratic in sheet height —
 * measured at 2,6 s for 20 000 rows of `Fecha;Saldo`, and the 4 MiB body admits
 * ~366 000 of them. A bound on the CANDIDATES keeps the work linear without bounding
 * WHERE the header may sit, which is the freedom this recognizer exists for.
 */
const MAX_HEADER_CANDIDATES = 25;

/**
 * The figure inside a money cell, with whatever surrounds it. Anchored and with no
 * two adjacent variable-length parts over the same characters: `[^\d]*?` cannot
 * overlap the digits it stops before.
 */
const NUMBER_IN_CELL = /^([^\d]*?)([+-]?[\d.,\s ]*\d)([^\d]*)$/;

/** The code a printed decoration stands for, or undefined when it stands for nothing. */
function currencyFromDecoration(token: string): string | undefined {
  const compact = token
    .replace(/[()[\]\s]/g, "")
    .trim()
    .toLowerCase();
  return compact === "" ? undefined : CURRENCY_DECORATIONS[compact];
}

/** The separators a currency decoration may hide behind: a space, «(» or «[». */
function isDecorationBoundary(char: string): boolean {
  return char === "(" || char === "[" || /\s/.test(char);
}

/**
 * Split «Saldo (€)» or «Capital pendiente EUR» into the label to match and the
 * currency it declares. A separator before the token is required, or the last three
 * letters of «Saldo» would read as a currency called LDO.
 *
 * One backwards scan rather than a regex: the pattern this replaces had three
 * variable-length parts competing over the same whitespace, and one cell of 3 000
 * spaces cost 5 s of cubic backtracking — in a function that runs over every cell of
 * every sheet while hunting for the header, so no header bound protected it.
 */
function splitHeaderCurrency(value: string): {
  label: string;
  currency: string | undefined;
} {
  const trimmed = value.trim().slice(0, MAX_CELL_CHARS);
  const plain = { currency: undefined, label: normalizeHeader(value) };

  let end = trimmed.length;
  if (trimmed.endsWith(")") || trimmed.endsWith("]")) end -= 1;
  let start = end;
  while (start > 0 && !isDecorationBoundary(trimmed[start - 1]!)) start -= 1;
  if (start === 0 || start === end) return plain;

  const currency = currencyFromDecoration(trimmed.slice(start, end));
  // The boundary itself belongs to the decoration, not to the label: «Capital
  // pendiente (€)» must match the alias «capital pendiente», bracket dropped.
  return currency === undefined
    ? plain
    : {
        currency,
        label: normalizeHeader(trimmed.slice(0, start).replace(/[([\s]+$/, "")),
      };
}

/**
 * Split «169.653,18 €» into the figure, the currency printed beside it, and whatever
 * ELSE the cell said. That residue is the honesty half: the `Saldo` column is exactly
 * where a real bank sheet writes its annotations, and «Pendiente de confirmar, ver
 * hoja 2» carries a 2 that a find-the-number-anywhere reading hands back as an
 * observed balance of 2 €. A cell with leftovers is a cell we could not read, and it
 * is warned about rather than mined for digits (ADR 0048).
 */
function splitCellCurrency(value: string): {
  amount: string;
  currency: string | undefined;
  residue: string;
} {
  const parts = NUMBER_IN_CELL.exec(value.slice(0, MAX_CELL_CHARS));
  if (!parts) return { amount: value, currency: undefined, residue: value.trim() };

  const prefix = parts[1] ?? "";
  const suffix = parts[3] ?? "";
  const fromSuffix = currencyFromDecoration(suffix);
  const currency = fromSuffix ?? currencyFromDecoration(prefix);
  const leftovers =
    currency === undefined ? [prefix, suffix] : fromSuffix ? [prefix] : [suffix];
  return {
    amount: parts[2]!,
    currency,
    residue: leftovers.join("").trim(),
  };
}

/**
 * The date + balance (+ currency, + label) columns this row declares, if a header.
 * Within each family the LEFTMOST match wins: a sheet printing both «Fecha de cargo»
 * and «Fecha vencimiento» is read on the first of the two, and there is no ranking
 * among the aliases that would be more truthful than the sheet's own order.
 */
function resolveColumns(row: readonly string[]): BalanceColumns | null {
  let date: number | undefined;
  let balance: number | undefined;
  let currency: number | undefined;
  let label: number | undefined;
  let headerCurrency: string | undefined;

  for (const [index, raw] of row.entries()) {
    const header = splitHeaderCurrency(raw);
    if (date === undefined && DATE_HEADERS.has(header.label)) {
      date = index;
    } else if (balance === undefined && BALANCE_HEADERS.has(header.label)) {
      balance = index;
      headerCurrency = header.currency;
    } else if (currency === undefined && CURRENCY_HEADERS.has(header.label)) {
      currency = index;
    } else if (label === undefined && LABEL_HEADERS.has(header.label)) {
      label = index;
    }
  }

  return date === undefined || balance === undefined
    ? null
    : { balance, currency, date, headerCurrency, label };
}

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

/**
 * How a cell is quoted back inside a warning. Clamped, because the cell is untrusted
 * and each warning is capped at 300 characters by the contract: an over-long one fails
 * the branded parse and turns the whole reading into `invalid_output`, which is
 * strictly worse than `unrecognized` — only `unrecognized` keeps #865's lane, so a
 * long cell would take a conversational file and dead-end it on the card.
 */
function quoteCell(value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length > 60 ? `«${compact.slice(0, 60)}…»` : `«${compact}»`;
}

/**
 * Read the observations under a header row. Rows are numbered from the header — «fila 1
 * de la tabla» is the first row under it — and NOT by their position in the sheet: the
 * grid reader drops blank rows (CSV) and ignores the `r` attribute (XLSX), so a
 * sheet-relative count would name a row Excel numbers differently, which on the very
 * file this exists for (a table under 19 rows of matrix, with blanks inside it) is the
 * shape where it would be wrong.
 *
 * A blank balance cell — or a `—` placeholder — is not an observation and is passed
 * over in silence: on a monthly schedule the bank fills the balance a few times a
 * year, and 300 warnings about the gaps would bury the real ones.
 */
function readBalances(
  rows: readonly string[][],
  from: number,
  columns: BalanceColumns,
): Omit<BalanceTable, "sheetName"> {
  const balances: DatedBalance[] = [];
  const warnings: string[] = [];
  const labels = new Set<string>();
  let assumedCurrency = false;

  for (let index = from; index < rows.length; index += 1) {
    const row = rows[index]!;
    const rawBalance = (row[columns.balance] ?? "").trim();
    if (!hasDigit(rawBalance)) continue;

    const rowNumber = index - from + 1;
    const observed = splitCellCurrency(rawBalance);
    const amount = normalizeExtractedNumber(observed.amount);
    if (amount === null) {
      warnings.push(
        `Fila ${rowNumber} de la tabla: el saldo ${quoteCell(rawBalance)} no es un número; se ha omitido.`,
      );
      continue;
    }
    // A figure with prose around it is not a printed balance (see splitCellCurrency).
    if (observed.residue !== "") {
      warnings.push(
        `Fila ${rowNumber} de la tabla: ${quoteCell(rawBalance)} no es solo un saldo; se ha omitido.`,
      );
      continue;
    }

    const date = toIsoDate((row[columns.date] ?? "").trim());
    if (date === null) {
      warnings.push(
        `Fila ${rowNumber} de la tabla: la fecha no es una fecha válida; se ha omitido.`,
      );
      continue;
    }

    // The declared column goes through the SAME decoration table as the cell and the
    // header: a `Divisa` column holding «€» said its currency as plainly as a cell
    // would, and killing the row for it was the inverse of the other two paths.
    const declaredCell =
      columns.currency === undefined ? "" : (row[columns.currency] ?? "").trim();
    const declared =
      currencyFromDecoration(declaredCell) ?? (declaredCell || undefined)?.toUpperCase();
    const printed = declared ?? observed.currency ?? columns.headerCurrency;
    if (printed !== undefined && !/^[A-Z]{3}$/.test(printed)) {
      warnings.push(
        `Fila ${rowNumber} de la tabla: la divisa ${quoteCell(printed)} no es un código de tres letras; se ha omitido.`,
      );
      continue;
    }
    if (printed === undefined) assumedCurrency = true;

    const parsed = datedBalanceSchema.safeParse({
      amount,
      currency: printed ?? ASSUMED_CURRENCY,
      date,
    });
    if (!parsed.success) {
      warnings.push(
        `Fila ${rowNumber} de la tabla: el saldo leído no es válido; se ha omitido.`,
      );
      continue;
    }
    balances.push(parsed.data);
    const rowLabel =
      columns.label === undefined ? "" : normalizeHeader(row[columns.label] ?? "");
    if (rowLabel !== "") labels.add(rowLabel);
  }

  return { assumedCurrency, balances, labels, warnings };
}

/**
 * Is this reading ONE product's balance over time? Three conditions, each answering a
 * measured false positive:
 *
 * - **at least one observation** — a summary block naming a «Saldo» and a «Fecha de
 *   cálculo» resolves columns and yields nothing, so the search moves on instead of
 *   declaring the sheet read;
 * - **at most one distinct row label** — several named products is a portfolio
 *   snapshot, not a series ({@link LABEL_ALIASES});
 * - **more than one distinct date, once there is more than one observation** — the
 *   vocabulary-independent half of the same guard, and the one that catches the label
 *   column an alias list has never heard of («Producto financiero», «Titular»): six
 *   figures sharing one date are six things at a moment, not one thing over time. A
 *   single dated balance stays a series of one, which is exactly what a debt statement
 *   is.
 */
function isOneSeries(read: Omit<BalanceTable, "sheetName">): boolean {
  if (read.balances.length === 0 || read.labels.size > 1) return false;
  const dates = new Set(read.balances.map((balance) => balance.date));
  return read.balances.length === 1 || dates.size > 1;
}

/**
 * Find the dated balance table of ONE worksheet: the first header row whose reading is
 * a series. Candidates are bounded ({@link MAX_HEADER_CANDIDATES}) and the rows below
 * are read in place rather than sliced, so a pathological sheet where every row looks
 * like a header costs linear work instead of quadratic.
 */
function readBalanceTable(sheet: WorkbookSheet): BalanceTable | null {
  let candidates = 0;
  for (const [index, row] of sheet.rows.entries()) {
    const columns = resolveColumns(row);
    if (!columns) continue;
    if (candidates >= MAX_HEADER_CANDIDATES) return null;
    candidates += 1;
    const read = readBalances(sheet.rows, index + 1, columns);
    if (isOneSeries(read)) return { ...read, sheetName: sheet.name };
  }
  return null;
}

function unsupportedDocument(message: string): AttachmentExtractionResult {
  return {
    code: "unsupported_document",
    failure: "permanent",
    message,
    status: "failure",
  };
}

/** How a workbook says which of its sheets was read, when more than one qualified. */
function sheetChoiceWarning(read: string, ignored: readonly string[]): string {
  const label = (name: string) => `«${name.trim() || "sin nombre"}»`;
  const names = ignored.map(label).join(", ");
  const tail =
    ignored.length === 1
      ? `${names} también parece llevar saldos fechados y no se ha leído`
      : `${names} también parecen llevar saldos fechados y no se han leído`;
  return `He leído los saldos de la hoja ${label(read)}; ${tail}.`;
}

/**
 * Deterministically map a dated balance series (a debt statement or an amortization
 * schedule) into the shared contract. Returns `unrecognized` when no worksheet
 * carries a date + balance table, so the caller can still fall back to #865's
 * unstructured context.
 *
 * When SEVERAL sheets qualify the first one wins and the reading says so. The
 * workbook that motivated this carries a second mortgage on sheet 11, and no
 * deterministic rule can know which one the user meant — so the card names the sheet
 * it read and the others it saw, which is the honest half of the answer and the half
 * the user can act on.
 */
export function extractBalanceSeriesFromSpreadsheet(
  input: BalanceSeriesExtractionInput,
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

  const tables = grids.sheets
    .map((sheet) => readBalanceTable(sheet))
    .filter((table): table is BalanceTable => table !== null);
  const [table, ...ignored] = tables;
  if (!table) return { message: UNRECOGNIZED_MESSAGE, status: "unrecognized" };

  // The bound that matters is the number of OBSERVATIONS, not the height of the
  // sheet: a 40-year schedule is 480 monthly rows carrying a few dozen balances, and
  // measuring the sheet would refuse it for rows this document never claims to read.
  const rowLimit = checkAttachmentLimits({
    fileName: input.fileName,
    kind: "spreadsheet",
    mimeType: input.mimeType,
    rowCount: table.balances.length,
    sizeBytes: input.bytes.byteLength,
  });
  if (rowLimit) return rowLimit;

  // Both disclosures about the reading AS A WHOLE go first: the per-row noise of a
  // messy sheet can reach the contract's warning cap on its own, and what the cap drops
  // must not be «which sheet did you read» or «in what currency».
  const warnings = [
    ...(table.assumedCurrency ? [ASSUMED_CURRENCY_WARNING] : []),
    ...(ignored.length > 0
      ? [
          sheetChoiceWarning(
            table.sheetName,
            ignored.map((other) => other.sheetName),
          ),
        ]
      : []),
    ...table.warnings,
  ];

  return parseExtractionResult({
    data: {
      balances: table.balances,
      documentType: "balance_series",
      warnings: capExtractionWarnings(warnings),
      ...(table.assumedCurrency ? { uncertain: true } : {}),
    },
    status: "valid",
  });
}
