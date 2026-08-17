import Big from "big.js";

import type { DecimalString } from "./decimal";
import { parseDecimalStrict } from "./money";

/**
 * Reader for a bank's **cuadro de amortización** (#1406) — the document every
 * mortgage holder already has, and the only realistic way to enter twenty years
 * of interest-rate revisions and early repayments.
 *
 * It is a different reader from the statement one on purpose (the decision on
 * #1406: «una puerta, dos lectores»). A statement row is a **book event** stored
 * as it comes; an amortization schedule is the **output of a generative model**
 * — plan + revisions + early repayments generate the curve (`amortization.ts`).
 * So this reader never returns rows to store: it returns the MODEL INPUTS the
 * document reveals, plus the balances the document itself declares, which is
 * what makes a cuadro self-verifying (see `amortization-schedule-import.ts`).
 *
 * Two layouts, both read from the same sheet when both are present:
 *
 * - **Wide matrix** — the Santander shape: one column per anniversary, rows
 *   `Capital` / `Interés` / `Plazo` / `Amortiz Anticipada`. Here `Capital` IS the
 *   outstanding balance (the matrix is keyed by revision dates, not by cuotas),
 *   and `Interés` IS a rate. This is the only place a rate is ever read from a
 *   bare «Interés» label.
 * - **Long table** — a row per period: `Fecha`, `Cuota`, `Capital`, `Interés`,
 *   `Extra`, `Saldo`. Here bare `Capital`/`Interés` are MONEY (the month's
 *   principal and interest) and are never read as balance or rate — the lesson
 *   of #1417, where reading `Capital` as the outstanding balance turned a 665,80 €
 *   payment into a balance. A rate column is read only under an explicitly
 *   rate-shaped header (`Tipo`, `TIN`, `Interés %`).
 *
 * The whole workbook is swept and the first sheet that yields model inputs wins;
 * the reading says which sheet it read and which it saw, because a real file
 * carries the owner's own analysis sheets beside the bank's table (#1406) and a
 * reader that assumes sheet one is a reader that fails on the real file.
 *
 * Pure: no clock, no I/O, no model call. The untrusted document never reaches an
 * LLM, and the only text that survives is dates, numbers and our own warnings.
 */

/** One worksheet as a neutral cell matrix — a CSV arrives as a single unnamed sheet. */
export interface ScheduleSheet {
  name: string;
  rows: readonly (readonly string[])[];
}

/** A rate change the document declares, as a fraction (`"0.027"` is 2,7 %). */
export interface ScheduleRateRevision {
  revisionDate: string;
  annualInterestRate: DecimalString;
}

/** A lump against the principal the document declares. */
export interface ScheduleEarlyRepayment {
  repaymentDate: string;
  amountMinor: number;
}

/** An outstanding balance the document declares on a date — the witness. */
export interface ScheduleDeclaredBalance {
  dateKey: string;
  balanceMinor: number;
}

export interface AmortizationScheduleReading {
  /** The sheet the reading came from (`""` for a CSV). */
  sheetName: string;
  revisions: ScheduleRateRevision[];
  earlyRepayments: ScheduleEarlyRepayment[];
  declaredBalances: ScheduleDeclaredBalance[];
  /**
   * Every rate in the document is ≤ 1, so «0,027» could be the fraction 2,7 % or
   * the percentage 0,027 %. The heuristic picks the fraction; the import plan
   * re-measures the other reading against the declared balances and switches if
   * that one is the one that reproduces them (#1406 — a cuadro verifies itself).
   */
  rateScaleAmbiguous: boolean;
  warnings: string[];
}

export type AmortizationScheduleReadResult =
  | { ok: true; value: AmortizationScheduleReading }
  | { ok: false; message: string };

const UNRECOGNIZED =
  "No reconozco este archivo como un cuadro de amortización: no encuentro ni una tabla de tipos por fecha ni una columna de tipo aplicado. Sube el cuadro que te da el banco (Excel o CSV), con las fechas de revisión y el tipo de cada período.";

/** How many rows below a matrix header row are scanned for its labelled rows. */
const MATRIX_BODY_ROWS = 12;

/** A rate above this is not a rate but money in a mislabelled column. */
const MAX_PLAUSIBLE_ANNUAL_RATE_PERCENT = 40;

function normalizeLabel(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** `d/m/aaaa`, `dd/mm/aaaa` or `aaaa-mm-dd` → `yyyy-mm-dd`, else null. */
function parseScheduleDate(raw: string): string | null {
  const trimmed = raw.trim();
  const spanish = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (!spanish && !iso) return null;

  const [year, month, day] = spanish
    ? [Number(spanish[3]), Number(spanish[2]), Number(spanish[1])]
    : [Number(iso![1]), Number(iso![2]), Number(iso![3])];

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * A number out of a cell that may carry a currency symbol, a percent sign or
 * non-breaking spaces. Returns the bare figure and whether the cell said «%» —
 * an explicit percent sign settles the scale question that
 * {@link AmortizationScheduleReading.rateScaleAmbiguous} otherwise leaves open.
 */
function parseCellNumber(raw: string): { value: number; percent: boolean } | null {
  const trimmed = raw.replace(/\u00a0/g, " ").trim();
  if (trimmed === "") return null;
  const percent = trimmed.includes("%");
  const bare = trimmed.replace(/[%€$£\s]/g, "");
  const value = parseDecimalStrict(bare);
  return value === null ? null : { percent, value };
}

function parseMoneyMinor(raw: string): number | null {
  const parsed = parseCellNumber(raw);
  return parsed === null ? null : Math.round(parsed.value * 100);
}

// ── The wide matrix ─────────────────────────────────────────────────────────

const RATE_LABELS = new Set(
  [
    "interes",
    "interes anual",
    "tipo",
    "tipo de interes",
    "tipo aplicado",
    "tipo nominal",
    "tin",
  ].map(normalizeLabel),
);

const BALANCE_LABELS = new Set(
  [
    "capital",
    "capital pendiente",
    "capital vivo",
    "saldo",
    "saldo pendiente",
    "principal",
    "pendiente",
  ].map(normalizeLabel),
);

const EARLY_REPAYMENT_LABELS = new Set(
  [
    "amortiz anticipada",
    "amortizacion anticipada",
    "amortizaciones anticipadas",
    "amortizacion extra",
    "extra",
    "aportacion extra",
  ].map(normalizeLabel),
);

interface RawRate {
  dateKey: string;
  value: number;
  percent: boolean;
}

interface MatrixReading {
  rates: RawRate[];
  balances: ScheduleDeclaredBalance[];
  earlyRepayments: ScheduleEarlyRepayment[];
}

/** Column index → date, for a row whose cells (past the first) are dates. */
function dateColumns(row: readonly string[]): Map<number, string> {
  const columns = new Map<number, string>();
  for (let index = 1; index < row.length; index += 1) {
    const dateKey = parseScheduleDate(row[index] ?? "");
    if (dateKey) columns.set(index, dateKey);
  }
  return columns;
}

/**
 * Read the wide matrix whose header is `row` — the block of labelled rows under a
 * header of dates. Returns null unless it carries a rate row, which is the only
 * thing that distinguishes a schedule matrix from any other dates-across-the-top
 * table.
 */
function readMatrixAt(
  rows: readonly (readonly string[])[],
  headerIndex: number,
): MatrixReading | null {
  const columns = dateColumns(rows[headerIndex] ?? []);
  if (columns.size < 2) return null;

  const rates: RawRate[] = [];
  const balances: ScheduleDeclaredBalance[] = [];
  const earlyRepayments: ScheduleEarlyRepayment[] = [];

  const end = Math.min(rows.length, headerIndex + 1 + MATRIX_BODY_ROWS);
  for (let index = headerIndex + 1; index < end; index += 1) {
    const row = rows[index] ?? [];
    const label = normalizeLabel(row[0] ?? "");
    if (label === "") continue;

    for (const [column, dateKey] of columns) {
      const cell = row[column] ?? "";
      if (RATE_LABELS.has(label)) {
        const parsed = parseCellNumber(cell);
        if (parsed && parsed.value > 0) {
          rates.push({ dateKey, percent: parsed.percent, value: parsed.value });
        }
        continue;
      }
      if (BALANCE_LABELS.has(label)) {
        const balanceMinor = parseMoneyMinor(cell);
        if (balanceMinor !== null && balanceMinor > 0) {
          balances.push({ balanceMinor, dateKey });
        }
        continue;
      }
      if (EARLY_REPAYMENT_LABELS.has(label)) {
        const amountMinor = parseMoneyMinor(cell);
        if (amountMinor !== null && amountMinor > 0) {
          earlyRepayments.push({ amountMinor, repaymentDate: dateKey });
        }
      }
    }
  }

  return rates.length > 0 ? { balances, earlyRepayments, rates } : null;
}

// ── The long table ──────────────────────────────────────────────────────────

const DATE_HEADERS = new Set(
  ["fecha", "fecha cuota", "fecha de pago", "date", "vencimiento"].map(normalizeLabel),
);

/**
 * A rate column must SAY it is a rate. In a cuadro's long table «Interés» is the
 * month's interest in euros, and reading it as a rate is the same class of error
 * as reading «Capital» as the outstanding balance (#1417).
 */
const RATE_HEADERS = new Set(
  [
    "tipo",
    "tipo aplicado",
    "tipo de interes",
    "tipo interes",
    "tipo nominal",
    "tin",
    "interes %",
    "interes (%)",
    "tipo (%)",
    "tipo %",
  ].map(normalizeLabel),
);

const BALANCE_HEADERS = new Set(
  [
    "saldo",
    "saldo pendiente",
    "capital pendiente",
    "pendiente",
    "capital vivo",
    "saldo vivo",
  ].map(normalizeLabel),
);

const EARLY_REPAYMENT_HEADERS = new Set(
  [
    "extra",
    "amortizacion anticipada",
    "amortiz anticipada",
    "amortizacion extra",
    "anticipada",
  ].map(normalizeLabel),
);

interface TableColumns {
  date: number;
  rate?: number;
  balance?: number;
  extra?: number;
}

function resolveTableColumns(row: readonly string[]): TableColumns | null {
  let date: number | undefined;
  let rate: number | undefined;
  let balance: number | undefined;
  let extra: number | undefined;

  row.forEach((cell, index) => {
    const label = normalizeLabel(cell);
    if (label === "") return;
    if (date === undefined && DATE_HEADERS.has(label)) date = index;
    else if (rate === undefined && RATE_HEADERS.has(label)) rate = index;
    else if (balance === undefined && BALANCE_HEADERS.has(label)) balance = index;
    else if (extra === undefined && EARLY_REPAYMENT_HEADERS.has(label)) extra = index;
  });

  if (date === undefined) return null;
  if (rate === undefined && balance === undefined && extra === undefined) return null;
  return {
    date,
    ...(balance === undefined ? {} : { balance }),
    ...(extra === undefined ? {} : { extra }),
    ...(rate === undefined ? {} : { rate }),
  };
}

interface TableReading {
  rates: RawRate[];
  balances: ScheduleDeclaredBalance[];
  earlyRepayments: ScheduleEarlyRepayment[];
  /** Rows under the header that carried no readable date. */
  observedRows: number;
}

/**
 * Read the long table whose header is at `headerIndex`. A rate is emitted only
 * where it CHANGES — a cuadro repeats the same rate on every one of its 360 rows,
 * and 360 identical revisions is not what the document says.
 */
function readTableAt(
  rows: readonly (readonly string[])[],
  headerIndex: number,
  columns: TableColumns,
): TableReading {
  const rates: RawRate[] = [];
  const balances: ScheduleDeclaredBalance[] = [];
  const earlyRepayments: ScheduleEarlyRepayment[] = [];
  let observedRows = 0;
  let previousRate: number | null = null;

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const dateKey = parseScheduleDate(row[columns.date] ?? "");
    if (!dateKey) continue;
    observedRows += 1;

    if (columns.rate !== undefined) {
      const parsed = parseCellNumber(row[columns.rate] ?? "");
      if (parsed && parsed.value > 0 && parsed.value !== previousRate) {
        rates.push({ dateKey, percent: parsed.percent, value: parsed.value });
        previousRate = parsed.value;
      }
    }
    if (columns.balance !== undefined) {
      const balanceMinor = parseMoneyMinor(row[columns.balance] ?? "");
      if (balanceMinor !== null && balanceMinor > 0)
        balances.push({ balanceMinor, dateKey });
    }
    if (columns.extra !== undefined) {
      const amountMinor = parseMoneyMinor(row[columns.extra] ?? "");
      if (amountMinor !== null && amountMinor > 0) {
        earlyRepayments.push({ amountMinor, repaymentDate: dateKey });
      }
    }
  }

  return { balances, earlyRepayments, observedRows, rates };
}

// ── Assembling one sheet ────────────────────────────────────────────────────

/** Later entries win; the result is sorted by date. */
function dedupeByDate<T>(entries: readonly T[], dateOf: (entry: T) => string): T[] {
  const byDate = new Map<string, T>();
  for (const entry of entries) byDate.set(dateOf(entry), entry);
  return [...byDate.values()].sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : 1));
}

/**
 * Turn raw rate cells into fractions. A cell that said «%» is a percentage; so is
 * a whole row where any value exceeds 1 (nobody pays a 270 % mortgage). Otherwise
 * every value is read as a fraction and the ambiguity is reported, for the import
 * plan to settle against the declared balances.
 */
function toRevisions(rates: readonly RawRate[]): {
  revisions: ScheduleRateRevision[];
  ambiguous: boolean;
} {
  const anyPercentSign = rates.some((rate) => rate.percent);
  const anyAboveOne = rates.some((rate) => rate.value > 1);
  const percent = anyPercentSign || anyAboveOne;
  const ambiguous = !percent && rates.length > 0;

  const revisions = rates
    .filter(
      (rate) =>
        (percent ? rate.value : rate.value * 100) <= MAX_PLAUSIBLE_ANNUAL_RATE_PERCENT,
    )
    .map((rate) => ({
      // Decimal division: `2.7 / 100` is 0.027000000000000003 in binary floating
      // point, and a rate is a DecimalString all the way into the curve.
      annualInterestRate: percent
        ? new Big(rate.value).div(100).toString()
        : new Big(rate.value).toString(),
      revisionDate: rate.dateKey,
    }));

  return { ambiguous, revisions };
}

type SheetReading = Omit<AmortizationScheduleReading, "sheetName">;

function readSheet(sheet: ScheduleSheet): SheetReading | null {
  const { rows } = sheet;

  let matrix: MatrixReading | null = null;
  let table: TableReading | null = null;

  for (let index = 0; index < rows.length; index += 1) {
    if (!matrix) matrix = readMatrixAt(rows, index);
    if (!table) {
      const columns = resolveTableColumns(rows[index] ?? []);
      if (columns) {
        const read = readTableAt(rows, index, columns);
        // A header with nothing dated under it is a coincidence of words, not a
        // table (the same «only a header if there is an observation below it»
        // rule the sheet dispatch learned in #1417).
        if (read.observedRows > 0) table = read;
      }
    }
    if (matrix && table) break;
  }

  if (!matrix && !table) return null;

  // The matrix's rate row is the authoritative statement of the revisions; the
  // long table only ever corroborates it. Its early repayments, on the other
  // hand, are the aggregate of a year filed under the anniversary column, while
  // the table's «Extra» carries the true date — so the table wins there.
  const rates = [...(table?.rates ?? []), ...(matrix?.rates ?? [])];
  const { ambiguous, revisions } = toRevisions(rates);
  const earlyRepayments =
    table && table.earlyRepayments.length > 0
      ? table.earlyRepayments
      : (matrix?.earlyRepayments ?? []);
  const declaredBalances = [...(matrix?.balances ?? []), ...(table?.balances ?? [])];

  if (revisions.length === 0 && earlyRepayments.length === 0) return null;

  return {
    declaredBalances: dedupeByDate(declaredBalances, (balance) => balance.dateKey),
    earlyRepayments: dedupeByDate(earlyRepayments, (entry) => entry.repaymentDate),
    rateScaleAmbiguous: ambiguous,
    revisions: dedupeByDate(revisions, (revision) => revision.revisionDate),
    warnings: [],
  };
}

function sheetChoiceWarning(read: string, ignored: readonly string[]): string {
  if (ignored.length === 0) return "";
  const named = ignored.map((name) => `«${name}»`).join(", ");
  return `Leí la hoja «${read}». También vi ${named}, que no contienen un cuadro de amortización.`;
}

/**
 * Read the first sheet that carries a cuadro de amortización. Sheets are swept in
 * order and the first one that yields model inputs wins — the real file keeps the
 * bank's table beside the owner's own analysis sheets, so «la primera hoja» is not
 * an answer (#1406).
 */
export function readAmortizationSchedule(
  sheets: readonly ScheduleSheet[],
): AmortizationScheduleReadResult {
  const ignored: string[] = [];

  for (const sheet of sheets) {
    const reading = readSheet(sheet);
    if (!reading) {
      if (sheet.name !== "") ignored.push(sheet.name);
      continue;
    }

    const warning = sheetChoiceWarning(sheet.name, ignored);
    return {
      ok: true,
      value: {
        ...reading,
        sheetName: sheet.name,
        warnings: warning === "" ? reading.warnings : [...reading.warnings, warning],
      },
    };
  }

  return { message: UNRECOGNIZED, ok: false };
}
