import { normalizeNonNegativeDecimalString } from "@web/intake-primitives";
import { deriveOpeningUnits } from "@web/patrimonio/anadir/investment-units";
import { describe, expect, test } from "vitest";
import { extractedPositionSchema } from "./attachment-extraction-contract";
import { buildWizardPrefillParams, wizardPrefillHref } from "./attachment-wizard-prefill";

const position = (overrides: Record<string, unknown> = {}) =>
  extractedPositionSchema.parse({
    currency: "EUR",
    marketValueEur: 1234.56,
    name: "Fondo global",
    ticker: "VWCE",
    units: 10.5,
    ...overrides,
  });

describe("buildWizardPrefillParams", () => {
  test("maps a position onto the investment drawer's fund fields", () => {
    const params = buildWizardPrefillParams(position());

    expect(params.simpleDrawer).toBe("inversion");
    expect(params.instrument).toBe("fund");
    expect(params.invMode_fund).toBe("saldo");
    expect(params.name_fund).toBe("Fondo global");
    expect(params.symbol_fund).toBe("VWCE");
  });

  test("carries the euro value as saldo and the derived unit price", () => {
    const params = buildWizardPrefillParams(position());

    // Both fields must survive the wizard's own es-ES normalizer untouched.
    expect(normalizeNonNegativeDecimalString(params.saldo_fund!)).not.toBeNull();
    expect(normalizeNonNegativeDecimalString(params.price_fund!)).not.toBeNull();
    expect(Number.parseFloat(params.saldo_fund!)).toBeCloseTo(1234.56, 2);
  });

  test("the prefilled saldo + price reproduce the extracted units in the wizard", () => {
    const pos = position();
    const params = buildWizardPrefillParams(pos);

    // Prove the prefill is consistent with what the wizard would persist: feed
    // it straight into the same pure helper the server action uses.
    const derived = deriveOpeningUnits({
      priceRaw: params.price_fund!,
      saldoRaw: params.saldo_fund!,
    });

    expect(derived.ok).toBe(true);
    if (derived.ok) {
      expect(Number.parseFloat(derived.units)).toBeCloseTo(pos.units, 3);
    }
  });

  test("leaves the price pending when units are zero (never invents one)", () => {
    const params = buildWizardPrefillParams(position({ units: 0 }));

    expect(params.saldo_fund).toBeDefined();
    expect(params.price_fund).toBeUndefined();
    expect(params.name_fund).toBe("Fondo global");
  });

  test("leaves saldo and price pending when there is no euro value", () => {
    const params = buildWizardPrefillParams(position({ marketValueEur: 0 }));

    expect(params.saldo_fund).toBeUndefined();
    expect(params.price_fund).toBeUndefined();
    // The identity fields still travel so the user does not retype them.
    expect(params.name_fund).toBe("Fondo global");
    expect(params.symbol_fund).toBe("VWCE");
  });

  test("carries an uncertain position too — control stays with the user", () => {
    const params = buildWizardPrefillParams(position({ uncertain: true }));

    expect(params.name_fund).toBe("Fondo global");
    expect(params.saldo_fund).toBeDefined();
  });
});

describe("wizardPrefillHref", () => {
  test("targets the add-holding wizard with encoded prefill params", () => {
    const href = wizardPrefillHref(position({ name: "Fondo & Cía", ticker: "A B" }));

    expect(href.startsWith("/patrimonio/anadir?")).toBe(true);

    const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(query.get("simpleDrawer")).toBe("inversion");
    expect(query.get("instrument")).toBe("fund");
    expect(query.get("name_fund")).toBe("Fondo & Cía");
    expect(query.get("symbol_fund")).toBe("A B");
    // No write path is encoded: the href only carries wizard prefill state.
    expect(href).not.toContain("importar-extracto");
  });
});
