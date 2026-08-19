import type {
  BrokerTransactionRow,
  BrokerTransactionTable,
} from "./broker-transaction-table";
import { CAPTURE_CURRENCIES, isCaptureCurrency } from "./operation-currency";
import type { ParsedStatement, ParsedStatementRow } from "./statement-parse";

/**
 * The bridge between the shared transactions reader and the statement contract the
 * import gate already consumes (#1488) — «una tabla leída → un extracto», and nothing
 * else.
 *
 * It exists because the web gate spoke exactly one format. `STATEMENT_BROKER_ADAPTERS`
 * had a single entry, `plantilla`, so a DEGIRO `Transactions.xlsx` was refused there
 * too — and the assistant, not knowing that, had just sent its owner to that door as
 * the «correct» route. The reading itself is NOT here: it is
 * {@link readBrokerTransactionTable} in the domain, the same aliases and the same sign
 * rule the assistant's spreadsheet lane reads with (#1487), because two readers would
 * be two answers about the same money.
 *
 * The sibling of `statementFromTransactionsDocument` (the assistant's own bridge, from
 * the VALIDATED extraction contract) and deliberately not merged with it: that one
 * starts from a document a vision lane may have produced, this one from a grid this
 * process read. They share the two refusals below because both write through the same
 * planner, and the planner's rules are the reason for them.
 *
 * Pure and I/O-free: a table in, a statement or a Spanish refusal out. The euro
 * conversion happens at the gate, on the rows, where it already did (#1401).
 */

export type BrokerTransactionsStatementResult =
  | {
      ok: true;
      statement: ParsedStatement;
      /**
       * What the reading could not settle — an assumed direction, an assumed currency,
       * a row it skipped. The gate shows them before the confirm: a reading with a
       * doubt is honest only if the doubt is on screen (ADR 0048).
       */
      warnings: string[];
    }
  | { ok: false; message: string };

/** How a refused row reads back in the message: enough to find it in the file. */
function describeRow(row: BrokerTransactionRow): string {
  return `fila ${row.line} (${row.date}${row.name === null ? "" : ` ${row.name}`})`;
}

/**
 * Map a read transactions table onto a {@link ParsedStatement}, or refuse it.
 *
 * Two refusals, both all-or-nothing because the import is (ADR 0010):
 *
 * - **a trade with no ISIN**. The planner routes by ISIN and DROPS a row that has none,
 *   so letting the file through would import nine trades out of eleven in silence.
 *   Naming the rows is what makes this a route instead of a wall.
 * - **a currency the ledger cannot capture** (#1401). Coercing it to euros here would
 *   invent a rate the file never printed; the currencies it CAN capture convert at the
 *   gate, with the ECB rate of each row's own execution date.
 *
 * Two things a transactions export carries that this mapping deliberately drops, and
 * why:
 *
 * - the **execution time**. `occurredAt` is an instant in UTC and a broker prints local
 *   time without saying which zone, so stamping `T09:04:00.000Z` would assert a fact the
 *   file does not state. Same-day ordering is worth less than not inventing a timezone.
 * - the **order id**. It is the natural idempotency key for a re-upload, but an
 *   operation has nowhere to store one today, and a key kept only in the preview is not
 *   an idempotency key — it is a comment. It stays read (the reader keeps it) and
 *   unused until the ledger has a column for it.
 */
export function statementFromBrokerTransactions(
  table: BrokerTransactionTable,
): BrokerTransactionsStatementResult {
  if (table.rows.length === 0) {
    return {
      message: "El archivo no contiene operaciones que cargar.",
      ok: false,
    };
  }

  const withoutIsin = table.rows.filter((row) => row.isin === null);
  if (withoutIsin.length > 0) {
    return {
      message:
        `Estas operaciones del extracto no traen ISIN, y la importación reparte por ` +
        `identificador: ${withoutIsin.map(describeRow).join(", ")}. Si se cargara el ` +
        "archivo, esas filas se perderían sin avisar. Súbelo con la columna ISIN, o pásalo " +
        "a la plantilla de worthline.",
      ok: false,
    };
  }

  // One pass, so each row is built from the currency the guard NARROWED and not from a
  // cast asserting what a check three lines up already knew.
  const rows: ParsedStatementRow[] = [];
  const unsupported: string[] = [];
  for (const row of table.rows) {
    if (!isCaptureCurrency(row.currency)) {
      unsupported.push(row.currency);
      continue;
    }
    rows.push({
      currency: row.currency,
      dateKey: row.date,
      feesMinor: row.feesMinor,
      isin: row.isin,
      kind: row.kind,
      pricePerUnit: row.pricePerUnit,
      units: row.units,
      ...(row.name === null ? {} : { name: row.name }),
    });
  }
  if (unsupported.length > 0) {
    return {
      message:
        `El extracto trae operaciones en ${[...new Set(unsupported)].join(", ")} y solo se ` +
        `pueden registrar ${CAPTURE_CURRENCIES.join(", ")}. No se convierten aquí: sería ` +
        "inventar un tipo de cambio que el archivo no dice.",
      ok: false,
    };
  }

  const isins = [...new Set(rows.map((row) => row.isin as string))];

  return {
    ok: true,
    statement: {
      // A direction that came from nothing but «every row is a buy» leaves the whole
      // statement unresolved, which is what the gate's pre-confirm warning is for.
      // Erring the other way would hide the one thing only the user can settle.
      directionResolved: table.directionSource !== "assumed_buy",
      isin: isins.length === 1 ? isins[0]! : null,
      isins,
      rows,
      skipped: [],
    },
    warnings: table.warnings,
  };
}
