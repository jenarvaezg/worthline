/**
 * Broker statement parser (ADR 0018, S1 — the walking-skeleton tracer).
 *
 * A **statement** is a broker's exported order file fed against one investment to
 * populate its **operations** — neither an Import (ADR 0010 full-workspace
 * replace) nor a connected source (ADR 0016 live mirror). This module is the pure
 * gate between the untrusted CSV text and the operations it becomes: it returns
 * parsed rows + skipped rows, or a list of Spanish errors (they surface in the
 * UI). It performs NO IO and reads no DB.
 *
 * The broker id selects a column-mapping strategy; MyInvestor is the only mapping
 * for now. A new broker later is a new mapping, not a new pipeline.
 *
 * Only `Finalizada` rows load; `En curso`/`Rechazada` are skipped (not errors).
 * A `Finalizada` row with a negative `Importe estimado` or negative units loads
 * as a `sell`, stored with ABSOLUTE units/price (the kind carries the direction);
 * everything else is a buy. The sell-sign convention is an UNVERIFIED assumption
 * (ADR 0018 Consequences) — we have no real MyInvestor reembolso sample.
 */

import { compareUnits, divideUnits, normalizeDecimal } from "./decimal";
import type { DecimalString } from "./decimal";
import type { OperationKind } from "./investment-types";
import type { CurrencyCode } from "./money";

export type StatementBroker = "myinvestor";

/** One executed order from the statement, ready to become an operation. */
export interface ParsedStatementRow {
  /** ISO `YYYY-MM-DD` execution date. */
  dateKey: string;
  /** A negative amount or units loads as a `sell` (abs values); otherwise a buy. */
  kind: OperationKind;
  units: DecimalString;
  /** Reconstructed NAV: amount ÷ units, at high precision. */
  pricePerUnit: DecimalString;
  /** Always 0 — a no-fee fund subscription reconciles exactly to the amount. */
  feesMinor: number;
  currency: CurrencyCode;
}

/** A row that did not load, with the `Estado` that caused it to be skipped. */
export interface SkippedStatementRow {
  dateKey: string | null;
  estado: string;
}

export interface ParsedStatement {
  /** The single ISIN the file's rows carry, when present. */
  isin: string | null;
  rows: ParsedStatementRow[];
  skipped: SkippedStatementRow[];
}

export type ParseStatementResult =
  | { ok: true; value: ParsedStatement }
  | { ok: false; errors: [string, ...string[]] };

const MYINVESTOR_COLUMNS = {
  amount: "Importe estimado",
  date: "Fecha de la orden",
  estado: "Estado",
  isin: "ISIN",
  units: "Nº de participaciones",
} as const;

const FINALIZADA = "finalizada";

export function parseStatement(
  rawText: string,
  broker: StatementBroker,
): ParseStatementResult {
  // The broker is exhaustive today (only MyInvestor); this guards the seam so a
  // future broker without a mapping fails loudly instead of silently mis-parsing.
  if (broker !== "myinvestor") {
    return fail([`No hay un lector configurado para el bróker "${String(broker)}".`]);
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return fail(["El archivo está vacío."]);
  }

  const header = splitRow(lines[0]!);
  const index = resolveColumns(header);

  if (!index.ok) {
    return { errors: index.errors, ok: false };
  }

  const errors: string[] = [];
  const rows: ParsedStatementRow[] = [];
  const skipped: SkippedStatementRow[] = [];
  const isins = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]!);
    const estado = (cells[index.columns.estado] ?? "").trim();
    const isin = (cells[index.columns.isin] ?? "").trim();
    if (isin) isins.add(isin);

    const dateRaw = (cells[index.columns.date] ?? "").trim();
    const dateKey = parseDate(dateRaw);

    // Only executed orders load; everything else is skipped (not an error).
    if (estado.toLowerCase() !== FINALIZADA) {
      skipped.push({ dateKey, estado });
      continue;
    }

    const units = parseUnits(cells[index.columns.units]);
    const amount = parseAmount(cells[index.columns.amount]);

    if (dateKey === null || units === null || amount === null) {
      errors.push(
        `La fila ${i + 1} (Finalizada) no se puede leer: revisa la fecha, el importe y las participaciones.`,
      );
      continue;
    }

    // Sell sign convention (ADR 0018, S5, UNVERIFIED): a negative amount or units
    // is a reembolso. We store absolute magnitudes — the kind carries direction.
    const kind: OperationKind = units.negative || amount.negative ? "sell" : "buy";

    rows.push({
      currency: "EUR",
      dateKey,
      feesMinor: 0,
      kind,
      pricePerUnit: divideUnits(amount.value, units.value),
      units: units.value,
    });
  }

  // A statement is per-ISIN (ADR 0018, S4): a file carrying more than one
  // distinct ISIN is a wrong-file slip, not something to graft onto one holding.
  if (isins.size > 1) {
    errors.push(
      `El archivo contiene varios ISIN (${[...isins].join(", ")}); un extracto debe ser de un solo fondo.`,
    );
  }

  // All-or-nothing (ADR 0010): a single malformed Finalizada row, or a mixed-ISIN
  // file, writes nothing.
  if (errors.length > 0) {
    return fail(errors);
  }

  return {
    ok: true,
    value: {
      isin: isins.size === 1 ? [...isins][0]! : null,
      rows,
      skipped,
    },
  };
}

type ColumnIndex = Record<keyof typeof MYINVESTOR_COLUMNS, number>;

function resolveColumns(
  header: string[],
): { ok: true; columns: ColumnIndex } | { ok: false; errors: [string, ...string[]] } {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  const columns = {} as ColumnIndex;
  const missing: string[] = [];

  for (const [key, label] of Object.entries(MYINVESTOR_COLUMNS) as [
    keyof typeof MYINVESTOR_COLUMNS,
    string,
  ][]) {
    const at = normalized.indexOf(label.toLowerCase());
    if (at === -1) {
      missing.push(label);
    } else {
      columns[key] = at;
    }
  }

  if (missing.length > 0) {
    return fail([
      `El archivo no tiene el formato de MyInvestor: falta(n) la(s) columna(s) ${missing.join(", ")}.`,
    ]);
  }

  return { columns, ok: true };
}

function splitRow(line: string): string[] {
  return line.split(";");
}

/** `dd/mm/yyyy` → `yyyy-mm-dd`, or null when the date is not a valid calendar date. */
function parseDate(raw: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!match) return null;

  const [, dd, mm, yyyy] = match;
  const day = Number(dd);
  const month = Number(mm);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const iso = `${yyyy}-${mm}-${dd}`;
  // Reject impossible days (e.g. 31/02): round-trip through Date and compare.
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== day) return null;

  return iso;
}

/** A parsed magnitude plus whether the source carried a negative sign. */
interface SignedDecimal {
  value: DecimalString;
  negative: boolean;
}

/** `Nº de participaciones` (`,`-decimal) → magnitude + sign, or null. */
function parseUnits(raw: string | undefined): SignedDecimal | null {
  const normalized = (raw ?? "").trim().replace(",", ".");
  return toSignedDecimal(normalized);
}

/** `Importe estimado` (`.`-decimal, ` EUR` suffix) → magnitude + sign, or null. */
function parseAmount(raw: string | undefined): SignedDecimal | null {
  const normalized = (raw ?? "")
    .trim()
    .replace(/\s*EUR\s*$/i, "")
    .trim();
  return toSignedDecimal(normalized);
}

/**
 * Split a decimal into its positive magnitude (normalized) and sign, or null when
 * unparseable or zero. The sign is preserved (not dropped) so the caller can read
 * a negative amount/units as a sell (ADR 0018, S5); the magnitude is always > 0.
 */
function toSignedDecimal(value: string): SignedDecimal | null {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  const negative = value.startsWith("-");
  const magnitude = negative ? value.slice(1) : value;
  // Collapse trailing-zero noise (`7.180` → `7.18`, `95.400` → `95.4`) via the seam.
  let normalized: DecimalString;
  try {
    normalized = normalizeDecimal(magnitude);
  } catch {
    return null;
  }
  return compareUnits(normalized, "0") > 0 ? { negative, value: normalized } : null;
}

function fail(errors: string[]): { ok: false; errors: [string, ...string[]] } {
  const [first, ...rest] = errors;
  return { errors: [first ?? "El archivo no es válido.", ...rest], ok: false };
}
