/**
 * The leak check between the raw captures and the fixtures (#1887, P9 of #1869): the
 * automatic guarantee that replaces a human review. It runs locally, where the raw
 * captures are, before every commit of the fixtures.
 *
 * From the raw side it collects what must not reach git:
 * - identifiers: every string shaped like an id, an IBAN, a uuid, a DNI/NIE, an email or
 *   a phone, wherever it is, plus the ids in the raw file names;
 * - names: each word (3+ letters) of a person's name;
 * - personal texts: aliases, free texts and personal dates;
 * - amounts: every non-zero number under an amount key, an id key or a key the field
 *   table does not know;
 * - share counts: every non-integer number under a quantity key (a whole number of
 *   shares, like 3, identifies nobody and would match any other small count).
 *
 * An identifier only matches as a whole token: a real account id hidden among the
 * decimals of an invented figure is a coincidence, not a leak.
 *
 * Then it looks for them in every fixture (and its file name). A personal text or a name
 * word that the API also publishes in a public field (a roboadvisor portfolio named like
 * the alias of its cash account) is not a leak: it is in the catalog for everyone.
 */
import { canonicalDecimal } from "./decimal";
import { type FieldRule, MAP_CONTAINERS, ruleFor } from "./field-policy";
import type { FigurePair } from "./figure-map";
import { foldText } from "./fold";
import {
  isPlainObject,
  JsonNumber,
  type LiteralJson,
  parseWithLiterals,
} from "./json-literals";

export interface CaptureSecrets {
  readonly identifiers: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
  readonly texts: ReadonlySet<string>;
  readonly amounts: ReadonlySet<string>;
  readonly quantities: ReadonlySet<string>;
  /** Every non-zero real figure that is not public, for the scan of text files. */
  readonly figures: ReadonlySet<string>;
}

export interface Leak {
  readonly file: string;
  readonly kind: "identifier" | "name" | "personal-text" | "amount" | "quantity";
  readonly value: string;
}

const IDENTIFIER_SHAPES = [
  /^\d{5,}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/,
  /^(?:\d{8}|[XYZKLM]\d{7})[A-Z]$/,
  /^[^\s@]+@[^\s@]+$/,
  /^\+?\d[\d ]{7,}$/,
];

type Visit = (rule: FieldRule | undefined, value: string | JsonNumber) => void;

/** Calls `visit` for every leaf, with the rule of the key that holds it. */
function visitLeaves(json: LiteralJson, visit: Visit) {
  const walk = (value: LiteralJson, rule: FieldRule | undefined, mapKeys?: RegExp) => {
    if (value === null || typeof value === "boolean") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, rule);
      return;
    }
    if (!isPlainObject(value)) {
      visit(rule, value);
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      if (mapKeys) walk(inner, "public");
      else walk(inner, ruleFor(key, value), MAP_CONTAINERS[key]);
    }
  };
  walk(json, "public");
}

const nameWords = (text: string) =>
  foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);

const containsWord = (haystack: string, word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "u").test(haystack);

export function collectSecrets(
  raw: readonly { readonly name: string; readonly text: string }[],
): CaptureSecrets {
  const identifiers = new Set<string>();
  const names = new Set<string>();
  const texts = new Set<string>();
  const amounts = new Set<string>();
  const quantities = new Set<string>();
  const figures = new Set<string>();
  const publicTexts: string[] = [];

  for (const capture of raw) {
    for (const id of capture.name.match(/\d{5,}/g) ?? []) identifiers.add(id);
    visitLeaves(parseWithLiterals(capture.text), (rule, value) => {
      if (value instanceof JsonNumber) {
        if (rule === "public") return;
        const canonical = canonicalDecimal(value.source);
        if (rule === "id") identifiers.add(value.source);
        if (canonical === "0") return;
        figures.add(canonical);
        if (rule !== "quantity") amounts.add(canonical);
        else if (canonical.includes(".")) quantities.add(canonical);
        return;
      }
      // The positions of a securities account carry `"accountId": "null"`, as text.
      if (value === "null") return;
      if (IDENTIFIER_SHAPES.some((shape) => shape.test(value))) {
        identifiers.add(value);
      } else if (rule === "public") {
        publicTexts.push(foldText(value));
      } else if (rule === "person-name") {
        for (const word of nameWords(value)) names.add(word);
      } else if (value.trim().length >= 4) {
        texts.add(foldText(value));
      }
    });
  }

  const published = (text: string) => publicTexts.some((known) => known.includes(text));
  const publishedWord = (word: string) =>
    publicTexts.some((known) => containsWord(known, word));
  return {
    identifiers,
    names: new Set([...names].filter((word) => !publishedWord(word))),
    texts: new Set([...texts].filter((text) => !published(text))),
    amounts,
    quantities,
    figures,
  };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The identifier as a whole token: not glued to digits, nor among a number's decimals. */
const tokenOf = (id: string) => new RegExp(`(?<![\\d.])${escape(id)}(?!\\.?\\d)`, "i");

/**
 * Every non-zero real amount of a raw response next to the figure the fixture has at the
 * same place, for the check that no common factor links them (`hasCommonFactor`).
 */
export function pairedAmounts(rawText: string, fixtureText: string): FigurePair[] {
  const pairs: FigurePair[] = [];
  const walk = (
    raw: LiteralJson,
    fake: LiteralJson | undefined,
    rule: FieldRule | undefined,
  ) => {
    if (Array.isArray(raw)) {
      raw.forEach((item, i) =>
        walk(item, Array.isArray(fake) ? fake[i] : undefined, rule),
      );
      return;
    }
    if (raw instanceof JsonNumber) {
      if (rule !== "amount" || !(fake instanceof JsonNumber)) return;
      const real = canonicalDecimal(raw.source);
      if (real !== "0") pairs.push({ real, fake: canonicalDecimal(fake.source) });
      return;
    }
    if (!isPlainObject(raw)) return;
    const other = fake !== undefined && isPlainObject(fake) ? fake : undefined;
    for (const [key, inner] of Object.entries(raw)) {
      walk(inner, other?.[key], MAP_CONTAINERS[key] ? "public" : ruleFor(key, raw));
    }
  };
  walk(parseWithLiterals(rawText), parseWithLiterals(fixtureText), "public");
  return pairs;
}

export function findLeaks(
  secrets: CaptureSecrets,
  fixtures: readonly { readonly file: string; readonly text: string }[],
): Leak[] {
  const leaks = new Map<string, Leak>();
  const add = (leak: Leak) =>
    leaks.set(`${leak.file}\u0000${leak.kind}\u0000${leak.value}`, leak);

  for (const { file, text } of fixtures) {
    const whole = `${file}\n${text}`;
    const folded = foldText(whole);
    for (const id of secrets.identifiers) {
      if (tokenOf(id).test(whole)) add({ file, kind: "identifier", value: id });
    }
    for (const word of secrets.names) {
      if (containsWord(folded, word)) add({ file, kind: "name", value: word });
    }
    for (const personal of secrets.texts) {
      if (folded.includes(personal))
        add({ file, kind: "personal-text", value: personal });
    }
    visitLeaves(parseWithLiterals(text), (rule, value) => {
      if (!(value instanceof JsonNumber) || rule === "public") return;
      const canonical = canonicalDecimal(value.source);
      if (rule !== "quantity" && secrets.amounts.has(canonical)) {
        add({ file, kind: "amount", value: canonical });
      }
      if (
        (rule === "quantity" || rule === undefined) &&
        secrets.quantities.has(canonical)
      ) {
        add({ file, kind: "quantity", value: canonical });
      }
    });
  }
  return [...leaks.values()];
}

/**
 * A number written in text: not part of a word, a version or a longer number. A number
 * right after a slash is a product version (`Mozilla/5.0`, `Chrome/156.0`), not a figure.
 */
const NUMBER_TOKEN = /(?<![\w./])-?\d+(?:\.\d+)?(?![\w]|\.\d)/g;
/** Whole numbers code needs whatever the capture says: the base of a percentage. */
const STRUCTURAL = new Set(["100"]);

/**
 * The leak check over every other file the work adds or changes (code, tests, comments, docs,
 * the skill, commit messages): no real identifier, name, personal text or figure. A
 * figure counts when it is written with decimals, or whole with three digits or more
 * (a number of one or two digits matches too much to mean anything).
 */
export function findTextLeaks(
  secrets: CaptureSecrets,
  files: readonly { readonly file: string; readonly text: string }[],
): Leak[] {
  const leaks = new Map<string, Leak>();
  const add = (leak: Leak) =>
    leaks.set(`${leak.file}\u0000${leak.kind}\u0000${leak.value}`, leak);
  for (const { file, text } of files) {
    const folded = foldText(text);
    for (const id of secrets.identifiers) {
      if (tokenOf(id).test(text)) add({ file, kind: "identifier", value: id });
    }
    for (const word of secrets.names) {
      if (containsWord(folded, word)) add({ file, kind: "name", value: word });
    }
    for (const personal of secrets.texts) {
      if (folded.includes(personal))
        add({ file, kind: "personal-text", value: personal });
    }
    for (const [token] of text.matchAll(NUMBER_TOKEN)) {
      const value = canonicalDecimal(token);
      const whole = !token.includes(".");
      if (whole && (value.replace("-", "").length < 3 || STRUCTURAL.has(value))) continue;
      if (secrets.figures.has(value)) add({ file, kind: "amount", value });
    }
  }
  return [...leaks.values()];
}
