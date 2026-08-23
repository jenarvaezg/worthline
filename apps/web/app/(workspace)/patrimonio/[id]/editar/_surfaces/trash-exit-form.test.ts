import { describe, expect, test } from "vitest";

import { parseTrashSaleForm } from "./trash-exit-form";

/**
 * The «Lo vendí» exit of the Papelera door (#1549). The owner states the two figures
 * a bank confirmation prints — date and importe — and the door derives the rest from
 * the ledger it already folded, so the sale that closes the position cannot disagree
 * with the position it closes.
 */
const CONTEXT = { currency: "EUR", netUnits: "120.5", today: "2026-08-23" } as const;

describe("parseTrashSaleForm — the sale closes the position", () => {
  test("sells every participación the ledger still holds, at the importe over them", () => {
    const parsed = parseTrashSaleForm(
      { soldAmount: "7642,00", soldAt: "2026-08-01" },
      CONTEXT,
    );

    expect(parsed).toEqual({
      command: {
        amountMinor: 764_200,
        currency: "EUR",
        executedAt: "2026-08-01",
        // 7642 / 120,5 at the readback precision the rest of the book uses.
        pricePerUnit: "63.41908714",
        units: "120.5",
      },
      ok: true,
    });
  });

  test("an empty date is today — the ordinary case is «lo acabo de vender»", () => {
    const parsed = parseTrashSaleForm({ soldAmount: "100", soldAt: "  " }, CONTEXT);

    expect(parsed.ok && parsed.command.executedAt).toBe("2026-08-23");
  });
});

describe("parseTrashSaleForm — refusals stay in the door", () => {
  test("no importe is not a sale: the door asks for it instead of writing a 0 €", () => {
    for (const soldAmount of ["", "0", "-40"]) {
      const parsed = parseTrashSaleForm({ soldAmount, soldAt: "2026-08-01" }, CONTEXT);
      expect(parsed).toEqual({
        error: "Escribe el importe que recibiste por la venta.",
        ok: false,
      });
    }
  });

  test("an importe that rounds the VL away is refused, never stored at zero", () => {
    const parsed = parseTrashSaleForm(
      { soldAmount: "0,01", soldAt: "2026-08-01" },
      { ...CONTEXT, netUnits: "9000000" },
    );

    expect(parsed).toEqual({
      error: "Ese importe es demasiado pequeño para las participaciones que quedan.",
      ok: false,
    });
  });

  test("a position already at zero has no sale to record", () => {
    const parsed = parseTrashSaleForm(
      { soldAmount: "100", soldAt: "2026-08-01" },
      {
        ...CONTEXT,
        netUnits: "0",
      },
    );

    expect(parsed).toEqual({
      error: "Esta posición ya está a cero: elimínala sin registrar ninguna venta.",
      ok: false,
    });
  });
});
