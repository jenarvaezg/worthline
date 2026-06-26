import { describe, expect, test } from "vitest";

import { deriveOpeningUnits, previewOpeningUnits } from "./investment-units";

describe("deriveOpeningUnits — saldo ÷ precio (#597)", () => {
  test("derives units from an es-ES saldo and price, round-tripping to the saldo", () => {
    const result = deriveOpeningUnits({ saldoRaw: "1.000,00", priceRaw: "50.000,00" });
    expect(result).toEqual({ ok: true, units: "0.02", price: "50000.00" });
  });

  test("keeps full precision for a fractional crypto unit count", () => {
    const result = deriveOpeningUnits({ saldoRaw: "100,00", priceRaw: "3,00" });
    // 100 / 3 = 33.333…, carried at high precision so units × price ≈ saldo.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Number.parseFloat(result.units)).toBeCloseTo(33.3333, 3);
    }
  });

  test("flags a missing/zero price (the manual-fallback case)", () => {
    expect(deriveOpeningUnits({ saldoRaw: "1.000,00", priceRaw: "" })).toEqual({
      ok: false,
      reason: "price",
    });
    expect(deriveOpeningUnits({ saldoRaw: "1.000,00", priceRaw: "0,00" })).toEqual({
      ok: false,
      reason: "price",
    });
  });

  test("flags a missing/zero saldo before complaining about price", () => {
    expect(deriveOpeningUnits({ saldoRaw: "", priceRaw: "215,40" })).toEqual({
      ok: false,
      reason: "saldo",
    });
  });

  test("previewOpeningUnits returns the units string or null for the live hint", () => {
    expect(previewOpeningUnits("1.000,00", "50.000,00")).toBe("0.02");
    expect(previewOpeningUnits("", "50.000,00")).toBeNull();
    expect(previewOpeningUnits("1.000,00", "")).toBeNull();
  });
});
