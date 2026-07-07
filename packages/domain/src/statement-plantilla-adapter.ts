/**
 * The Worthline plantilla adapter (#695) — our own universal statement format,
 * the meeting point for every broker whose exports are unusable (MyInvestor's
 * reduced orders file can't express sells; Inversis ships HTML disguised as
 * .xls). One file can mix asset types: funds, ETFs, stocks, indexes, pension
 * plans and crypto, each row declaring its own `Tipo de activo`.
 *
 * Shape (`;`-delimited, quote-aware for Excel es-ES output):
 *
 *   Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre
 *
 * - `Fecha`: `dd/mm/aaaa` or `aaaa-mm-dd`.
 * - `Tipo de activo`: Fondo | ETF | Acción | Índice | Plan de pensiones |
 *   Cripto (accent/case-insensitive; `Plan` and `Crypto` also accepted).
 * - `Identificador`: the grouping/matching key — ISIN for listed instruments,
 *   Finect code for pension plans, CoinGecko id for crypto.
 * - `Operación`: Compra | Venta — the ONLY source of direction. Amounts and
 *   units are always positive magnitudes; a negative sign is a row error, so
 *   direction can never carry two contradicting opinions.
 * - `Participaciones` / `Importe`: comma or dot decimals, no thousands
 *   separators. `Importe` is the order's total excluding fees; the unit price
 *   derives as `Importe ÷ Participaciones`, like every other adapter.
 * - `Comisión` (optional): persisted as the operation's fees; empty = 0.
 * - `Nombre` (optional): creation prefill only.
 *
 * No `Estado` column — the plantilla only carries executed operations, so
 * every row loads or errors (all-or-nothing, ADR 0010). Currency is EUR by
 * design. Direction is always resolved (`directionResolved: true`).
 */

import { compareUnits, divideUnits, multiplyToMinor, normalizeDecimal } from "./decimal";
import type { DecimalString } from "./decimal";
import type { Instrument } from "./instrument-catalog";
import type { OperationKind } from "./investment-types";
import type { CurrencyCode } from "./money";
import type {
  ColumnResolution,
  StatementBrokerAdapter,
  StatementRowResult,
} from "./statement-broker-adapter";

const PLANTILLA_COLUMNS = {
  amount: "Importe",
  date: "Fecha",
  identifier: "Identificador",
  operation: "Operación",
  tipo: "Tipo de activo",
  units: "Participaciones",
} as const;

const OPTIONAL_COLUMNS = {
  fees: "Comisión",
  name: "Nombre",
} as const;

type PlantillaColumns = Record<keyof typeof PLANTILLA_COLUMNS, number> &
  Record<keyof typeof OPTIONAL_COLUMNS, number | null>;

const EUR: CurrencyCode = "EUR";

/** `Tipo de activo` values → catalog instrument, on accent/case-normalized text. */
const INSTRUMENT_BY_TIPO: Record<string, Instrument> = {
  accion: "stock",
  cripto: "crypto",
  crypto: "crypto",
  etf: "etf",
  fondo: "fund",
  indice: "index",
  plan: "pension_plan",
  "plan de pensiones": "pension_plan",
};

export const plantillaAdapter: StatementBrokerAdapter<PlantillaColumns> = {
  // Excel es-ES saves `;`-separated CSV and quotes any cell containing `;` or
  // `"` — split with quote support so a fund name with a `;` survives.
  splitRow(line: string): string[] {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]!;
      if (inQuotes) {
        if (char === '"' && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ";") {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  },

  resolveColumns(header: string[]): ColumnResolution<PlantillaColumns> {
    const normalized = header.map((cell) => normalizeText(cell));
    const columns = {} as PlantillaColumns;
    const missing: string[] = [];

    for (const [key, label] of Object.entries(PLANTILLA_COLUMNS) as [
      keyof typeof PLANTILLA_COLUMNS,
      string,
    ][]) {
      const at = normalized.indexOf(normalizeText(label));
      if (at === -1) {
        missing.push(label);
      } else {
        columns[key] = at;
      }
    }

    if (missing.length > 0) {
      return {
        errors: [
          `El archivo no tiene el formato de la plantilla: falta(n) la(s) columna(s) ${missing.join(", ")}. Descarga la plantilla y respeta su cabecera.`,
        ],
        ok: false,
      };
    }

    for (const [key, label] of Object.entries(OPTIONAL_COLUMNS) as [
      keyof typeof OPTIONAL_COLUMNS,
      string,
    ][]) {
      const at = normalized.indexOf(normalizeText(label));
      columns[key] = at === -1 ? null : at;
    }

    return { columns, ok: true };
  },

  directionResolved(): boolean {
    return true;
  },

  parseRow({ cells, columns, lineNumber }): StatementRowResult {
    const identifier = (cells[columns.identifier] ?? "").trim();
    const isin = identifier || null;
    const rowError = (problem: string): StatementRowResult => ({
      isin,
      outcome: {
        kind: "error",
        error: `La fila ${lineNumber}${isin ? ` (${isin})` : ""} ${problem}. Corrige o quita esa fila y vuelve a subir — no se ha cargado nada.`,
      },
    });

    if (!isin) {
      return rowError("viene sin identificador (ISIN, código Finect o id de CoinGecko)");
    }

    const tipoRaw = (cells[columns.tipo] ?? "").trim();
    const instrument = INSTRUMENT_BY_TIPO[normalizeText(tipoRaw)];
    if (!instrument) {
      return rowError(
        tipoRaw === ""
          ? "viene sin tipo de activo"
          : `tiene un tipo de activo que no reconozco («${tipoRaw}») — vale Fondo, ETF, Acción, Índice, Plan de pensiones o Cripto`,
      );
    }

    const operationRaw = normalizeText((cells[columns.operation] ?? "").trim());
    const kind: OperationKind | null =
      operationRaw === "compra" ? "buy" : operationRaw === "venta" ? "sell" : null;
    if (kind === null) {
      return rowError(
        "tiene una operación que no reconozco — vale «Compra» o «Venta», y los importes van siempre en positivo",
      );
    }

    const dateKey = parseDate((cells[columns.date] ?? "").trim());
    if (dateKey === null) {
      return rowError("tiene una fecha inválida (usa dd/mm/aaaa o aaaa-mm-dd)");
    }

    const units = parsePositiveDecimal(cells[columns.units]);
    if (units === null) {
      return rowError(
        "tiene participaciones inválidas (número positivo, decimal con coma o punto, sin separador de miles)",
      );
    }

    const amount = parsePositiveDecimal(cells[columns.amount]);
    if (amount === null) {
      return rowError(
        "tiene un importe inválido (número positivo sin signo ni separador de miles — la dirección va en la columna Operación)",
      );
    }

    const feesRaw = columns.fees === null ? "" : (cells[columns.fees] ?? "").trim();
    let feesMinor = 0;
    if (feesRaw !== "") {
      const fees = parseNonNegativeDecimal(feesRaw);
      if (fees === null) {
        return rowError("tiene una comisión inválida (número, vacío = sin comisión)");
      }
      feesMinor = multiplyToMinor(fees, "1");
    }

    const name = columns.name === null ? "" : (cells[columns.name] ?? "").trim();

    return {
      isin,
      outcome: {
        kind: "row",
        row: {
          currency: EUR,
          dateKey,
          feesMinor,
          instrument,
          kind,
          pricePerUnit: divideUnits(amount, units),
          units,
          ...(name ? { name } : {}),
        },
      },
    };
  },
};

/** Lowercase + strip diacritics, the comparison basis for headers and enums. */
function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

/** `dd/mm/aaaa` or `aaaa-mm-dd` → `yyyy-mm-dd`, or null when not a real date. */
function parseDate(raw: string): string | null {
  const spanish = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!spanish && !iso) return null;

  const [yyyy, mm, dd] = spanish
    ? [spanish[3]!, spanish[2]!, spanish[1]!]
    : [iso![1]!, iso![2]!, iso![3]!];

  const candidate = `${yyyy}-${mm}-${dd}`;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== Number(dd)) return null;

  return candidate;
}

/** Positive decimal with comma OR dot separator (never both), > 0, or null. */
function parsePositiveDecimal(raw: string | undefined): DecimalString | null {
  const value = parseNonNegativeDecimal((raw ?? "").trim());
  return value !== null && compareUnits(value, "0") > 0 ? value : null;
}

/** Non-negative decimal with comma OR dot separator (never both), or null. */
function parseNonNegativeDecimal(raw: string): DecimalString | null {
  // Both separators present = a thousands separator we refuse to guess about.
  if (raw.includes(",") && raw.includes(".")) return null;
  const normalized = raw.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  try {
    return normalizeDecimal(normalized);
  } catch {
    return null;
  }
}
