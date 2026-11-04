import { describe, expect, it } from "vitest";

import {
  findValidIdentities,
  ibanCheckDigits,
  isValidIban,
  isValidSpanishId,
  spanishIdControlLetter,
} from "./identity-checks";
import {
  TEXTBOOK_DNI,
  TEXTBOOK_IBAN,
  TEXTBOOK_KLM,
  TEXTBOOK_NIE,
} from "./textbook-identities";

describe("isValidIban", () => {
  it("accepts an IBAN whose check digits verify", () => {
    expect(isValidIban(TEXTBOOK_IBAN)).toBe(true);
  });

  it("rejects the same IBAN with any other check digits", () => {
    expect(isValidIban("ES9221000418450200051332")).toBe(false);
  });

  it("rejects what is not shaped like an IBAN", () => {
    expect(isValidIban("IE00BYX5NX33")).toBe(false);
    expect(isValidIban("not an iban")).toBe(false);
  });
});

describe("ibanCheckDigits", () => {
  it("computes the two digits that make an IBAN valid", () => {
    expect(ibanCheckDigits("ES", "21000418450200051332")).toBe("91");
  });
});

describe("isValidSpanishId", () => {
  it("accepts a DNI, a NIE and a K/L/M NIF with their control letter", () => {
    expect(isValidSpanishId(TEXTBOOK_DNI)).toBe(true);
    expect(isValidSpanishId(TEXTBOOK_NIE)).toBe(true);
    expect(isValidSpanishId(TEXTBOOK_KLM)).toBe(true);
  });

  it("rejects them with a wrong letter", () => {
    expect(isValidSpanishId("12345678A")).toBe(false);
    expect(isValidSpanishId("X1234567A")).toBe(false);
    expect(isValidSpanishId("K1234567A")).toBe(false);
  });

  it("rejects other shapes", () => {
    expect(isValidSpanishId("1234567Z")).toBe(false);
    expect(isValidSpanishId("N5394")).toBe(false);
  });
});

describe("spanishIdControlLetter", () => {
  it("is the letter of the number modulo 23", () => {
    expect(spanishIdControlLetter(12345678)).toBe("Z");
    expect(spanishIdControlLetter(0)).toBe("T");
  });
});

describe("findValidIdentities", () => {
  it("finds every valid IBAN and Spanish id inside a text", () => {
    const text = JSON.stringify({
      iban: TEXTBOOK_IBAN,
      holders: [{ documentNumber: TEXTBOOK_DNI }, { documentNumber: TEXTBOOK_NIE }],
      note: `junior ${TEXTBOOK_KLM}`,
    });
    expect(findValidIdentities(text)).toEqual([
      { kind: "iban", value: TEXTBOOK_IBAN },
      { kind: "spanish-id", value: TEXTBOOK_DNI },
      { kind: "spanish-id", value: TEXTBOOK_NIE },
      { kind: "spanish-id", value: TEXTBOOK_KLM },
    ]);
  });

  it("ignores lookalikes whose control digits do not verify", () => {
    const text = JSON.stringify({
      iban: "ES9221000418450200051332",
      document: "12345678A",
      isin: "IE00BYX5NX33",
      dgsCode: "N5394",
    });
    expect(findValidIdentities(text)).toEqual([]);
  });
});
