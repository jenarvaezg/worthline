import { describe, expect, test } from "vitest";

import { readBrokerTransactionTable } from "./broker-transaction-table";

/**
 * The header of a real DEGIRO `Transactions.xlsx` (#1487) — 17 columns, two of them
 * WITHOUT a header (the currency of the figure to their left). The values below are
 * synthetic; the shape is the measured one.
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
  time: string;
  product: string;
  isin: string;
  units: string;
  price: string;
  value: string;
  costs: string;
  total: string;
  orderId: string;
}): string[] {
  return [
    cells.date,
    cells.time,
    cells.product,
    cells.isin,
    "EAM",
    "XAMS",
    cells.units,
    cells.price,
    "EUR",
    cells.value,
    "EUR",
    cells.value,
    "",
    "",
    cells.costs,
    cells.total,
    cells.orderId,
  ];
}

const DEGIRO_BUY = degiroRow({
  costs: "-1,00",
  date: "12-02-2026",
  isin: "IE00B5BMR087",
  orderId: "aa11",
  price: "187,48",
  product: "ISHARES CORE S&P 500",
  time: "09:04",
  total: "-563,44",
  units: "3",
  value: "-562,44",
});

const DEGIRO_SELL = degiroRow({
  costs: "-1,00",
  date: "03-03-2026",
  isin: "IE00B5BMR087",
  orderId: "bb22",
  price: "190,00",
  product: "ISHARES CORE S&P 500",
  time: "10:15",
  total: "379,00",
  units: "-2",
  value: "380,00",
});

function read(rows: readonly string[][]) {
  const table = readBrokerTransactionTable(rows);
  if (table === null) throw new Error("expected a transactions table");
  return table;
}

describe("broker transaction table", () => {
  test("reads a DEGIRO export: the sign is the operation and the costs are fees", () => {
    const table = read([DEGIRO_HEADER, DEGIRO_BUY, DEGIRO_SELL]);

    expect(table.directionSource).toBe("units_sign");
    expect(table.rows).toEqual([
      {
        amount: "562.44",
        currency: "EUR",
        date: "2026-02-12",
        feesMinor: 100,
        isin: "IE00B5BMR087",
        kind: "buy",
        line: 1,
        name: "ISHARES CORE S&P 500",
        orderId: "aa11",
        pricePerUnit: "187.48",
        time: "09:04",
        uncertain: false,
        units: "3",
      },
      {
        amount: "380",
        currency: "EUR",
        date: "2026-03-03",
        feesMinor: 100,
        isin: "IE00B5BMR087",
        kind: "sell",
        line: 2,
        name: "ISHARES CORE S&P 500",
        orderId: "bb22",
        pricePerUnit: "190",
        time: "10:15",
        uncertain: false,
        units: "2",
      },
    ]);
    expect(table.warnings).toEqual([]);
  });

  test("both fee columns land in feesMinor, whatever their sign", () => {
    const row = [...DEGIRO_BUY];
    row[13] = "-0,50";
    const table = read([DEGIRO_HEADER, row]);

    expect(table.rows[0]?.feesMinor).toBe(150);
  });

  test("a textual operation column wins over the sign", () => {
    const table = read([
      ["Fecha", "Operación", "ISIN", "Títulos", "Importe", "Divisa"],
      ["2026-02-12", "Venta", "IE00B5BMR087", "3", "562,44", "EUR"],
    ]);

    expect(table.directionSource).toBe("operation");
    expect(table.rows[0]?.kind).toBe("sell");
    expect(table.rows[0]?.units).toBe("3");
  });

  test("without an amount column the gross is units × price", () => {
    const table = read([
      ["Fecha", "Producto", "Número", "Precio", "Divisa"],
      ["12/02/2026", "SXR1", "3", "187,48", "EUR"],
    ]);

    expect(table.rows[0]?.amount).toBe("562.44");
    expect(table.rows[0]?.pricePerUnit).toBe("187.48");
  });

  test("a net total plus fees recovers the gross amount", () => {
    const buy = read([
      ["Fecha", "ISIN", "Número", "Total EUR", "Comisión"],
      ["12-02-2026", "IE00B5BMR087", "3", "-563,44", "-1,00"],
    ]);
    expect(buy.rows[0]?.kind).toBe("buy");
    expect(buy.rows[0]?.amount).toBe("562.44");

    const sell = read([
      ["Fecha", "ISIN", "Número", "Total EUR", "Comisión"],
      ["12-02-2026", "IE00B5BMR087", "-3", "562,44", "-1,00"],
    ]);
    expect(sell.rows[0]?.kind).toBe("sell");
    expect(sell.rows[0]?.amount).toBe("563.44");
  });

  test("the currency comes from the column beside the figure when the header is blank", () => {
    const header = [...DEGIRO_HEADER];
    const row = [...DEGIRO_BUY];
    row[8] = "USD";
    row[10] = "USD";
    row[9] = "-600,00";
    const table = read([header, row]);

    expect(table.rows[0]?.currency).toBe("USD");
  });

  test("an unsigned export says so instead of guessing the direction", () => {
    const table = read([
      ["Fecha", "ISIN", "Cantidad", "Importe", "Divisa"],
      ["12-02-2026", "IE00B5BMR087", "3", "562,44", "EUR"],
    ]);

    expect(table.directionSource).toBe("assumed_buy");
    expect(table.rows[0]?.kind).toBe("buy");
    expect(table.rows[0]?.uncertain).toBe(true);
    expect(table.warnings.join(" ")).toContain("compra");
  });

  test("two signs that agree contradict each other, so the row is uncertain", () => {
    const row = [...DEGIRO_BUY];
    row[9] = "562,44";
    row[11] = "562,44";
    const table = read([DEGIRO_HEADER, row, DEGIRO_SELL]);

    expect(table.rows[0]?.uncertain).toBe(true);
    expect(table.warnings.join(" ")).toContain("Fila 1");
  });

  test("a row the operation column does not call a trade is skipped, not read as a buy", () => {
    const table = read([
      ["Fecha", "Operación", "ISIN", "Títulos", "Importe", "Divisa"],
      ["2026-02-12", "Dividendo", "IE00B5BMR087", "3", "12,00", "EUR"],
      ["2026-02-13", "", "IE00B5BMR087", "3", "12,00", "EUR"],
      ["2026-03-03", "Venta", "IE00B5BMR087", "3", "562,44", "EUR"],
    ]);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.kind).toBe("sell");
    expect(table.warnings.join(" ")).toContain("Dividendo");
    expect(table.warnings.join(" ")).toContain("Fila 2");
  });

  test("under the cash convention, a row with no cash figure is skipped, not a sale", () => {
    const table = read([
      ["Fecha", "ISIN", "Cantidad", "Precio", "Importe", "Divisa"],
      ["12-02-2026", "IE00B5BMR087", "3", "187,48", "-562,44", "EUR"],
      // Same price, no importe: its sign is the only one left and a price is positive
      // on a sale too, so nothing here says which way this row runs.
      ["13-02-2026", "IE00B5BMR087", "3", "187,48", "", "EUR"],
    ]);

    expect(table.directionSource).toBe("amount_sign");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.kind).toBe("buy");
    expect(table.warnings.join(" ")).toContain("no dice si es una compra o una venta");
  });

  test("the header is searched for, not assumed", () => {
    const table = read([
      ["Transacciones"],
      ["Cuenta: NL00 0000"],
      [],
      DEGIRO_HEADER,
      DEGIRO_BUY,
    ]);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.date).toBe("2026-02-12");
  });

  test("a row with no units is not a trade and is skipped with a warning", () => {
    const row = [...DEGIRO_BUY];
    row[6] = "0";
    const table = read([DEGIRO_HEADER, row, DEGIRO_SELL]);

    expect(table.rows).toHaveLength(1);
    expect(table.warnings.join(" ")).toContain("Fila 1");
  });

  test("a fee stated in another currency is dropped, never converted", () => {
    const table = read([
      ["Fecha", "ISIN", "Número", "Importe", "Divisa", "Comisión (EUR)"],
      ["12-02-2026", "IE00B5BMR087", "-3", "562,44", "USD", "1,00"],
    ]);

    expect(table.rows[0]?.feesMinor).toBe(0);
    expect(table.warnings.join(" ")).toContain("comisión");
  });

  test("a positions snapshot is not a transactions table", () => {
    expect(
      readBrokerTransactionTable([
        ["Nombre", "Tipo", "Valor", "Divisa"],
        ["Fondo Indexado", "Fondo", "12.345,67", "EUR"],
      ]),
    ).toBeNull();
  });

  test("an amortization schedule is not a transactions table", () => {
    expect(
      readBrokerTransactionTable([
        ["Fecha", "Cuota", "Saldo pendiente"],
        ["01-02-2026", "665,80", "169.653,18"],
      ]),
    ).toBeNull();
  });

  test("a recognized header with no readable row is not a table either", () => {
    expect(readBrokerTransactionTable([DEGIRO_HEADER, degiroRowOfNothing()])).toBeNull();
  });

  test("an unparseable date skips the row and says which one", () => {
    const row = [...DEGIRO_BUY];
    row[0] = "el martes";
    const table = read([DEGIRO_HEADER, row, DEGIRO_SELL]);

    expect(table.rows).toHaveLength(1);
    expect(table.warnings.join(" ")).toContain("fecha");
  });

  test("the ISIN travels only when it is a real ISIN", () => {
    const row = [...DEGIRO_BUY];
    row[3] = "SXR1";
    const table = read([DEGIRO_HEADER, row]);

    expect(table.rows[0]?.isin).toBeNull();
    expect(table.rows[0]?.name).toBe("ISHARES CORE S&P 500");
  });
});

function degiroRowOfNothing(): string[] {
  return degiroRow({
    costs: "",
    date: "no es una fecha",
    isin: "",
    orderId: "",
    price: "",
    product: "",
    time: "",
    total: "",
    units: "",
    value: "",
  });
}
