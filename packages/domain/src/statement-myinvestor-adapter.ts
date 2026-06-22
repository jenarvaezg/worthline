/**
 * The MyInvestor statement adapter (ADR 0018). Everything MyInvestor-specific that
 * `parseStatement` used to inline lives here: the `;`-delimited rows, the column
 * labels + header validation, the `dd/mm/yyyy` dates, the `,`-decimal units, the
 * `.`-decimal ` EUR`-suffixed amounts, and the sell-sign rule. The generic
 * pipeline (single-ISIN guard, all-or-nothing) stays in the core.
 *
 * Only `Finalizada` rows load; `En curso`/`Rechazada` are skipped (not errors).
 * A `Finalizada` row with a negative `Importe estimado` or negative units loads as
 * a `sell`, stored with ABSOLUTE units/price (the kind carries the direction);
 * everything else is a buy. The sell-sign convention is an UNVERIFIED assumption
 * (ADR 0018 Consequences) — we have no real MyInvestor reembolso sample.
 */

import { compareUnits, divideUnits, normalizeDecimal } from "./decimal";
import type { DecimalString } from "./decimal";
import type { OperationKind } from "./investment-types";
import type { CurrencyCode } from "./money";
import type {
  ColumnResolution,
  StatementBrokerAdapter,
  StatementRowResult,
} from "./statement-broker-adapter";

const MYINVESTOR_COLUMNS = {
  amount: "Importe estimado",
  date: "Fecha de la orden",
  estado: "Estado",
  isin: "ISIN",
  units: "Nº de participaciones",
} as const;

const FINALIZADA = "finalizada";

type MyInvestorColumns = Record<keyof typeof MYINVESTOR_COLUMNS, number>;

const EUR: CurrencyCode = "EUR";

export const myinvestorAdapter: StatementBrokerAdapter<MyInvestorColumns> = {
  splitRow(line: string): string[] {
    return line.split(";");
  },

  resolveColumns(header: string[]): ColumnResolution<MyInvestorColumns> {
    const normalized = header.map((cell) => cell.trim().toLowerCase());
    const columns = {} as MyInvestorColumns;
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
      return {
        errors: [
          `El archivo no tiene el formato de MyInvestor: falta(n) la(s) columna(s) ${missing.join(", ")}.`,
        ],
        ok: false,
      };
    }

    return { columns, ok: true };
  },

  parseRow({ cells, columns, lineNumber }): StatementRowResult {
    const estado = (cells[columns.estado] ?? "").trim();
    const isin = (cells[columns.isin] ?? "").trim() || null;
    const dateKey = parseDate((cells[columns.date] ?? "").trim());

    // Only executed orders load; everything else is skipped (not an error).
    if (estado.toLowerCase() !== FINALIZADA) {
      return { isin, outcome: { kind: "skipped", skipped: { dateKey, estado } } };
    }

    const units = parseUnits(cells[columns.units]);
    const amount = parseAmount(cells[columns.amount]);

    if (dateKey === null || units === null || amount === null) {
      return {
        isin,
        outcome: {
          kind: "error",
          error: `La fila ${lineNumber} (Finalizada) no se puede leer: revisa la fecha, el importe y las participaciones.`,
        },
      };
    }

    // Sell sign convention (ADR 0018, S5, UNVERIFIED): a negative amount or units
    // is a reembolso. We store absolute magnitudes — the kind carries direction.
    const kind: OperationKind = units.negative || amount.negative ? "sell" : "buy";

    return {
      isin,
      outcome: {
        kind: "row",
        row: {
          currency: EUR,
          dateKey,
          feesMinor: 0,
          kind,
          pricePerUnit: divideUnits(amount.value, units.value),
          units: units.value,
        },
      },
    };
  },
};

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
