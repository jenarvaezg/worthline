import { describe, expect, test } from "vitest";
import {
  priceSymbolProvenance,
  securityIdFieldCopy,
  securityIdFieldState,
} from "./security-id-field-view";

describe("securityIdFieldCopy — the field asks the instrument's own question", () => {
  test("the plan's field names the DGS code and the trap of the paper", () => {
    const copy = securityIdFieldCopy("dgs");

    expect(copy.altaLabel).toBe("Código DGS del plan");
    expect(copy.placeholder).toBe("N5394");
    // The fondo's code is printed next to the plan's; a partícipe types it once.
    expect(copy.help).toContain("F####");
  });

  test("the ISIN's field keeps saying what an ISIN is for", () => {
    expect(securityIdFieldCopy("isin").altaLabel).toBe("ISIN");
    expect(securityIdFieldCopy("isin").help).toContain("un extracto de tu bróker");
  });
});

describe("securityIdFieldState — a stored value of another kind is never offered as this one", () => {
  test("a matching kind fills the field", () => {
    expect(
      securityIdFieldState({
        kind: "dgs",
        stored: { kind: "dgs", value: "N5394" },
        typed: undefined,
      }),
    ).toEqual({ value: "N5394" });
  });

  test("a plan carrying an ISIN shows an empty box and says what is stored", () => {
    const state = securityIdFieldState({
      kind: "dgs",
      stored: { kind: "isin", value: "IE00B52MJY50" },
      typed: undefined,
    });

    expect(state.value).toBe("");
    expect(state.mismatch).toContain("IE00B52MJY50");
    expect(state.mismatch).toContain("código DGS");
  });

  test("an identifier no classifier could name says so too (#1743)", () => {
    const state = securityIdFieldState({
      kind: "isin",
      stored: { kind: null, value: "LU-1234" },
      typed: undefined,
    });

    expect(state.mismatch).toContain("LU-1234");
  });

  test("what a rejected save brought back wins over what is stored", () => {
    expect(
      securityIdFieldState({
        kind: "dgs",
        stored: { kind: "dgs", value: "N5394" },
        typed: "n-5396",
      }),
    ).toEqual({ value: "n-5396" });
  });

  test("nothing stored is an empty box with nothing to explain", () => {
    expect(
      securityIdFieldState({ kind: "isin", stored: undefined, typed: undefined }),
    ).toEqual({ value: "" });
  });
});

describe("priceSymbolProvenance — dos campos donde antes había uno", () => {
  test("el símbolo del plan dice de dónde salió: del código, en el alta", () => {
    const line = priceSymbolProvenance({ kind: "dgs", providerLabel: "Finect" });

    expect(line).toContain("Finect");
    expect(line).toContain("sembrado del código DGS en el alta");
    // Y lo que NO es: identidad. Es la frontera del ADR 0011.
    expect(line).toContain("no lo identifica");
  });

  test("en lo demás, el símbolo cotiza y el ISIN identifica", () => {
    const line = priceSymbolProvenance({ kind: "isin", providerLabel: "Yahoo Finance" });

    expect(line).toContain("Yahoo Finance");
    expect(line).toContain("ISIN");
  });
});
