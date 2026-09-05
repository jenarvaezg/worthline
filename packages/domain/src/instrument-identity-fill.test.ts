import { describe, expect, it } from "vitest";

import {
  type InstrumentIdentityDeclaration,
  type InstrumentIdentityHolding,
  resolveInstrumentIdentityFill,
} from "./instrument-identity-fill";
import type { SecurityId, StoredSecurityId } from "./security-id";

const TARGET: InstrumentIdentityHolding = {
  id: "asset_target",
  name: "Vanguard Global Stock",
};

/** Real ISINs (valid checksum) — the guards must not be measurable by shape alone. */
const ISIN_A = "IE00B03HCZ61";
const ISIN_B = "IE00B1G3DH73";

/** The DGS code of a real plan — a pension plan has no ISIN at all (#1741). */
const DGS_CODE = "N5394";

/** The declaration shorthand the tests read best: an ISIN string is the common case. */
function isin(value: string): SecurityId {
  return { kind: "isin", value };
}

function stored(value: string): StoredSecurityId {
  return { kind: "isin", value };
}

function resolve(input: {
  target?: InstrumentIdentityHolding;
  declaration: InstrumentIdentityDeclaration;
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
    const result = resolve({ declaration: { securityId: isin(" ie00b03hcz61 ") } });

    expect(result).toEqual({ ok: true, patch: { securityId: isin(ISIN_A) } });
  });

  it("fills an empty provider symbol without touching its case", () => {
    // CoinGecko ids are lowercase («bitcoin»), Yahoo suffixes uppercase (VUSA.L):
    // normalizing either way would break one of the two providers.
    const result = resolve({ declaration: { providerSymbol: " bitcoin " } });

    expect(result).toEqual({ ok: true, patch: { providerSymbol: "bitcoin" } });
  });

  it("fills both fields in one go", () => {
    const result = resolve({
      declaration: { providerSymbol: "VUSA.L", securityId: isin(ISIN_A) },
    });

    expect(result).toEqual({
      ok: true,
      patch: { providerSymbol: "VUSA.L", securityId: isin(ISIN_A) },
    });
  });

  it("refuses to overwrite an ISIN the holding already has, naming the ficha", () => {
    const result = resolve({
      declaration: { securityId: isin(ISIN_B) },
      target: { ...TARGET, securityId: stored(ISIN_A) },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(ISIN_A);
    expect(result.error).toContain("ficha");
  });

  it("refuses to overwrite a provider symbol the holding already has", () => {
    const result = resolve({
      declaration: { providerSymbol: "VUSA.AS" },
      target: { ...TARGET, providerSymbol: "VUSA.L" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("VUSA.L");
    expect(result.error).toContain("ficha");
  });

  it("refuses when another holding already claims that ISIN, naming it", () => {
    // The real case: the same fund in two brokers (one closed, one live). The pair
    // is legitimate — a human creates it in the ficha, seeing both.
    const result = resolve({
      declaration: { securityId: isin(ISIN_A) },
      portfolio: [
        TARGET,
        { id: "asset_other", name: "MyInvestor Global", securityId: stored(ISIN_A) },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("MyInvestor Global");
    expect(result.error).toContain(ISIN_A);
  });

  it("allows a provider symbol another holding already uses", () => {
    // The same ETF at two brokers shares its symbol, both price off the same quote,
    // and the symbol is what an unpriced holding is missing — unlike a duplicated
    // ISIN, which hands an importer a second claimant for a row it may overwrite.
    const result = resolve({
      declaration: { providerSymbol: "VUSA.L" },
      portfolio: [
        TARGET,
        { id: "asset_other", name: "S&P 500 en DEGIRO", providerSymbol: "VUSA.L" },
      ],
    });

    expect(result).toEqual({ ok: true, patch: { providerSymbol: "VUSA.L" } });
  });

  it("compares claimants on the normalized ISIN, not the raw string", () => {
    const result = resolve({
      declaration: { securityId: isin("ie00b03hcz61") },
      portfolio: [
        TARGET,
        { id: "asset_other", name: "MyInvestor Global", securityId: stored(ISIN_A) },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("does not treat the target itself as a rival claimant", () => {
    // Re-declaring the ISIN the holding already has is a no-op, not a duplicate:
    // it must say «ya lo tiene», never «otro holding lo reclama».
    const result = resolve({
      declaration: { securityId: isin(ISIN_A) },
      portfolio: [{ ...TARGET, securityId: stored(ISIN_A) }],
      target: { ...TARGET, securityId: stored(ISIN_A) },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ya");
    expect(result.error).not.toContain("otro holding");
  });

  it("rejects an ISIN that is not a valid ISIN", () => {
    const result = resolve({ declaration: { securityId: isin("IE00B03HCZ62") } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("IE00B03HCZ62");
  });

  it("fills an empty DGS code on a plan, normalizing the way the paper prints it", () => {
    // Un plan de pensiones NO tiene ISIN (#1741): su identificador es el código DGS.
    const result = resolve({
      declaration: { securityId: { kind: "dgs", value: "n-5394" } },
    });

    expect(result).toEqual({
      ok: true,
      patch: { securityId: { kind: "dgs", value: DGS_CODE } },
    });
  });

  it("refuses the pension FUND code with the line the partícipe has to look for", () => {
    // La trampa de #1668: el papel imprime los dos, y el F#### es el del fondo.
    const result = resolve({
      declaration: { securityId: { kind: "dgs", value: "F2244" } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("F2244");
    expect(result.error).toContain("empieza por N");
  });

  it("refuses an ISIN declared where a DGS code was asked for, and the reverse", () => {
    // Una clase no vale por la otra: si valiera, la columna volvería a mentir.
    expect(
      resolve({ declaration: { securityId: { kind: "dgs", value: ISIN_A } } }).ok,
    ).toBe(false);
    expect(
      resolve({ declaration: { securityId: { kind: "isin", value: DGS_CODE } } }).ok,
    ).toBe(false);
  });

  it("refuses a DGS code another holding already claims — two partícipes, one plan", () => {
    const result = resolve({
      declaration: { securityId: { kind: "dgs", value: DGS_CODE } },
      portfolio: [
        TARGET,
        {
          id: "asset_other",
          name: "PP Indexado Global",
          securityId: { kind: "dgs", value: DGS_CODE },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("PP Indexado Global");
    expect(result.error).toContain("código DGS");
  });

  it("treats a preserved import as an identifier the holding already has", () => {
    // `kind: null` solo nace del restore de documento (#1416) y aun así ocupa el
    // hueco: si el chat pudiera escribir encima, el restore sería el sitio por el
    // que colar la sobreescritura que este módulo existe para negar.
    const result = resolve({
      declaration: { securityId: isin(ISIN_B) },
      target: { ...TARGET, securityId: { kind: null, value: ISIN_A } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(ISIN_A);
    expect(result.error).toContain("ficha");
  });

  it("rejects a declaration that changes nothing", () => {
    const result = resolve({ declaration: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no cambia nada");
  });

  it("treats blank strings as nothing declared", () => {
    const result = resolve({
      declaration: { providerSymbol: "", securityId: isin("   ") },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no cambia nada");
  });
});
