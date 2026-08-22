/**
 * How a validated extraction is rendered into the model's prompt (#1492).
 *
 * The typed lane used to `JSON.stringify` the whole document. A 450-point series
 * is ~25k characters and a fat broker extract can blow past even the primary's
 * share. The notebook already fitted to `attachmentChars` (#1419); this is the
 * same ceiling, with a different cut: a validated series is never sampled (the
 * figures the model cites have to be the card's), so the only honest answers
 * are "the whole columnar detail" or "the card plus get_extracted_document".
 *
 * Write tools are unchanged: they still read rows off `validatedDocuments`,
 * never off this payload or off the model's arguments (#1373).
 */

import type { ExtractedDocument } from "@web/asistente/attachment-extraction-contract";

export const DETAIL_OMITTED_NOTICE =
  "RESUMEN: el detalle no cabe en este modelo; está en get_extracted_document.";

export interface ColumnarDetail {
  columns: string[];
  rows: unknown[][];
}

/** Compact detail as the get tool and the prompt both speak it. */
export type CompactDetail =
  | ColumnarDetail
  | { holdings: ColumnarDetail; movements: ColumnarDetail };

const PACKABLE_DOCUMENT_TYPES = new Set(["balance_series", "positions"]);

const POLICY_CARD_ONLY_TYPES = new Set(["broker_transactions", "positions_movements"]);

interface Column<T> {
  name: string;
  optional?: boolean;
  value: (row: T) => unknown;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function compactTable<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
): ColumnarDetail {
  const included = columns.filter(
    (column) => !column.optional || rows.some((row) => isPresent(column.value(row))),
  );
  return {
    columns: included.map((column) => column.name),
    rows: rows.map((row) =>
      included.map((column) => {
        const value = column.value(row);
        return value === undefined ? null : value;
      }),
    ),
  };
}

function currenciesOf(values: readonly string[]): string | string[] {
  const unique = [...new Set(values)];
  return unique.length === 1 ? (unique[0] ?? "") : unique;
}

function dateRange(
  dates: readonly string[],
): { startDate: string; endDate: string } | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  return { endDate: sorted[sorted.length - 1]!, startDate: sorted[0]! };
}

/**
 * The card that always travels: file name, type, and the handful of figures that
 * let the model talk about the document without reciting it.
 *
 * `detailOmitted` is the honest notice when rows do not follow — budget for a
 * series/positions, policy for an extract. A holding_event carries the event
 * itself, so it never takes the notice.
 */
export function typedDocumentCard(
  fileName: string,
  document: ExtractedDocument,
  detailOmitted: boolean,
): Record<string, unknown> {
  const base = { documentType: document.documentType, fileName };
  const notice = detailOmitted ? { detailOmitted: DETAIL_OMITTED_NOTICE } : {};

  switch (document.documentType) {
    case "balance_series": {
      const balances = [...document.balances].sort((left, right) =>
        left.date.localeCompare(right.date),
      );
      const amounts = balances.map((balance) => balance.amount);
      const first = balances[0]!;
      const last = balances[balances.length - 1]!;
      return {
        ...base,
        n: balances.length,
        startDate: first.date,
        endDate: last.date,
        startAmount: first.amount,
        endAmount: last.amount,
        minAmount: Math.min(...amounts),
        maxAmount: Math.max(...amounts),
        currency: currenciesOf(balances.map((balance) => balance.currency)),
        ...notice,
      };
    }
    case "positions":
      return {
        ...base,
        n: document.positions.length,
        ...(document.totalEur === undefined ? {} : { totalEur: document.totalEur }),
        ...notice,
      };
    case "broker_transactions": {
      const transactions = document.transactions;
      const dates = dateRange(transactions.map((transaction) => transaction.date));
      const byKind: Record<string, number> = {};
      for (const transaction of transactions) {
        byKind[transaction.kind] = (byKind[transaction.kind] ?? 0) + 1;
      }
      const feesTotal = transactions.reduce(
        (sum, transaction) => sum + (transaction.feesMinor ?? 0),
        0,
      );
      return {
        ...base,
        n: transactions.length,
        ...(dates ?? {}),
        byKind,
        ...(feesTotal > 0 ? { feesTotal } : {}),
        ...notice,
      };
    }
    case "positions_movements": {
      const movementDates = dateRange(
        document.movements.map((movement) => movement.date),
      );
      return {
        ...base,
        nHoldings: document.holdings.length,
        nMovements: document.movements.length,
        ...(movementDates ?? {}),
        ...notice,
      };
    }
    default:
      return { ...base, event: document.event };
  }
}

export function isPackableDocument(document: ExtractedDocument): boolean {
  return PACKABLE_DOCUMENT_TYPES.has(document.documentType);
}

export function omitsDetailByPolicy(document: ExtractedDocument): boolean {
  return POLICY_CARD_ONLY_TYPES.has(document.documentType);
}

/** Columnar detail for a series or a positions table — what the prompt may pack. */
export function promptDetail(document: ExtractedDocument): ColumnarDetail | null {
  switch (document.documentType) {
    case "balance_series":
      return compactTable(document.balances, [
        { name: "date", value: (row) => row.date },
        { name: "amount", value: (row) => row.amount },
        { name: "currency", value: (row) => row.currency },
        { name: "projected", optional: true, value: (row) => row.projected },
      ]);
    case "positions":
      return compactTable(document.positions, [
        { name: "name", value: (row) => row.name },
        { name: "ticker", optional: true, value: (row) => row.ticker },
        { name: "units", optional: true, value: (row) => row.units },
        { name: "marketValueEur", value: (row) => row.marketValueEur },
        { name: "currency", value: (row) => row.currency },
      ]);
    default:
      return null;
  }
}

/** The whole document as compact columns — what `get_extracted_document` returns. */
export function extractedDocumentDetail(
  document: ExtractedDocument,
): CompactDetail | null {
  const packed = promptDetail(document);
  if (packed) return packed;

  switch (document.documentType) {
    case "broker_transactions":
      return compactTable(document.transactions, [
        { name: "date", value: (row) => row.date },
        { name: "kind", value: (row) => row.kind },
        { name: "isin", optional: true, value: (row) => row.isin },
        { name: "name", optional: true, value: (row) => row.name },
        { name: "units", value: (row) => row.units },
        { name: "amount", value: (row) => row.amount },
        { name: "pricePerUnit", value: (row) => row.pricePerUnit },
        { name: "currency", value: (row) => row.currency },
        { name: "feesMinor", optional: true, value: (row) => row.feesMinor },
        { name: "orderId", optional: true, value: (row) => row.orderId },
      ]);
    case "positions_movements":
      return {
        holdings: compactTable(document.holdings, [
          { name: "name", value: (row) => row.name },
          { name: "type", value: (row) => row.type },
          { name: "isin", optional: true, value: (row) => row.isin },
          { name: "value", value: (row) => row.value },
          { name: "currency", value: (row) => row.currency },
          { name: "declaredCost", optional: true, value: (row) => row.declaredCost },
          { name: "fidelity", value: (row) => row.fidelity },
        ]),
        movements: compactTable(document.movements, [
          { name: "date", value: (row) => row.date },
          { name: "kind", value: (row) => row.kind },
          { name: "isin", optional: true, value: (row) => row.isin },
          { name: "name", optional: true, value: (row) => row.name },
          { name: "units", optional: true, value: (row) => row.units },
          { name: "amount", value: (row) => row.amount },
          { name: "currency", value: (row) => row.currency },
        ]),
      };
    case "holding_event":
      return compactTable(
        [document.event],
        [
          { name: "date", value: (row) => row.date },
          { name: "amount", value: (row) => row.amount },
          { name: "currency", value: (row) => row.currency },
          { name: "label", value: (row) => row.label },
          { name: "kind", value: (row) => row.kind },
          { name: "isin", optional: true, value: (row) => row.isin },
          { name: "units", optional: true, value: (row) => row.units },
          { name: "pricePerUnit", optional: true, value: (row) => row.pricePerUnit },
          { name: "fees", optional: true, value: (row) => row.fees },
          { name: "declaredEffect", optional: true, value: (row) => row.declaredEffect },
          { name: "nextInstalment", optional: true, value: (row) => row.nextInstalment },
        ],
      );
    default:
      return null;
  }
}

export interface TypedPromptItem {
  fileName: string;
  document: ExtractedDocument;
}

/**
 * Cards always, compact detail only for series/positions and only when the
 * whole table fits in `payloadBudgetChars` (the JSON of the documents array,
 * not the fence around it). Newest first so this turn wins; a table that does
 * not fit is omitted whole, never sampled.
 *
 * When `packDetails` is false (this turn brought a notebook that will consume
 * the remainder), every packable document is card-only.
 */
export function typedPromptDocuments(
  items: readonly TypedPromptItem[],
  payloadBudgetChars: number,
  packDetails: boolean,
): unknown[] {
  const packed = new Set<number>();

  const payload = (): unknown[] =>
    items.map((item, index) => {
      const includeDetail = packed.has(index);
      const omitNotice =
        !includeDetail &&
        (isPackableDocument(item.document) || omitsDetailByPolicy(item.document));
      return {
        ...typedDocumentCard(item.fileName, item.document, omitNotice),
        ...(includeDetail ? { detail: promptDetail(item.document) } : {}),
      };
    });

  if (!packDetails) return payload();

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || !isPackableDocument(item.document)) continue;
    packed.add(index);
    if (JSON.stringify(payload()).length <= payloadBudgetChars) continue;
    packed.delete(index);
  }

  return payload();
}
