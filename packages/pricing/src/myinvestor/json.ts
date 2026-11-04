/**
 * MyInvestor sends amounts and shares as JSON numbers (`162.53`, `3.911`).
 * `JSON.parse` would turn them into doubles, so every number is kept as the
 * literal the API wrote (through the reviver's source-text access) and only the
 * schemas of `models.ts` turn it into a `DecimalString` or an id. The fixture
 * tooling parses with the same reviver (`fixtures/json-literals.ts`).
 */

/** A JSON number exactly as it was written. */
export class JsonNumber {
  constructor(readonly source: string) {}
}

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

const reviver: Reviver = (_key, value, context) => {
  if (typeof value !== "number") return value;
  if (context?.source === undefined) {
    throw new Error("Este runtime no da el texto de los números de JSON.parse");
  }
  return new JsonNumber(context.source);
};

/** The `JSON.parse` reviver that keeps every number as a {@link JsonNumber}. */
export const keepJsonNumbers = reviver as Parameters<typeof JSON.parse>[1];

/** The body parsed with its numbers as {@link JsonNumber}; `undefined` when empty. */
export function parseMyInvestorJson(text: string): unknown {
  if (!text.trim()) return undefined;
  return JSON.parse(text, keepJsonNumbers);
}
