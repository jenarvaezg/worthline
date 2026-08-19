import { describe, expect, test } from "vitest";

import { extractBrokerTransactionsFromSpreadsheet } from "./attachment-broker-transactions-extractor";

/**
 * A DEGIRO `Transactions` export as a CSV: the measured 17-column header (two columns
 * with no header at all, carrying the currency of the figure to their left) with
 * synthetic values.
 */
const HEADER =
  "Fecha;Hora;Producto;ISIN;Bolsa de referencia;Centro de ejecución;Número;Precio;;" +
  "Valor local;;Valor EUR;Tipo de cambio;Comisión AutoFX;" +
  "Costes de transacción y/o externos EUR;Total EUR;ID Orden";

const BUY =
  "12-02-2026;09:04;ISHARES CORE S&P 500;IE00B5BMR087;EAM;XAMS;3;187,48;EUR;" +
  "-562,44;EUR;-562,44;;;-1,00;-563,44;aa11";

const SELL =
  "03-03-2026;10:15;ISHARES CORE S&P 500;IE00B5BMR087;EAM;XAMS;-2;190,00;EUR;" +
  "380,00;EUR;380,00;;;-1,00;379,00;bb22";

function csv(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}

function input(bytes: Uint8Array, fileName = "Transactions.csv") {
  return { bytes, fileName, mimeType: "text/csv" };
}

function transactions(lines: readonly string[]) {
  const result = extractBrokerTransactionsFromSpreadsheet(input(csv(lines)));
  if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
  if (result.data.documentType !== "broker_transactions") {
    throw new Error(`expected broker_transactions, got ${result.data.documentType}`);
  }
  return result.data;
}

describe("broker transactions spreadsheet extractor", () => {
  test("reads a broker transactions export into the shared contract", () => {
    const data = transactions([HEADER, BUY, SELL]);

    expect(data.transactions).toEqual([
      {
        amount: "562.44",
        currency: "EUR",
        date: "2026-02-12",
        feesMinor: 100,
        isin: "IE00B5BMR087",
        kind: "buy",
        name: "ISHARES CORE S&P 500",
        orderId: "aa11",
        pricePerUnit: "187.48",
        units: "3",
      },
      {
        amount: "380",
        currency: "EUR",
        date: "2026-03-03",
        feesMinor: 100,
        isin: "IE00B5BMR087",
        kind: "sell",
        name: "ISHARES CORE S&P 500",
        orderId: "bb22",
        pricePerUnit: "190",
        units: "2",
      },
    ]);
    expect(data.uncertain).toBeUndefined();
    expect(data.warnings).toEqual([]);
  });

  test("a reading with an assumed direction is marked uncertain on the document", () => {
    const data = transactions([
      "Fecha;ISIN;Cantidad;Importe;Divisa",
      "12-02-2026;IE00B5BMR087;3;562,44;EUR",
    ]);

    expect(data.uncertain).toBe(true);
    expect(data.warnings.join(" ")).toContain("compras");
  });

  test("a row that is not a trade is skipped and the rest still travel", () => {
    const data = transactions([
      HEADER,
      "12-02-2026;09:04;INGRESO;;;;0;;EUR;;EUR;500,00;;;;500,00;",
      BUY,
    ]);

    expect(data.transactions).toHaveLength(1);
    expect(data.warnings.join(" ")).toContain("Fila 1");
  });

  test("a sheet that is not a ledger stays unrecognized so #865's lane survives", () => {
    const result = extractBrokerTransactionsFromSpreadsheet(
      input(csv(["Concepto;Notas", "Cuenta nómina;revisar"])),
    );

    expect(result.status).toBe("unrecognized");
  });

  test("an unreadable workbook is a definitive failure, not a silent pass", () => {
    const result = extractBrokerTransactionsFromSpreadsheet({
      bytes: new Uint8Array([0xff, 0xfe, 0x00]),
      fileName: "Transactions.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.status).toBe("failure");
  });
});
