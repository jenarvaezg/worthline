/**
 * Stable fakes for the identifiers of a MyInvestor capture (#1887, P9 of #1869).
 *
 * Every fake is an HMAC of the real value under a secret that never enters git, so:
 * - the same real value always gives the same fake, in every file and on every
 *   regeneration (the fixtures diff cleanly when the API changes);
 * - without the secret nobody can go from the fake back to the real value.
 *
 * Fakes keep the SHAPE of the real value (length of an id, kind of document, case of a
 * name) so the connector's parsing is exercised as with real data, and always BREAK the
 * control digits of an IBAN or a DNI/NIE, so the repo's pattern guard can tell a fake
 * from a leak.
 */
import { createHmac } from "node:crypto";

import { foldText as fold } from "./fold";
import { ibanCheckDigits, spanishIdControlLetter } from "./identity-checks";

export interface Pseudonymizer {
  /** A numeric id (account, contribution…): same length, no leading zero. */
  digits(real: string): string;
  /** An order reference `AAAAMMDD` + sequence: keeps the date, fakes the sequence. */
  reference(real: string): string;
  /** An IBAN of the same country and length whose check digits never verify. */
  iban(real: string): string;
  uuid(real: string): string;
  /** A DNI, NIE or K/L/M NIF of the same kind with a wrong control letter. */
  document(real: string): string;
  /** A person's name, word by word, keeping the case style. */
  personName(real: string): string;
  /** A user-chosen account alias. */
  alias(real: string): string;
  /** Any other free text the user may have typed. */
  freeText(real: string): string;
  email(real: string): string;
  phone(real: string): string;
  /** A date that describes the person (birth, document expiry), not an operation. */
  personalDate(real: string): string;
}

const NAME_POOL = [
  "Lucía",
  "Marta",
  "Pablo",
  "Irene",
  "Sergio",
  "Nerea",
  "Hugo",
  "Alba",
  "Diego",
  "Elena",
  "Iván",
  "Clara",
  "Mario",
  "Sara",
  "Bruno",
  "Noelia",
  "Ferrer",
  "Molina",
  "Ortega",
  "Pascual",
  "Rubio",
  "Soler",
  "Vidal",
  "Campos",
  "Crespo",
  "Lozano",
  "Marín",
  "Nieto",
  "Prieto",
  "Rojas",
  "Iglesias",
  "Benítez",
] as const;

const ALIAS_POOL = [
  "Ahorro",
  "Diaria",
  "Viajes",
  "Colchón",
  "Hogar",
  "Proyectos",
  "Reserva",
  "Gastos",
  "Nómina",
  "Imprevistos",
] as const;

const DOCUMENT_SHAPES: readonly { shape: RegExp; prefix: (real: string) => string }[] = [
  { shape: /^\d{8}[A-Z]$/, prefix: () => "" },
  { shape: /^[XYZKLM]\d{7}[A-Z]$/, prefix: (real) => real.charAt(0) },
];
const NIE_PREFIX: Record<string, string> = { X: "0", Y: "1", Z: "2" };

function digitsFrom(bytes: Buffer, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    out += String((bytes[i % bytes.length] ?? 0) + Math.floor(i / bytes.length)).slice(
      -1,
    );
  }
  return out;
}

export function createPseudonymizer(secret: string): Pseudonymizer {
  const hash = (kind: string, real: string, attempt: number) =>
    createHmac("sha256", secret).update(`${kind}\u0000${real}\u0000${attempt}`).digest();

  const byReal = new Map<string, string>();
  const byFake = new Map<string, string>();

  /**
   * The memoized fake of `real` for `kind`, retried with a new attempt number until it
   * differs from the real value and no other real value of the same kind already has it.
   */
  function unique(
    kind: string,
    real: string,
    make: (bytes: Buffer, attempt: number) => string,
  ) {
    const key = `${kind}\u0000${real}`;
    const known = byReal.get(key);
    if (known !== undefined) return known;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const fake = make(hash(kind, real, attempt), attempt);
      const owner = byFake.get(`${kind}\u0000${fake}`);
      if (fake === real || (owner !== undefined && owner !== real)) continue;
      byReal.set(key, fake);
      byFake.set(`${kind}\u0000${fake}`, real);
      return fake;
    }
    throw new Error(`No se encuentra un falso libre para un valor de tipo ${kind}`);
  }

  const numeric = (bytes: Buffer, length: number) => {
    const first = String(((bytes[0] ?? 0) % 9) + 1);
    return `${first}${digitsFrom(bytes.subarray(1), length - 1)}`;
  };

  const pickName = (bytes: Buffer, avoid: string) => {
    for (let i = 0; i < bytes.length; i++) {
      const word = NAME_POOL[(bytes[i] ?? 0) % NAME_POOL.length] ?? "Lucía";
      if (fold(word) !== fold(avoid)) return word;
    }
    return "Lucía";
  };

  return {
    digits: (real) => unique("digits", real, (bytes) => numeric(bytes, real.length)),

    reference: (real) =>
      unique("reference", real, (bytes) => {
        const prefix = /^\d{15}$/.test(real) ? real.slice(0, 8) : "";
        return `${prefix}${numeric(bytes, real.length - prefix.length)}`;
      }),

    iban: (real) =>
      unique("iban", real, (bytes) => {
        const country = real.slice(0, 2);
        const bban = digitsFrom(bytes, real.length - 4);
        const valid = Number(ibanCheckDigits(country, bban));
        return `${country}${String(valid + 1).padStart(2, "0")}${bban}`;
      }),

    uuid: (real) =>
      unique("uuid", real, (bytes) => {
        const hex = bytes.toString("hex").slice(0, 32).split("");
        hex[12] = "4";
        hex[16] = "89ab".charAt(Number.parseInt(hex[16] ?? "0", 16) % 4);
        const h = hex.join("");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      }),

    document: (real) => {
      const kind = DOCUMENT_SHAPES.find(({ shape }) => shape.test(real));
      if (!kind) throw new Error("Tipo de documento de identidad no reconocido");
      return unique("document", real, (bytes) => {
        const prefix = kind.prefix(real);
        const body = digitsFrom(bytes, real.length - prefix.length - 1);
        const numberText = `${NIE_PREFIX[prefix] ?? ""}${body}`;
        const valid = spanishIdControlLetter(Number(numberText));
        const offset = ((bytes[31] ?? 0) % 22) + 1;
        const letters = "TRWAGMYFPDXBNJZSQVHLCKE";
        const wrong = letters.charAt((letters.indexOf(valid) + offset) % 23);
        return `${prefix}${body}${wrong}`;
      });
    },

    personName: (real) =>
      unique("person-name", real, (bytes) => {
        const upper = real === real.toUpperCase();
        return real
          .split(/\s+/)
          .map((word, i) => {
            const fake = pickName(bytes.subarray(i * 2), word);
            return upper ? fake.toUpperCase() : fake;
          })
          .join(" ");
      }),

    alias: (real) =>
      unique("alias", real, (bytes, attempt) => {
        const word = ALIAS_POOL[(bytes[0] ?? 0) % ALIAS_POOL.length] ?? "Ahorro";
        return attempt < ALIAS_POOL.length
          ? `Cuenta ${word}`
          : `Cuenta ${word} ${attempt}`;
      }),

    freeText: (real) =>
      unique(
        "free-text",
        real,
        (bytes) => `Texto anonimizado ${bytes.toString("hex").slice(0, 6)}`,
      ),

    email: (real) =>
      unique("email", real, (bytes) => `usuario.${digitsFrom(bytes, 6)}@example.com`),

    phone: (real) => unique("phone", real, (bytes) => `6${digitsFrom(bytes, 8)}`),

    personalDate: (real) =>
      unique("personal-date", real, (bytes) => {
        const year = 1970 + ((bytes[0] ?? 0) % 30);
        const month = ((bytes[1] ?? 0) % 12) + 1;
        const day = ((bytes[2] ?? 0) % 28) + 1;
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }),
  };
}
