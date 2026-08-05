import { describe, expect, it } from "vitest";

import {
  type InstrumentIdentityHolding,
  resolveInstrumentIdentityFill,
} from "./instrument-identity-fill";

const TARGET: InstrumentIdentityHolding = {
  id: "asset_target",
  name: "Vanguard Global Stock",
};

/** Real ISINs (valid checksum) — the guards must not be measurable by shape alone. */
const ISIN_A = "IE00B03HCZ61";
const ISIN_B = "IE00B1G3DH73";

function resolve(input: {
  target?: InstrumentIdentityHolding;
  declaration: { isin?: string; providerSymbol?: string };
  portfolio?: readonly InstrumentIdentityHolding[];
}) {
  return resolveInstrumentIdentityFill({
    declaration: input.declaration,
    portfolio: input.portfolio ?? [input.target ?? TARGET],
    target: input.target ?? TARGET,
  });
}

describe("resolveInstrumentIdentityFill", () => {
  it("fills an empty ISIN, normalizing case and spacing", () => {
    const result = resolve({ declaration: { isin: " ie00b03hcz61 " } });

    expect(result).toEqual({ ok: true, patch: { isin: ISIN_A } });
  });

  it("fills an empty provider symbol without touching its case", () => {
    // CoinGecko ids are lowercase («bitcoin»), Yahoo suffixes uppercase (VUSA.L):
    // normalizing either way would break one of the two providers.
    const result = resolve({ declaration: { providerSymbol: " bitcoin " } });

    expect(result).toEqual({ ok: true, patch: { providerSymbol: "bitcoin" } });
  });

  it("fills both fields in one go", () => {
    const result = resolve({
      declaration: { isin: ISIN_A, providerSymbol: "VUSA.L" },
    });

    expect(result).toEqual({
      ok: true,
      patch: { isin: ISIN_A, providerSymbol: "VUSA.L" },
    });
  });

  it("refuses to overwrite an ISIN the holding already has, naming the ficha", () => {
    const result = resolve({
      declaration: { isin: ISIN_B },
      target: { ...TARGET, isin: ISIN_A },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(ISIN_A);
    expect(result.error).toContain("/patrimonio");
  });

  it("refuses to overwrite a provider symbol the holding already has", () => {
    const result = resolve({
      declaration: { providerSymbol: "VUSA.AS" },
      target: { ...TARGET, providerSymbol: "VUSA.L" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("VUSA.L");
    expect(result.error).toContain("/patrimonio");
  });

  it("refuses when another holding already claims that ISIN, naming it", () => {
    // The real case: the same fund in two brokers (one closed, one live). The pair
    // is legitimate — a human creates it in the ficha, seeing both.
    const result = resolve({
      declaration: { isin: ISIN_A },
      portfolio: [TARGET, { id: "asset_other", isin: ISIN_A, name: "MyInvestor Global" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("MyInvestor Global");
    expect(result.error).toContain(ISIN_A);
  });

  it("refuses when another holding already claims that provider symbol", () => {
    const result = resolve({
      declaration: { providerSymbol: "VUSA.L" },
      portfolio: [
        TARGET,
        { id: "asset_other", name: "S&P 500 en DEGIRO", providerSymbol: "VUSA.L" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("S&P 500 en DEGIRO");
  });

  it("compares claimants on the normalized ISIN, not the raw string", () => {
    const result = resolve({
      declaration: { isin: "ie00b03hcz61" },
      portfolio: [TARGET, { id: "asset_other", isin: ISIN_A, name: "MyInvestor Global" }],
    });

    expect(result.ok).toBe(false);
  });

  it("does not treat the target itself as a rival claimant", () => {
    // Re-declaring the ISIN the holding already has is a no-op, not a duplicate:
    // it must say «ya lo tiene», never «otro holding lo reclama».
    const result = resolve({
      declaration: { isin: ISIN_A },
      portfolio: [{ ...TARGET, isin: ISIN_A }],
      target: { ...TARGET, isin: ISIN_A },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ya");
    expect(result.error).not.toContain("otro holding");
  });

  it("rejects an ISIN that is not a valid ISIN", () => {
    const result = resolve({ declaration: { isin: "IE00B03HCZ62" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("IE00B03HCZ62");
  });

  it("rejects a declaration that changes nothing", () => {
    const result = resolve({ declaration: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no cambia nada");
  });

  it("treats blank strings as nothing declared", () => {
    const result = resolve({ declaration: { isin: "   ", providerSymbol: "" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no cambia nada");
  });
});
