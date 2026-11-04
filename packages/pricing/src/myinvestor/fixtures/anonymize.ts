/**
 * The first pass of the MyInvestor anonymizer (#1887): one raw response in, one tree with
 * every personal value replaced.
 *
 * - identifiers (IBAN, DNI/NIE, names, account, order, reference and person ids, emails,
 *   phones, aliases) become their stable fakes;
 * - every amount and share count becomes its own invented fake (`figure-map.ts`): no
 *   real figure survives this pass, even one the second pass forgets to recalculate;
 * - ISIN, DGS codes, tickers, operation dates, enums and prices stay as they are.
 *
 * The second pass (`rebuild.ts`) recalculates the orders' shares and every aggregate so
 * the fixture adds up. What each key is lives in `field-policy.ts`; a key that is not
 * there makes this throw.
 */
import { canonicalDecimal } from "./decimal";
import { type FieldRule, MAP_CONTAINERS, ruleFor } from "./field-policy";
import type { FigureMap } from "./figure-map";
import {
  isPlainObject,
  type LiteralJson,
  NumberLiteral,
  parseWithLiterals,
  stringifyWithLiterals,
} from "./json-literals";
import type { Pseudonymizer } from "./pseudonymizer";

export interface AnonymizeOptions {
  readonly pseudonyms: Pseudonymizer;
  readonly figures: FigureMap;
}

type TextRule = Exclude<FieldRule, "public" | "amount" | "quantity" | "id">;

function fakeText(rule: TextRule, value: string, pseudonyms: Pseudonymizer): string {
  switch (rule) {
    case "reference":
      return pseudonyms.reference(value);
    case "iban":
      return pseudonyms.iban(value);
    case "uuid":
      return pseudonyms.uuid(value);
    case "document":
      return pseudonyms.document(value);
    case "person-name":
      return pseudonyms.personName(value);
    case "alias":
      return pseudonyms.alias(value);
    case "free-text":
      return pseudonyms.freeText(value);
    case "email":
      return pseudonyms.email(value);
    case "phone":
      return pseudonyms.phone(value);
    case "personal-date":
      return pseudonyms.personalDate(value);
  }
}

function leaf(
  path: string,
  rule: FieldRule,
  value: LiteralJson,
  { pseudonyms, figures }: AnonymizeOptions,
): LiteralJson {
  // The positions of a securities account carry `"accountId": "null"`, as text.
  if (value === null || value === "null" || rule === "public") return value;
  if (rule === "amount" || rule === "quantity") {
    if (!(value instanceof NumberLiteral))
      throw new Error(`${path}: se esperaba una cifra`);
    if (rule === "amount") return new NumberLiteral(figures.amount(value.source));
    const decimals = canonicalDecimal(value.source).split(".")[1]?.length ?? 0;
    return new NumberLiteral(figures.quantity(value.source, decimals));
  }
  if (rule === "id") {
    if (value instanceof NumberLiteral && /^\d+$/.test(value.source)) {
      return new NumberLiteral(pseudonyms.digits(value.source));
    }
    if (typeof value === "string" && /^\d+$/.test(value)) return pseudonyms.digits(value);
    throw new Error(`${path}: se esperaba un id numérico`);
  }
  if (typeof value !== "string") throw new Error(`${path}: se esperaba texto (${rule})`);
  return fakeText(rule, value, pseudonyms);
}

function walk(
  path: string,
  rule: FieldRule,
  value: LiteralJson,
  options: AnonymizeOptions,
  mapKeys?: RegExp,
): LiteralJson {
  if (Array.isArray(value)) {
    return value.map((item, i) => walk(`${path}[${i}]`, rule, item, options));
  }
  if (!isPlainObject(value)) return leaf(path, rule, value, options);
  if (rule !== "public") throw new Error(`${path}: un objeto donde se esperaba un valor`);

  const out: { [key: string]: LiteralJson } = {};
  for (const [key, inner] of Object.entries(value)) {
    const where = path ? `${path}.${key}` : key;
    if (mapKeys) {
      if (!mapKeys.test(key))
        throw new Error(`${path}: clave de mapa inesperada en ${where}`);
      out[key] = walk(where, "public", inner, options);
      continue;
    }
    const innerRule = ruleFor(key, value);
    if (innerRule === undefined) {
      throw new Error(`Clave sin clasificar en field-policy.ts: ${where}`);
    }
    out[key] = walk(where, innerRule, inner, options, MAP_CONTAINERS[key]);
  }
  return out;
}

/** The anonymized tree of one raw response body, before the rebuild. */
export function anonymizeTree(raw: LiteralJson, options: AnonymizeOptions): LiteralJson {
  return walk("", "public", raw, options);
}

/** The anonymized text of one raw response body, without the rebuild. */
export function anonymizeCapture(text: string, options: AnonymizeOptions): string {
  return stringifyWithLiterals(anonymizeTree(parseWithLiterals(text), options));
}
