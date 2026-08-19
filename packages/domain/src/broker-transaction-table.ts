/**
 * The broker-transactions table reader (#1487) — «una tabla de transacciones → una
 * lista de operaciones», and the ONE place that work happens.
 *
 * A broker's transactions export is the most standard file in the retail investing
 * world and worthline could read none of them: the only lane that understood movements
 * demanded a positions table beside them and a TEXTUAL operation column, and a pure
 * transactions export has neither — it is only the ledger, and in it **the sign IS the
 * operation** (`Número` +3 with `Valor` −562,44 is a buy; both inverted is a sell).
 *
 * It is GENERIC by design, and that is a decision rather than an accident (#1487's
 * second pass): the destination contract is fixed and known — a date, an instrument by
 * ISIN or name, units, a price or an amount, a currency, costs, and a direction from a
 * column or from the sign — so the reader is steered by that contract and never by a
 * broker. A new broker is **aliases plus a test with its fixture**, never a branch of
 * code. DEGIRO is simply the first fixture.
 *
 * Two callers share it, which is why it lives in the domain and not beside one of them:
 * the assistant's deterministic spreadsheet lane (#1487) and the web statement gate
 * (#1488). A second alias table would be a second answer to «what is this column», and
 * the one that drifts is the one that mis-reads somebody's money.
 *
 * What it never does: reach a model, or invent a figure. Every value is read off a cell
 * or derived from cells by the definition of the thing (`amount ÷ units`, `total − fees`)
 * and anything unreadable is skipped with a warning or marked `uncertain` — the two
 * honest outcomes, because both callers put the reading in front of the user before
 * anything is written (ADR 0048).
 */

import type { DecimalString } from "./decimal";
import {
  addUnits,
  compareUnits,
  divideUnits,
  multiplyToMinor,
  normalizeDecimal,
  scaleDecimal,
  subtractUnits,
} from "./decimal";

/** Where a row's buy/sell came from — the fact the caller must disclose. */
export type TransactionDirectionSource =
  | "operation"
  | "units_sign"
  | "amount_sign"
  /** Nothing in the file distinguishes a sell: every row is read as a buy, and said. */
  | "assumed_buy";

/** One executed trade read off a transactions table. Magnitudes are absolute. */
export interface BrokerTransactionRow {
  /** 1-based position under the header row — how a warning names this row. */
  line: number;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM` when the table prints an execution time, else null. */
  time: string | null;
  kind: "buy" | "sell";
  isin: string | null;
  name: string | null;
  units: DecimalString;
  /** The gross amount of the trade, fees EXCLUDED, in {@link currency}. */
  amount: DecimalString;
  /** `amount ÷ units`, at the seam's precision. */
  pricePerUnit: DecimalString;
  /** Costs the row printed, in {@link currency}'s minor units. */
  feesMinor: number;
  currency: string;
  /** The broker's own order reference, when the table carries one (#1488's key). */
  orderId: string | null;
  /** The row was read with a doubt the user must resolve in the preview. */
  uncertain: boolean;
}

export interface BrokerTransactionTable {
  rows: BrokerTransactionRow[];
  warnings: string[];
  directionSource: TransactionDirectionSource;
  /** True when no column, decoration or neighbour stated a currency. */
  assumedCurrency: boolean;
}

/** The currency assumed when the table states none anywhere — never in silence. */
const ASSUMED_CURRENCY = "EUR";

const ASSUMED_CURRENCY_WARNING =
  "La tabla no indica la divisa de los importes; se han leído en EUR. Revísalo antes de confirmar.";

const ASSUMED_BUY_WARNING =
  "La tabla no dice si cada fila es una compra o una venta (ni columna de operación ni signos), " +
  "así que se han leído todas como compras. Revísalo antes de confirmar.";

/**
 * How much of a cell is read before deciding what it is. A header label and a money
 * cell are both short by nature and every cell passes through here while the header is
 * hunted for, so an unbounded scan is CPU the upload controls (#1420's measurement).
 */
const MAX_CELL_CHARS = 120;

/** How many candidate header rows one grid may cost — see #1420: it is quadratic. */
const MAX_HEADER_CANDIDATES = 25;

/**
 * How far a printed unit price may disagree with `amount ÷ units` before the row says
 * so: one per cent. A rounded price column lands well inside it; the money column
 * being the WRONG one (a net total read as gross, a second leg's figure) lands outside,
 * and that is the silent mis-reading this whole reader must never make quietly.
 */
const PRICE_DISAGREEMENT_RATIO = 0.01;

type Family =
  | "date"
  | "time"
  | "operation"
  | "isin"
  | "name"
  | "units"
  | "price"
  | "gross"
  | "net"
  | "currency"
  | "orderId";

/**
 * What a transactions table calls each column, across brokers and languages. Matching
 * is EXACT on the normalized label (accents and case folded, a trailing currency
 * decoration split off), so a generous list costs nothing: only the fee family matches
 * by prefix, because that is the one whose real labels are sentences
 * («Costes de transacción y/o externos»).
 *
 * Two deliberate absences, both measured against real exports:
 * - bare «valor» is an AMOUNT here («Valor local», «Valor EUR»), never the security's
 *   name, so it is not a `name` alias;
 * - bare «orden» is not an `orderId` alias — a column of row counters called «Orden»
 *   would become the merge's idempotency key (#1488), which is worse than having none.
 */
const ALIASES: Record<Family, readonly string[]> = {
  date: [
    "fecha",
    "date",
    "fecha operacion",
    "fecha de operacion",
    "fecha valor",
    "fecha de valor",
    "fecha ejecucion",
    "fecha de ejecucion",
    "fecha liquidacion",
    "fecha contratacion",
    "trade date",
    "transaction date",
    "settlement date",
    "data",
  ],
  time: ["hora", "time", "hora de ejecucion", "trade time"],
  operation: [
    "operacion",
    "tipo de operacion",
    "tipo operacion",
    "tipo de transaccion",
    "movimiento",
    "tipo de movimiento",
    "compra venta",
    "compra/venta",
    "operation",
    "transaction type",
    "order type",
    "side",
    "buy/sell",
    "buy sell",
  ],
  isin: ["isin", "codigo isin", "isin code", "codigo"],
  name: [
    "producto",
    "nombre",
    "name",
    "descripcion",
    "description",
    "instrumento",
    "instrument",
    "activo",
    "fondo",
    "security",
    "security name",
    "denominacion",
  ],
  units: [
    "numero",
    "n",
    "num",
    "cantidad",
    "unidades",
    "units",
    "participaciones",
    "titulos",
    "numero de titulos",
    "n de titulos",
    "quantity",
    "qty",
    "shares",
    "nominal",
  ],
  price: [
    "precio",
    "price",
    "precio unitario",
    "precio por titulo",
    "precio de ejecucion",
    "cotizacion",
    "valor liquidativo",
    "vl",
    "nav",
    "unit price",
  ],
  gross: [
    "valor",
    "valor local",
    "valor efectivo",
    "importe",
    "importe bruto",
    "importe efectivo",
    "importe de la operacion",
    "bruto",
    "efectivo",
    "contravalor",
    "amount",
    "gross amount",
    "value",
  ],
  net: [
    "total",
    "importe total",
    "neto",
    "importe neto",
    "liquidacion",
    "importe liquidado",
    "net amount",
    "total amount",
  ],
  currency: ["divisa", "moneda", "currency", "ccy", "divisa de la operacion"],
  orderId: [
    "id orden",
    "id de orden",
    "numero de orden",
    "n de orden",
    "referencia de la orden",
    "referencia de orden",
    "order id",
    "orderid",
    "order reference",
  ],
};

/** What a cost column is called. Matched by PREFIX — these labels are sentences. */
const FEE_ALIASES = [
  "comision",
  "comisiones",
  "coste",
  "costes",
  "gasto",
  "gastos",
  "corretaje",
  "canon",
  "canones",
  "tarifa",
  "fee",
  "fees",
  "commission",
  "charges",
  "brokerage",
] as const;

/** How a broker says «buy» / «sell» in the column that says it outright. */
const OPERATION_WORDS: Record<"buy" | "sell", readonly string[]> = {
  buy: ["compra", "buy", "purchase", "adquisicion", "suscripcion", "b", "c"],
  sell: ["venta", "sell", "sale", "reembolso", "s", "v"],
};

/**
 * The currency a printed decoration stands for — a CLOSED, tiny vocabulary, for the
 * reason #1420 documents: any three-letter word would otherwise qualify, and a column
 * called «Valor mes» would declare its money to be in MES. An EXPLICIT currency column
 * or a header-less neighbour is still read verbatim as the code it claims to be.
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

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/** Fold a header cell to its comparison basis: no accents, no case, single spaces. */
function normalizeLabel(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .slice(0, MAX_CELL_CHARS)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function currencyFromDecoration(token: string): string | undefined {
  const compact = token
    .replace(/[()[\]\s]/g, "")
    .trim()
    .toLowerCase();
  return compact === "" ? undefined : CURRENCY_DECORATIONS[compact];
}

/**
 * Split «Valor EUR» or «Comisión (€)» into the label to match and the currency the
 * header declares. One backwards scan and not a regex, for the reason #1420 measured:
 * three variable-length parts over the same whitespace cost seconds of backtracking on
 * a pathological cell, in a function that runs over every cell of every candidate row.
 */
function splitHeaderCurrency(value: string): {
  label: string;
  currency: string | undefined;
} {
  const trimmed = value.trim().slice(0, MAX_CELL_CHARS);
  const plain = { currency: undefined, label: normalizeLabel(value) };

  let end = trimmed.length;
  if (trimmed.endsWith(")") || trimmed.endsWith("]")) end -= 1;
  let start = end;
  while (start > 0 && !isDecorationBoundary(trimmed[start - 1]!)) start -= 1;
  if (start === 0 || start === end) return plain;

  const currency = currencyFromDecoration(trimmed.slice(start, end));
  return currency === undefined
    ? plain
    : {
        currency,
        label: normalizeLabel(trimmed.slice(0, start).replace(/[([\s]+$/, "")),
      };
}

function isDecorationBoundary(char: string): boolean {
  return char === "(" || char === "[" || /\s/.test(char);
}

/**
 * A signed decimal as a broker prints it, kept as a STRING through the seam's
 * arithmetic. Floats are not an option here: six-decimal participaciones and
 * eight-decimal crypto units are exactly what `DecimalString` exists for.
 *
 * The ambiguity of `1.234` is resolved the way the Spanish exports that motivated this
 * resolve it — as a thousands separator — matching the assistant contract's own
 * `normalizeExtractedNumber`, so a figure means the same thing in both lanes.
 */
function parseSignedDecimal(raw: string): DecimalString | null {
  const compact = raw
    .slice(0, MAX_CELL_CHARS)
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "");
  if (compact === "") return null;

  let normalized: string;
  if (/^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact)) {
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (/^[+-]?\d+(?:,\d+)?$/.test(compact)) {
    normalized = compact.replace(",", ".");
  } else if (/^[+-]?\d+(?:\.\d+)?$/.test(compact)) {
    normalized = compact;
  } else if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) {
    normalized = compact.replace(/,/g, "");
  } else {
    return null;
  }

  try {
    return normalizeDecimal(normalized);
  } catch {
    return null;
  }
}

/**
 * A date cell as a transactions export prints it → ISO `YYYY-MM-DD`, or null.
 *
 * `DD-MM-YYYY` is the one #1487 was filed for and the reason this parser exists at all
 * instead of reusing the assistant's `toIsoDate`: widening THAT one would change what
 * every other deterministic reader accepts, which is a different decision from this
 * ticket's. Day-first is assumed for the ambiguous separators, because that is what
 * every European export prints; an ISO date is unambiguous and read as itself.
 */
function parseTransactionDate(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_CELL_CHARS);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) return isoDay(+iso[1]!, +iso[2]!, +iso[3]!);
  const dayFirst = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(trimmed);
  if (dayFirst) return isoDay(+dayFirst[3]!, +dayFirst[2]!, +dayFirst[1]!);
  return null;
}

function isoDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `9:04` / `09:04:32` → `09:04`, or null when the cell is not a time. */
function parseTime(raw: string): string | null {
  const parts = TIME_PATTERN.exec(raw.trim().slice(0, MAX_CELL_CHARS));
  if (!parts) return null;
  const hours = Number(parts[1]);
  const minutes = Number(parts[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${parts[2]}`;
}

/** One money column: where it is, and the currency its header declared, if any. */
interface MoneyColumn {
  index: number;
  currency: string | undefined;
  /** The header-less neighbour that carries this figure's currency code, if any. */
  currencyBeside: number | undefined;
}

interface TransactionColumns {
  date: number;
  time: number | undefined;
  operation: number | undefined;
  isin: number | undefined;
  name: number | undefined;
  units: number;
  price: MoneyColumn | undefined;
  /** Gross amount columns in table order — the first non-empty one wins per row. */
  gross: MoneyColumn[];
  net: MoneyColumn | undefined;
  currency: number | undefined;
  orderId: number | undefined;
  fees: MoneyColumn[];
}

/**
 * The columns a row declares, if it is a transactions header at all. The contract is
 * the requirement: a date, something to identify the instrument (ISIN or name), units,
 * and a figure to price the trade with (an amount or a unit price). Anything less could
 * not become an operation, so it is not this document.
 */
function resolveColumns(row: readonly string[]): TransactionColumns | null {
  const claimed = new Set<number>();
  const found = new Map<Family, number>();
  const headerCurrency = new Map<number, string | undefined>();
  const gross: number[] = [];
  const fees: number[] = [];
  const blank: number[] = [];

  for (const [index, raw] of row.entries()) {
    const header = splitHeaderCurrency(raw);
    headerCurrency.set(index, header.currency);
    if (header.label === "") {
      blank.push(index);
      continue;
    }
    // Every gross-amount column is kept (an export prints the local figure AND its
    // euro conversion); every family else takes its LEFTMOST match, because no ranking
    // among aliases is more truthful than the table's own order.
    if (ALIASES.gross.includes(header.label)) {
      gross.push(index);
      claimed.add(index);
      continue;
    }
    const family = (Object.keys(ALIASES) as Family[]).find(
      (candidate) => candidate !== "gross" && ALIASES[candidate].includes(header.label),
    );
    if (family !== undefined && !found.has(family)) {
      found.set(family, index);
      claimed.add(index);
    }
  }

  // The fee family matches by prefix and takes EVERY column that matches: a real export
  // prints its costs in several («Comisión AutoFX» beside «Costes de transacción y/o
  // externos»), and dropping the second one loses money the user paid.
  for (const [index, raw] of row.entries()) {
    if (claimed.has(index)) continue;
    const label = splitHeaderCurrency(raw).label;
    if (label !== "" && FEE_ALIASES.some((alias) => label.startsWith(alias))) {
      fees.push(index);
      claimed.add(index);
    }
  }

  const date = found.get("date");
  const units = found.get("units");
  const priceIndex = found.get("price");
  const netIndex = found.get("net");
  if (date === undefined || units === undefined) return null;
  if (found.get("isin") === undefined && found.get("name") === undefined) return null;
  if (gross.length === 0 && priceIndex === undefined && netIndex === undefined) {
    return null;
  }

  const money = (index: number): MoneyColumn => ({
    currency: headerCurrency.get(index),
    // A header-less column immediately to the right of a figure is where an export
    // prints that figure's currency code — the shape #1487 was filed against.
    currencyBeside: blank.includes(index + 1) ? index + 1 : undefined,
    index,
  });

  return {
    currency: found.get("currency"),
    date,
    fees: fees.map(money),
    gross: gross.map(money),
    isin: found.get("isin"),
    name: found.get("name"),
    net: netIndex === undefined ? undefined : money(netIndex),
    operation: found.get("operation"),
    orderId: found.get("orderId"),
    price: priceIndex === undefined ? undefined : money(priceIndex),
    time: found.get("time"),
    units,
  };
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? "" : (row[index] ?? "").trim();
}

/** The buy/sell a textual cell states outright, or null when it states neither. */
function operationWord(value: string): "buy" | "sell" | null {
  const normalized = normalizeLabel(value);
  if (normalized === "") return null;
  for (const kind of ["buy", "sell"] as const) {
    if (OPERATION_WORDS[kind].some((word) => normalized === word)) return kind;
  }
  for (const kind of ["buy", "sell"] as const) {
    if (
      OPERATION_WORDS[kind].some((word) => word.length > 1 && normalized.includes(word))
    )
      return kind;
  }
  return null;
}

/**
 * The three-letter code a cell states, whether it wrote the symbol («€») or the code
 * itself. The ONE place a currency cell is read, so an explicit `Divisa` column, a
 * header-less neighbour and a header decoration cannot end up with three answers.
 */
function currencyCode(value: string): string | undefined {
  const stated =
    currencyFromDecoration(value) ?? (value.trim() || undefined)?.toUpperCase();
  return stated !== undefined && CURRENCY_CODE_PATTERN.test(stated) ? stated : undefined;
}

/** The currency a money column states for THIS row: neighbour, then header decoration. */
function moneyCurrency(
  row: readonly string[],
  column: MoneyColumn,
  declared: string | undefined,
): string | undefined {
  const printed =
    currencyCode(cell(row, column.currencyBeside)) ?? column.currency ?? declared;
  return printed !== undefined && CURRENCY_CODE_PATTERN.test(printed)
    ? printed
    : undefined;
}

/** The first money column of `columns` this row actually filled in, with its figure. */
function firstFigure(
  row: readonly string[],
  columns: readonly MoneyColumn[],
  declared: string | undefined,
): { value: DecimalString; currency: string | undefined; column: MoneyColumn } | null {
  for (const column of columns) {
    const value = parseSignedDecimal(cell(row, column.index));
    if (value === null) continue;
    return { column, currency: moneyCurrency(row, column, declared), value };
  }
  return null;
}

function absolute(value: DecimalString): DecimalString {
  return value.startsWith("-") ? value.slice(1) : value;
}

function isNegative(value: DecimalString): boolean {
  return compareUnits(value, "0") < 0;
}

/**
 * Which signal says whether each row is a buy or a sell, decided for the TABLE and not
 * per row — a convention belongs to a file, and reading it per row would let two rows
 * of one export disagree about what a minus sign means.
 *
 * In order: a textual operation column; then a units column that carries signs
 * (positive is a buy, the ordinary broker convention); then a money column that carries
 * them (negative is money out, so a buy). When nothing does, every row is one direction
 * and the file does not say which — {@link ASSUMED_BUY_WARNING} says so out loud.
 */
function resolveDirectionSource(
  rows: readonly (readonly string[])[],
  columns: TransactionColumns,
): TransactionDirectionSource {
  if (columns.operation !== undefined) {
    const stated = rows.some(
      (row) => operationWord(cell(row, columns.operation)) !== null,
    );
    if (stated) return "operation";
  }
  const signed = (index: number | undefined): boolean =>
    index !== undefined &&
    rows.some((row) => {
      const value = parseSignedDecimal(cell(row, index));
      return value !== null && isNegative(value);
    });
  if (signed(columns.units)) return "units_sign";
  const moneyIndexes = [...columns.gross, ...(columns.net ? [columns.net] : [])];
  if (moneyIndexes.some((column) => signed(column.index))) return "amount_sign";
  return "assumed_buy";
}

interface RowReading {
  row: BrokerTransactionRow | null;
  warning: string | null;
}

/**
 * Read ONE data row. A row we cannot confidently read is skipped with a warning and
 * never invented: a transactions export carries dividends, currency conversions and
 * deposits beside its trades, and none of those is an operation on an instrument.
 */
function readRow(
  raw: readonly string[],
  line: number,
  columns: TransactionColumns,
  directionSource: TransactionDirectionSource,
): RowReading {
  const skip = (reason: string): RowReading => ({
    row: null,
    warning: `Fila ${line} de la tabla: ${reason}; se ha omitido.`,
  });

  const date = parseTransactionDate(cell(raw, columns.date));
  if (date === null) return skip("la fecha no es una fecha válida");

  const signedUnits = parseSignedDecimal(cell(raw, columns.units));
  if (signedUnits === null) return skip("no dice cuántos títulos se movieron");
  const units = absolute(signedUnits);
  if (compareUnits(units, "0") === 0) {
    return skip("mueve 0 títulos, así que no es una compra ni una venta");
  }

  const declared = currencyCode(cell(raw, columns.currency));

  const price = columns.price ? firstFigure(raw, [columns.price], declared) : null;
  const gross = firstFigure(raw, columns.gross, declared);
  const net = columns.net ? firstFigure(raw, [columns.net], declared) : null;
  const money = gross ?? net ?? price;
  if (money === null) return skip("no trae ni importe ni precio que leer");

  const currency = money.currency ?? declared ?? ASSUMED_CURRENCY;
  const fees = readFees(raw, columns, currency);

  // The row's own CASH figure — the one whose sign means «money out» — which is not the
  // unit price: a price is printed positive on a sale too, so it can never stand in for
  // the direction (see {@link resolveKind}).
  const cash = gross ?? net;
  const kind = resolveKind(
    raw,
    columns,
    directionSource,
    signedUnits,
    cash?.value ?? null,
  );
  if (kind === null) {
    const stated = cell(raw, columns.operation);
    return skip(
      directionSource === "operation"
        ? stated === ""
          ? "no dice qué operación es"
          : `no reconozco la operación «${stated}»`
        : "no dice si es una compra o una venta",
    );
  }

  // The gross amount, in order of what the table actually printed: an explicit gross
  // column; else a net total with its costs taken back out (that IS the definition of
  // net, not a guess); else units × the printed unit price.
  let amount: DecimalString;
  if (gross) {
    amount = absolute(gross.value);
  } else if (net) {
    const netAbsolute = absolute(net.value);
    const feesDecimal = divideUnits(String(fees.feesMinor), "100", 2);
    amount =
      kind === "buy"
        ? subtractUnits(netAbsolute, feesDecimal)
        : addUnits(netAbsolute, feesDecimal);
  } else {
    amount = multiply(units, absolute(money.value));
  }
  if (compareUnits(amount, "0") <= 0) {
    return skip("el importe de la operación no es positivo");
  }

  const warnings = [...fees.warnings];
  let uncertain = directionSource === "assumed_buy";

  // Two signs that AGREE are two conventions contradicting each other: under the units
  // convention +3 is a buy, under the cash convention a positive amount is a sell. The
  // row still travels — with the doubt on it, for the user to settle in the preview.
  if (
    (directionSource === "units_sign" || directionSource === "amount_sign") &&
    cash !== null &&
    isNegative(signedUnits) === isNegative(cash.value) &&
    compareUnits(cash.value, "0") !== 0
  ) {
    uncertain = true;
    warnings.push(
      `Fila ${line} de la tabla: el signo de los títulos y el del importe no se contradicen, ` +
        "así que no está claro si es una compra o una venta. Revísalo.",
    );
  }

  const pricePerUnit = divideUnits(amount, units);
  if (price !== null && disagrees(multiply(units, absolute(price.value)), amount)) {
    uncertain = true;
    warnings.push(
      `Fila ${line} de la tabla: el precio impreso por título no cuadra con el importe leído. Revísalo.`,
    );
  }

  const isinCell = cell(raw, columns.isin).toUpperCase();
  const nameCell = cell(raw, columns.name);
  const isin = ISIN_PATTERN.test(isinCell) ? isinCell : null;
  const name = nameCell || null;
  if (isin === null && name === null) {
    return skip("no dice a qué producto pertenece");
  }

  const orderId = cell(raw, columns.orderId) || null;
  return {
    row: {
      amount,
      currency,
      date,
      feesMinor: fees.feesMinor,
      isin,
      kind,
      line,
      name,
      orderId,
      pricePerUnit,
      time: parseTime(cell(raw, columns.time)),
      uncertain,
      units,
    },
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

/**
 * The direction of ONE row, from the signal the table as a whole declared — or `null`
 * when this row does not carry that signal, which is a row the reader must not guess at.
 *
 * Both nulls are real rows of a real export, and both used to fall through to «buy»:
 *
 * - a table whose operation column says something else on this row («Dividendo»,
 *   «Traspaso», or nothing at all) — that row is not a trade, and the sibling movements
 *   reader has always skipped it («no reconozco la operación»);
 * - a sign-carrying money column left EMPTY on this row while the price is filled. The
 *   unit price of a sell is printed positive like any other, so reading its sign would
 *   have made every such row a sale.
 */
function resolveKind(
  raw: readonly string[],
  columns: TransactionColumns,
  directionSource: TransactionDirectionSource,
  signedUnits: DecimalString,
  cash: DecimalString | null,
): "buy" | "sell" | null {
  if (directionSource === "operation") {
    return operationWord(cell(raw, columns.operation));
  }
  if (directionSource === "units_sign") return isNegative(signedUnits) ? "sell" : "buy";
  if (directionSource === "amount_sign") {
    return cash === null ? null : isNegative(cash) ? "buy" : "sell";
  }
  return "buy";
}

/**
 * Every cost column of the row, summed into minor units. A cost stated in another
 * currency than the trade is DROPPED with a warning rather than converted: converting
 * it here would apply a rate nobody stated, and the trade's own figures are exact.
 *
 * «Minor units» here means hundredths, whatever the currency — `multiplyToMinor` is the
 * app's single money scale (`parseDecimalToMinor` in `money.ts` is the same ×100), so a
 * zero-decimal currency would be off by that factor. It is the app's convention and not
 * a choice made here, and it is out of reach of the write path anyway:
 * {@link CAPTURE_CURRENCIES} has no such currency, so a statement import refuses the row
 * before its fee can be stored.
 */
function readFees(
  raw: readonly string[],
  columns: TransactionColumns,
  currency: string,
): { feesMinor: number; warnings: string[] } {
  let feesMinor = 0;
  const warnings: string[] = [];
  for (const column of columns.fees) {
    const value = parseSignedDecimal(cell(raw, column.index));
    if (value === null) continue;
    const stated = moneyCurrency(raw, column, currency) ?? currency;
    if (stated !== currency) {
      warnings.push(
        `La comisión de esta fila está en ${stated} y la operación en ${currency}: no se ha sumado.`,
      );
      continue;
    }
    feesMinor += multiplyToMinor(absolute(value), "1");
  }
  return { feesMinor, warnings };
}

function disagrees(left: DecimalString, right: DecimalString): boolean {
  if (compareUnits(right, "0") === 0) return false;
  const gap = absolute(subtractUnits(left, right));
  const tolerance = scaleDecimal(absolute(right), PRICE_DISAGREEMENT_RATIO, 20);
  return compareUnits(gap, tolerance) > 0;
}

/** units × price through the decimal seam — never `Number(a) * Number(b)`. */
function multiply(left: DecimalString, right: DecimalString): DecimalString {
  return scaleDecimal(left, right, 20);
}

/**
 * Read a grid of cells as a broker transactions table, or null when it is not one.
 *
 * The header is SEARCHED for and not assumed (#1420's lesson): a real export prints a
 * title, an account line and a blank row above its table. A candidate row is the header
 * when it resolves the contract's columns AND at least one row under it reads as a
 * trade — the condition that keeps a summary block naming a «Fecha» and an «Importe»
 * from being declared a ledger.
 */
export function readBrokerTransactionTable(
  grid: readonly (readonly string[])[],
): BrokerTransactionTable | null {
  let candidates = 0;
  for (const [index, row] of grid.entries()) {
    const columns = resolveColumns(row);
    if (!columns) continue;
    if (candidates >= MAX_HEADER_CANDIDATES) return null;
    candidates += 1;

    const body = grid.slice(index + 1);
    const directionSource = resolveDirectionSource(body, columns);
    const rows: BrokerTransactionRow[] = [];
    const warnings: string[] = [];
    for (const [offset, raw] of body.entries()) {
      if (raw.every((value) => value.trim() === "")) continue;
      const reading = readRow(raw, offset + 1, columns, directionSource);
      if (reading.warning) warnings.push(reading.warning);
      if (reading.row) rows.push(reading.row);
    }
    if (rows.length === 0) continue;

    const assumedCurrency = !rows.every((trade) => statedCurrency(trade, columns, body));
    return {
      assumedCurrency,
      directionSource,
      rows,
      warnings: [
        ...(directionSource === "assumed_buy" ? [ASSUMED_BUY_WARNING] : []),
        ...(assumedCurrency ? [ASSUMED_CURRENCY_WARNING] : []),
        ...warnings,
      ],
    };
  }
  return null;
}

/**
 * Did the table STATE this row's currency, or was {@link ASSUMED_CURRENCY} used? Asked
 * after the fact rather than threaded through the row, because the row's `currency` is
 * a resolved code either way and the difference is what the card must disclose.
 */
function statedCurrency(
  trade: BrokerTransactionRow,
  columns: TransactionColumns,
  body: readonly (readonly string[])[],
): boolean {
  const raw = body[trade.line - 1];
  if (!raw) return true;
  const declared = cell(raw, columns.currency);
  if (declared !== "") return true;
  const stated = [
    ...columns.gross,
    ...(columns.net ? [columns.net] : []),
    ...(columns.price ? [columns.price] : []),
  ];
  return stated.some(
    (column) => column.currency !== undefined || cell(raw, column.currencyBeside) !== "",
  );
}
