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
 * Two behaviours are genuinely new here, and both come from a real file (a
 * Santander schedule kept as a 13-sheet workbook):
 *
 * - **The header is searched for, not assumed.** The sibling recognizers take row
 *   one as the header; this table starts on row 20, under a wide matrix of rate
 *   revisions and a title. The first row that resolves a date column AND a balance
 *   column AND has at least one readable observation under it is the header — that
 *   last condition is what keeps a stray «Saldo» label in a summary block from
 *   being mistaken for a table.
 * - **A sparse balance column is normal.** The bank fills the balance on 49 of
 *   ~380 monthly rows; a gap is not a defect but the absence of an observation, so
 *   it is skipped in silence. Warnings are owed only where the sheet printed
 *   something we could not read.
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
 * full through the explicit `Divisa` column, which is taken verbatim.
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
 * silent: it raises a warning the preview card paints and marks the document
 * `uncertain`, in front of a user who must confirm before anything is written. That
 * is the frontier this whole lane is built on — an assumption the user can see and
 * refuse is not the invention ADR 0048 forbids; an assumption nobody is told about
 * would be.
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

/** The code a printed decoration stands for, or undefined when it stands for nothing. */
function currencyFromDecoration(token: string): string | undefined {
  const compact = token
    .trim()
    .replace(/[()[\]]/g, "")
    .trim()
    .toLowerCase();
  return compact === "" ? undefined : CURRENCY_DECORATIONS[compact];
}

/**
 * Split «Saldo (€)» or «Capital pendiente EUR» into the label to match and the
 * currency it declares. A separator before the token is required, or the last three
 * letters of «Saldo» would read as a currency called LDO.
 */
function splitHeaderCurrency(value: string): {
  label: string;
  currency: string | undefined;
} {
  const decorated = /^(.+?)(?:\s+|\s*[([])\s*(\p{Sc}|[A-Za-z]{3})\s*[)\]]?$/u.exec(
    value.trim(),
  );
  const currency = decorated ? currencyFromDecoration(decorated[2]!) : undefined;
  return currency === undefined
    ? { currency: undefined, label: normalizeHeader(value) }
    : { currency, label: normalizeHeader(decorated?.[1] ?? value) };
}

/** Split «169.653,18 €» into the figure and the currency printed beside it. */
function splitCellCurrency(value: string): {
  amount: string;
  currency: string | undefined;
} {
  const parts = /^([^\d]*?)\s*([+-]?[\d.,\s ]*\d)\s*([^\d]*)$/.exec(value);
  if (!parts) return { amount: value, currency: undefined };
  const token = (parts[3] ?? "").trim() || (parts[1] ?? "").trim();
  return { amount: parts[2]!, currency: currencyFromDecoration(token) };
}

/** The date + balance (+ currency, + label) columns this row declares, if a header. */
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
 * Read the observations under a header row. `offset` is the 0-based index of the
 * first data row in the sheet, so a warning names the row the user sees in Excel.
 *
 * A blank balance cell — or a `—` placeholder — is not an observation and is passed
 * over in silence: on a monthly schedule the bank fills the balance a few times a
 * year, and 300 warnings about the gaps would bury the real ones.
 */
function readBalances(
  rows: readonly string[][],
  offset: number,
  columns: BalanceColumns,
): Omit<BalanceTable, "sheetName"> {
  const balances: DatedBalance[] = [];
  const warnings: string[] = [];
  const labels = new Set<string>();
  let assumedCurrency = false;

  for (const [index, row] of rows.entries()) {
    const rawBalance = (row[columns.balance] ?? "").trim();
    if (!hasDigit(rawBalance)) continue;

    const rowNumber = offset + index + 1;
    const observed = splitCellCurrency(rawBalance);
    const amount = normalizeExtractedNumber(observed.amount);
    if (amount === null) {
      warnings.push(
        `Fila ${rowNumber}: el saldo «${rawBalance}» no es un número; se ha omitido.`,
      );
      continue;
    }

    const date = toIsoDate((row[columns.date] ?? "").trim());
    if (date === null) {
      warnings.push(`Fila ${rowNumber}: la fecha no es una fecha válida; se ha omitido.`);
      continue;
    }

    const declared =
      columns.currency === undefined
        ? ""
        : (row[columns.currency] ?? "").trim().toUpperCase();
    const printed = declared || observed.currency || columns.headerCurrency;
    if (printed !== undefined && !/^[A-Z]{3}$/.test(printed)) {
      warnings.push(
        `Fila ${rowNumber}: la divisa «${printed}» no es un código de tres letras; se ha omitido.`,
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
      warnings.push(`Fila ${rowNumber}: el saldo leído no es válido; se ha omitido.`);
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
 * Find the dated balance table of ONE worksheet: the first header row that yields a
 * series. Two conditions make a header a table, and each answers a measured
 * false positive:
 *
 * - **at least one observation under it** — a summary block naming a «Saldo» and a
 *   «Fecha de cálculo» resolves columns and yields nothing, so the search moves on
 *   instead of declaring the sheet read;
 * - **at most one distinct row label** — several named products under one date is a
 *   snapshot of a portfolio, not one balance over time ({@link LABEL_ALIASES}).
 */
function readBalanceTable(sheet: WorkbookSheet): BalanceTable | null {
  for (const [index, row] of sheet.rows.entries()) {
    const columns = resolveColumns(row);
    if (!columns) continue;
    const read = readBalances(sheet.rows.slice(index + 1), index + 1, columns);
    if (read.balances.length > 0 && read.labels.size <= 1) {
      return { ...read, sheetName: sheet.name };
    }
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

  const warnings = [
    ...(table.assumedCurrency ? [ASSUMED_CURRENCY_WARNING] : []),
    ...table.warnings,
    ...(ignored.length > 0
      ? [
          sheetChoiceWarning(
            table.sheetName,
            ignored.map((other) => other.sheetName),
          ),
        ]
      : []),
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
