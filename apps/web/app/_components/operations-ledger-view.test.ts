import type { TransferRowCounterpart } from "@web/operation-kind-copy";
import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  LEDGER_RECENT_LIMIT,
  type LedgerRowReading,
  ledgerReturnUrl,
  ledgerRowsOnShow,
  readLedgerRow,
  readLedgerScope,
} from "./operations-ledger-view";

function op(overrides: Partial<InvestmentOperation> = {}): InvestmentOperation {
  return {
    assetId: "asset_1",
    currency: "EUR",
    executedAt: "2026-09-12",
    feesMinor: 100,
    id: "op_1",
    kind: "buy",
    pricePerUnit: "106.65",
    units: "5",
    ...overrides,
  };
}

/**
 * The row with Intl's no-break spaces read as plain ones: the money formatter keeps
 * «1 €» on one line with U+00A0, which is not what these assertions are about.
 */
function read(
  operation: InvestmentOperation,
  privacyMode = false,
  counterpart: TransferRowCounterpart = { kind: "unresolved" },
): LedgerRowReading {
  const row = readLedgerRow(operation, { counterpart, privacyMode });
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string" ? value.replace(/[  ]/g, " ") : value,
    ]),
  ) as unknown as LedgerRowReading;
}

describe("una fila del libro (#1827)", () => {
  test("una compra dice su fecha, su tipo y su importe con comisión, con sus céntimos", () => {
    const row = read(op());

    expect(row.date).toBe("12/09/2026");
    expect(row.kind).toBe("Compra");
    expect(row.units).toBe("5");
    expect(row.price).toBe("106,65 €");
    expect(row.fees).toBe("1 €");
    expect(row.amount).toBe("534,25 €");
  });

  test("en el móvil la segunda línea es la cuenta: participaciones × precio · comisión", () => {
    expect(read(op()).calc).toBe("5 × 106,65 € · comisión 1 €");
  });

  test("sin comisión, la cuenta no la nombra y la columna queda vacía", () => {
    const row = read(op({ feesMinor: 0 }));

    expect(row.fees).toBeNull();
    expect(row.calc).toBe("5 × 106,65 €");
    expect(row.amount).toBe("533,25 €");
  });

  test("una venta neta su comisión", () => {
    expect(read(op({ kind: "sell" })).amount).toBe("532,25 €");
  });

  test("la salida de un traspaso nombra su destino", () => {
    const row = read(
      op({ feesMinor: 0, kind: "transfer_out", pricePerUnit: "150", transferId: "t" }),
      false,
      { kind: "holding", name: "Fondo Azul" },
    );

    expect(row.kind).toBe("Traspaso (salida)");
    expect(row.note).toBe("a Fondo Azul");
    expect(row.amount).toBe("750 €");
  });

  test("una operación convertida enseña los euros y, al lado, lo que dijo el banco (#1401)", () => {
    const row = read(
      op({
        capture: {
          currency: "USD",
          eurPerUnit: 0.85,
          feesMinor: 150,
          pricePerUnit: "8.00",
        },
        feesMinor: 128,
        pricePerUnit: "6.8",
        units: "0.255",
      }),
    );

    expect(row.price).toBe("6,8 €");
    expect(row.priceCapture).toBe("8 USD");
    expect(row.feesCapture).toContain("1,50");
    expect(row.feesCapture).toContain("US$");
    // 0,255 × 6,8 € = 1,734 € → 1,73 €, más 1,28 € de comisión.
    expect(row.amount).toBe("3,01 €");
    expect(row.calc).toBe(`0,255 × 6,8 € (8 USD) · comisión 1,28 € (${row.feesCapture})`);
  });

  test("la fila optimista, tal como se tecleó, ya dice su importe sin leerse como euros", () => {
    // Lo que el formulario añade antes de que la acción resuelva: cifras con coma y
    // la divisa tecleada, sin tipo de cambio todavía.
    const row = read(
      op({ currency: "USD", feesMinor: 0, pricePerUnit: "8,00", units: "2" }),
    );

    expect(row.price).toBe("8,00 USD");
    expect(row.amount).toContain("16");
    expect(row.amount).toContain("US$");
  });

  test("una cifra tecleada que no se puede leer no inventa un importe", () => {
    expect(read(op({ units: "cinco" })).amount).toBe("—");
  });

  test("el modo privado enmascara precio, comisión e importe, no la fecha", () => {
    const row = read(op(), true);

    expect(row.date).toBe("12/09/2026");
    expect(row.price).not.toMatch(/\d/);
    expect(row.fees).not.toMatch(/\d/);
    expect(row.amount).not.toMatch(/\d/);
    expect(row.amount).toContain("€");
  });
});

describe("las 10 últimas y «Ver las N operaciones» (#1827)", () => {
  const rows = Array.from({ length: 12 }, (_, index) => index);

  test("con diez o menos se ven todas y no hay nada que desplegar", () => {
    const view = ledgerRowsOnShow(rows.slice(0, LEDGER_RECENT_LIMIT), false);

    expect(view.shown).toHaveLength(10);
    expect(view.toggle).toBeNull();
  });

  test("con más, se ven las diez primeras y el botón cuenta todas", () => {
    const view = ledgerRowsOnShow(rows, false);

    expect(view.shown).toEqual(rows.slice(0, 10));
    expect(view.toggle).toEqual({ expanded: false, label: "Ver las 12 operaciones" });
  });

  test("desplegado, se ven todas y el botón ofrece volver a las diez", () => {
    const view = ledgerRowsOnShow(rows, true);

    expect(view.shown).toHaveLength(12);
    expect(view.toggle).toEqual({ expanded: true, label: "Ver solo las 10 últimas" });
  });

  test("el libro desplegado vive en la URL, y la URL limpia es el libro plegado", () => {
    expect(readLedgerScope("?libro=todas")).toBe("todas");
    expect(readLedgerScope("?pesta%C3%B1a=cobros")).toBe("recientes");
    expect(readLedgerScope("?libro=cualquiera")).toBe("recientes");
  });

  test("borrar con el libro desplegado vuelve al libro desplegado", () => {
    // El terminal de «Eliminar» aterriza en `currentUrl`: tiene que llevar el despliegue.
    expect(ledgerReturnUrl("/patrimonio/wl_hld_1/editar", "todas")).toBe(
      "/patrimonio/wl_hld_1/editar?libro=todas",
    );
    expect(ledgerReturnUrl("/patrimonio/wl_hld_1/editar?privado=1", "todas")).toBe(
      "/patrimonio/wl_hld_1/editar?privado=1&libro=todas",
    );
    expect(ledgerReturnUrl("/patrimonio/wl_hld_1/editar", "recientes")).toBe(
      "/patrimonio/wl_hld_1/editar",
    );
  });

  test("una fila recién registrada se ve aunque caiga más allá de la décima (#1829)", () => {
    // Una compra con fecha atrasada se ordena abajo; tras registrarla, tiene que verse.
    const view = ledgerRowsOnShow(rows, false, (row) => row === 11);

    expect(view.shown).toEqual([...rows.slice(0, 10), 11]);
    expect(view.toggle).toEqual({ expanded: false, label: "Ver las 12 operaciones" });
  });
});
