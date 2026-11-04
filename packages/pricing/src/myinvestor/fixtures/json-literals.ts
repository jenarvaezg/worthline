/**
 * JSON with its number literals kept as text. `JSON.parse` would turn `318.4270` into a
 * double and lose digits that the fixtures must keep exact, so numbers come out of the
 * parse as `NumberLiteral` (through the reviver's source-text access) and go back into
 * the text verbatim (through `JSON.rawJSON`).
 */

export class NumberLiteral {
  constructor(readonly source: string) {}
}

export type LiteralJson =
  | null
  | boolean
  | string
  | NumberLiteral
  | LiteralJson[]
  | { [key: string]: LiteralJson };

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;
type RawJsonApi = { rawJSON(text: string): unknown };

export function parseWithLiterals(text: string): LiteralJson {
  const reviver: Reviver = (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (context?.source === undefined) {
      throw new Error("Este runtime no da el texto de los números de JSON.parse");
    }
    return new NumberLiteral(context.source);
  };
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]) as LiteralJson;
}

/** Pretty-printed with two spaces, the same layout Biome keeps for these files. */
export function stringifyWithLiterals(value: LiteralJson): string {
  const { rawJSON } = JSON as unknown as RawJsonApi;
  return `${JSON.stringify(
    value,
    (_key, inner: unknown) =>
      inner instanceof NumberLiteral ? rawJSON(inner.source) : inner,
    2,
  )}\n`;
}

export function isPlainObject(
  value: LiteralJson,
): value is { [key: string]: LiteralJson } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof NumberLiteral)
  );
}
