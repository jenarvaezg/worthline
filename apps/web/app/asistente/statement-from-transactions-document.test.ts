import { describe, expect, test } from "vitest";

import {
  type ExtractedBrokerTransactionsDocument,
  type ExtractedDocument,
  extractedDocumentSchema,
} from "./attachment-extraction-contract";
import {
  brokerTransactionsInContext,
  statementFromTransactionsDocument,
} from "./statement-from-transactions-document";

/**
 * The frontier of #1487: `propose_statement_import` has always taken `rawText`, so a
 * document worthline READ could only reach it by being retyped through a model that does
 * not reproduce digits reliably (#1423). Here the rows come from the reading.
 */
const SXR1 = "IE00B5BMR087";

const DOCUMENT: ExtractedBrokerTransactionsDocument = {
  documentType: "broker_transactions",
  transactions: [
    {
      amount: "562.44",
      currency: "EUR",
      date: "2026-02-12",
      feesMinor: 100,
      isin: SXR1,
      kind: "buy",
      name: "ISHARES CORE S&P 500",
      pricePerUnit: "187.48",
      units: "3",
    },
    {
      amount: "380",
      currency: "EUR",
      date: "2026-03-03",
      isin: SXR1,
      kind: "sell",
      pricePerUnit: "190",
      units: "2",
    },
  ],
  warnings: [],
};

function validated(document: unknown): ExtractedDocument {
  return extractedDocumentSchema.parse(document);
}

describe("statementFromTransactionsDocument", () => {
  test("maps the read rows onto the statement contract, fees included", () => {
    const read = statementFromTransactionsDocument(DOCUMENT);
    if (!read.ok) throw new Error(`expected ok, got ${read.error}`);

    expect(read.statement.isin).toBe(SXR1);
    expect(read.statement.isins).toEqual([SXR1]);
    expect(read.statement.directionResolved).toBe(true);
    expect(read.statement.rows).toEqual([
      {
        currency: "EUR",
        dateKey: "2026-02-12",
        feesMinor: 100,
        isin: SXR1,
        kind: "buy",
        name: "ISHARES CORE S&P 500",
        pricePerUnit: "187.48",
        units: "3",
      },
      {
        currency: "EUR",
        dateKey: "2026-03-03",
        feesMinor: 0,
        isin: SXR1,
        kind: "sell",
        pricePerUnit: "190",
        units: "2",
      },
    ]);
  });

  test("a doubtful reading travels as a statement whose direction is unresolved", () => {
    const read = statementFromTransactionsDocument({ ...DOCUMENT, uncertain: true });
    if (!read.ok) throw new Error("expected ok");

    expect(read.statement.directionResolved).toBe(false);
  });

  test("a row with no ISIN refuses the whole import and names the row", () => {
    const read = statementFromTransactionsDocument({
      ...DOCUMENT,
      transactions: [
        DOCUMENT.transactions[0]!,
        {
          amount: "1000",
          currency: "EUR",
          date: "2026-04-01",
          kind: "buy",
          name: "FONDO SIN ISIN",
          pricePerUnit: "10",
          units: "100",
        },
      ],
    });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toBe("statement_rows_without_isin");
    expect(read.message).toContain("FONDO SIN ISIN");
  });

  test("a currency the app cannot capture is refused, never coerced to euros", () => {
    const read = statementFromTransactionsDocument({
      ...DOCUMENT,
      transactions: [{ ...DOCUMENT.transactions[0]!, currency: "COP" }],
    });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toBe("statement_currency_unsupported");
    expect(read.message).toContain("COP");
  });
});

describe("brokerTransactionsInContext", () => {
  test("finds nothing when the turn's only document is another kind", () => {
    const balances = validated({
      documentType: "balance_series",
      balances: [{ amount: 1000, currency: "EUR", date: "2026-02-12" }],
      warnings: [],
    });

    expect(brokerTransactionsInContext([balances])).toBeNull();
  });

  test("takes the last ledger of the turn", () => {
    const first = validated(DOCUMENT);
    const second = validated({
      ...DOCUMENT,
      transactions: [{ ...DOCUMENT.transactions[0]!, units: "9" }],
    });

    expect(brokerTransactionsInContext([first, second])?.transactions[0]?.units).toBe(
      "9",
    );
  });
});
