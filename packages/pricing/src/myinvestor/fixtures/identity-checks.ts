/**
 * Validators for the two identifiers that must never reach a committed MyInvestor
 * fixture (#1887): an IBAN and a Spanish DNI/NIE (including the K/L/M NIFs of minors and
 * non-residents). They check the control digits, not just the shape: the anonymizer's
 * fakes keep the shape on purpose and always break the control digits, so a fixture with
 * a VALID one can only be a real identifier that slipped through.
 */

const CONTROL_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const NIE_PREFIX: Record<string, string> = { X: "0", Y: "1", Z: "2" };

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const DNI_SHAPE = /^(\d{8})([A-Z])$/;
const NIE_SHAPE = /^([XYZ])(\d{7})([A-Z])$/;
const KLM_SHAPE = /^[KLM](\d{7})([A-Z])$/;

const IBAN_CANDIDATES = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const SPANISH_ID_CANDIDATES = /\b(?:\d{8}|[XYZKLM]\d{7})[A-Z]\b/g;

/** ISO 13616 mod-97 over the rearranged IBAN, digit by digit to stay within a number. */
function mod97(rearranged: string): number {
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

export function isValidIban(candidate: string): boolean {
  if (!IBAN_SHAPE.test(candidate)) return false;
  return mod97(`${candidate.slice(4)}${candidate.slice(0, 4)}`) === 1;
}

/** The two check digits that make `country + digits + bban` a valid IBAN. */
export function ibanCheckDigits(country: string, bban: string): string {
  const check = 98 - mod97(`${bban}${country}00`);
  return String(check).padStart(2, "0");
}

/** The control letter of a DNI number (or of a NIE/K/L/M once its prefix is resolved). */
export function spanishIdControlLetter(number: number): string {
  return CONTROL_LETTERS.charAt(number % 23);
}

export function isValidSpanishId(candidate: string): boolean {
  const dni = DNI_SHAPE.exec(candidate);
  if (dni) return spanishIdControlLetter(Number(dni[1])) === dni[2];
  const nie = NIE_SHAPE.exec(candidate);
  if (nie) {
    const [, prefix = "", digits = "", letter] = nie;
    return spanishIdControlLetter(Number(`${NIE_PREFIX[prefix]}${digits}`)) === letter;
  }
  const klm = KLM_SHAPE.exec(candidate);
  if (klm) return spanishIdControlLetter(Number(klm[1])) === klm[2];
  return false;
}

export interface IdentityHit {
  readonly kind: "iban" | "spanish-id";
  readonly value: string;
}

/** Every VALID IBAN and Spanish id found anywhere in `text`, in order of appearance. */
export function findValidIdentities(text: string): IdentityHit[] {
  const hits: { index: number; hit: IdentityHit }[] = [];
  for (const match of text.matchAll(IBAN_CANDIDATES)) {
    if (isValidIban(match[0])) {
      hits.push({ index: match.index, hit: { kind: "iban", value: match[0] } });
    }
  }
  for (const match of text.matchAll(SPANISH_ID_CANDIDATES)) {
    if (isValidSpanishId(match[0])) {
      hits.push({ index: match.index, hit: { kind: "spanish-id", value: match[0] } });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map(({ hit }) => hit);
}
