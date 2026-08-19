import { describe, expect, test } from "vitest";

import { readBrokerTransactionTable } from "./broker-transaction-table";
import { statementFromBrokerTransactions } from "./statement-from-broker-transactions";

/**
 * The header of a real DEGIRO `Transactions.xlsx` (#1488) — the same measured shape the
 * reader's own test uses, kept here rather than shared so each test states the file it
 * is about. Values are synthetic.
 */
const DEGIRO_HEADER = [
  "Fecha",
  "Hora",
  "Producto",
  "ISIN",
  "Bolsa de referencia",
  "Centro de ejecución",
  "Número",
  "Precio",
  "",
  "Valor local",
  "",
  "Valor EUR",
  "Tipo de cambio",
  "Comisión AutoFX",
  "Costes de transacción y/o externos EUR",
  "Total EUR",
  "ID Orden",
];

function degiroRow(cells: {
  date: string;
  isin: string;
  units: string;
  price: string;
  value: string;
  currency?: string;
}): string[] {
  const currency = cells.currency ?? "EUR";
  return [
    cells.date,
    "09:04",
    "ISHARES CORE S&P 500",
    cells.isin,
    "EAM",
    "XAMS",
    cells.units,
    cells.price,
    currency,
    cells.value,
    currency,
    cells.value,
    "",
    "",
    "-1,00",
    cells.value,
    "aa11",
  ];
}

const BUY = degiroRow({
  date: "12-02-2026",
  isin: "IE00B5BMR087",
  price: "187,48",
  units: "3",
  value: "-562,44",
});

const SELL = degiroRow({
  date: "03-03-2026",
  isin: "IE00B5BMR087",
  price: "190,00",
  units: "-2",
  value: "380,00",
});

function tableOf(rows: readonly string[][]) {
  const table = readBrokerTransactionTable(rows);
  if (table === null) throw new Error("expected a transactions table");
  return table;
}

function statementOf(rows: readonly string[][]) {
  const result = statementFromBrokerTransactions(tableOf(rows));
  if (!result.ok) throw new Error(`expected a statement, got: ${result.message}`);
  return result;
}

describe("statementFromBrokerTransactions", () => {
  test("maps a DEGIRO export onto the statement contract the import gate consumes", () => {
    const { statement } = statementOf([DEGIRO_HEADER, BUY, SELL]);

    expect(statement.rows).toEqual([
      {
        currency: "EUR",
        dateKey: "2026-02-12",
        feesMinor: 100,
        isin: "IE00B5BMR087",
        kind: "buy",
        name: "ISHARES CORE S&P 500",
        pricePerUnit: "187.48",
        units: "3",
      },
      {
        currency: "EUR",
        dateKey: "2026-03-03",
        feesMinor: 100,
        isin: "IE00B5BMR087",
        kind: "sell",
        name: "ISHARES CORE S&P 500",
        pricePerUnit: "190",
        units: "2",
      },
    ]);
    expect(statement.isin).toBe("IE00B5BMR087");
    expect(statement.isins).toEqual(["IE00B5BMR087"]);
    expect(statement.skipped).toEqual([]);
  });

  test("keeps every distinct ISIN, and reports no single one when the file mixes them", () => {
    const other = degiroRow({
      date: "01-04-2026",
      isin: "IE00B4L5Y983",
      price: "100,00",
      units: "1",
      value: "-100,00",
    });
    const { statement } = statementOf([DEGIRO_HEADER, BUY, other]);

    expect(statement.isin).toBeNull();
    expect(statement.isins).toEqual(["IE00B5BMR087", "IE00B4L5Y983"]);
  });

  test("a direction read from the sign is resolved direction", () => {
    expect(statementOf([DEGIRO_HEADER, BUY, SELL]).statement.directionResolved).toBe(
      true,
    );
  });

  test("a direction nothing in the file states leaves the statement unresolved, and says so", () => {
    // No operation column, no sign anywhere: every row reads as a buy, and the reader
    // says it out loud. The gate must carry that doubt to the pre-confirm warning.
    const header = ["Fecha", "ISIN", "Producto", "Número", "Precio"];
    const row = ["12-02-2026", "IE00B5BMR087", "ISHARES", "3", "187,48"];
    const { statement, warnings } = statementOf([header, row]);

    expect(statement.directionResolved).toBe(false);
    expect(warnings.some((warning) => warning.includes("compra o una venta"))).toBe(true);
  });

  test("the reader's warnings travel with the statement", () => {
    const unreadable = degiroRow({
      date: "no es una fecha",
      isin: "IE00B5BMR087",
      price: "187,48",
      units: "3",
      value: "-562,44",
    });
    const { statement, warnings } = statementOf([DEGIRO_HEADER, BUY, unreadable]);

    expect(statement.rows).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("refuses the whole file when a trade carries no ISIN, and names the rows", () => {
    // A row the planner would route by ISIN and silently DROP: importing it would load
    // some of the file and say nothing (ADR 0010 — every row or none).
    const withoutIsin = degiroRow({
      date: "01-04-2026",
      isin: "",
      price: "100,00",
      units: "1",
      value: "-100,00",
    });
    const result = statementFromBrokerTransactions(
      tableOf([DEGIRO_HEADER, BUY, withoutIsin]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("ISIN");
    expect(result.message).toContain("2026-04-01");
    expect(result.message).toContain("plantilla");
  });

  test("refuses a currency the ledger cannot capture, without converting it itself", () => {
    const inRands = degiroRow({
      currency: "ZAR",
      date: "01-04-2026",
      isin: "IE00B5BMR087",
      price: "100,00",
      units: "1",
      value: "-100,00",
    });
    const result = statementFromBrokerTransactions(tableOf([DEGIRO_HEADER, inRands]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("ZAR");
  });

  test("a table with no readable trade is not a statement", () => {
    const result = statementFromBrokerTransactions({
      assumedCurrency: false,
      directionSource: "units_sign",
      rows: [],
      warnings: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("no contiene");
  });
});
