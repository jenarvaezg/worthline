import { describe, expect, it } from "vitest";

import { isValidIban, isValidSpanishId } from "./identity-checks";
import { createPseudonymizer } from "./pseudonymizer";
import {
  TEXTBOOK_DNI,
  TEXTBOOK_IBAN,
  TEXTBOOK_KLM,
  TEXTBOOK_NIE,
} from "./textbook-identities";

const SECRET = "test-secret-not-the-real-one";

describe("createPseudonymizer", () => {
  it("is stable: the same real value always gives the same fake, across instances", () => {
    const first = createPseudonymizer(SECRET);
    const second = createPseudonymizer(SECRET);
    expect(first.digits("1000001")).toBe(second.digits("1000001"));
    expect(first.iban(TEXTBOOK_IBAN)).toBe(second.iban(TEXTBOOK_IBAN));
    expect(first.personName("LUCIA MARTA")).toBe(second.personName("LUCIA MARTA"));
  });

  it("depends on the secret", () => {
    const other = createPseudonymizer("another-secret");
    expect(createPseudonymizer(SECRET).digits("123456789")).not.toBe(
      other.digits("123456789"),
    );
  });

  it("keeps the length of a numeric id, never its value, never a leading zero", () => {
    const pseudonyms = createPseudonymizer(SECRET);
    for (const real of ["10001", "2000002", "30000000003", "15440000000000000000"]) {
      const fake = pseudonyms.digits(real);
      expect(fake).toMatch(/^[1-9]\d*$/);
      expect(fake).toHaveLength(real.length);
      expect(fake).not.toBe(real);
    }
  });

  it("never gives two real ids the same fake", () => {
    const pseudonyms = createPseudonymizer(SECRET);
    const fakes = new Set<string>();
    for (let i = 0; i < 2000; i++) fakes.add(pseudonyms.digits(String(10000 + i)));
    expect(fakes.size).toBe(2000);
  });

  it("keeps the date prefix of an order reference and fakes the rest", () => {
    const fake = createPseudonymizer(SECRET).reference("202401150001234");
    expect(fake).toMatch(/^20240115\d{7}$/);
    expect(fake).not.toBe("202401150001234");
  });

  it("gives an IBAN-shaped fake whose check digits never verify", () => {
    const pseudonyms = createPseudonymizer(SECRET);
    for (let i = 0; i < 200; i++) {
      const fake = pseudonyms.iban(`ES91210004184502${String(i).padStart(8, "0")}`);
      expect(fake).toMatch(/^ES\d{22}$/);
      expect(isValidIban(fake)).toBe(false);
    }
  });

  it("keeps the kind of a Spanish id and always breaks its control letter", () => {
    const pseudonyms = createPseudonymizer(SECRET);
    const dni = pseudonyms.document(TEXTBOOK_DNI);
    const nie = pseudonyms.document(TEXTBOOK_NIE);
    const junior = pseudonyms.document(TEXTBOOK_KLM);
    expect(dni).toMatch(/^\d{8}[A-Z]$/);
    expect(nie).toMatch(/^X\d{7}[A-Z]$/);
    expect(junior).toMatch(/^K\d{7}[A-Z]$/);
    for (const fake of [dni, nie, junior]) expect(isValidSpanishId(fake)).toBe(false);
  });

  it("refuses a document it does not know how to fake", () => {
    expect(() => createPseudonymizer(SECRET).document("AB-123")).toThrow(/documento/);
  });

  it("gives a uuid-shaped fake", () => {
    const fake = createPseudonymizer(SECRET).uuid("00000000-0000-4000-8000-000000000001");
    expect(fake).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("keeps the case style of a name and shares no word with the real one", () => {
    const pseudonyms = createPseudonymizer(SECRET);
    const upper = pseudonyms.personName("LUCIA MARTA");
    expect(upper).toBe(upper.toUpperCase());
    expect(upper.split(" ")).not.toContain("LUCIA");
    const title = pseudonyms.personName("Pedro");
    expect(title).toMatch(/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/);
  });

  it("fakes emails, phones, aliases and personal dates", () => {
    const pseudonyms = createPseudonymizer(SECRET);
    expect(pseudonyms.email("someone@example.org")).toMatch(/^[a-z0-9.]+@example\.com$/);
    expect(pseudonyms.phone("600000000")).toMatch(/^6\d{8}$/);
    expect(pseudonyms.alias("Cuenta de prueba")).toMatch(/^Cuenta /);
    expect(pseudonyms.personalDate("1990-01-01")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pseudonyms.personalDate("1990-01-01")).not.toBe("1990-01-01");
  });
});
