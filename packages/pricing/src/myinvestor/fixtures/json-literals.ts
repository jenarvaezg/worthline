/**
 * JSON with its number literals kept as text, for the fixture tooling. `JSON.parse` would
 * turn `318.4270` into a double and lose digits that the fixtures must keep exact, so the
 * parse keeps every number as the client's own {@link JsonNumber} (one reviver for both,
 * `myinvestor/json.ts`), and the numbers go back into the text verbatim (through
 * `JSON.rawJSON`).
 */
import { JsonNumber, keepJsonNumbers } from "@pricing/myinvestor/json";

export { JsonNumber };

export type LiteralJson =
  | null
  | boolean
  | string
  | JsonNumber
  | LiteralJson[]
  | { [key: string]: LiteralJson };

type RawJsonApi = { rawJSON(text: string): unknown };

export function parseWithLiterals(text: string): LiteralJson {
  return JSON.parse(text, keepJsonNumbers) as LiteralJson;
}

/** Pretty-printed with two spaces, the same layout Biome keeps for these files. */
export function stringifyWithLiterals(value: LiteralJson): string {
  const { rawJSON } = JSON as unknown as RawJsonApi;
  return `${JSON.stringify(
    value,
    (_key, inner: unknown) =>
      inner instanceof JsonNumber ? rawJSON(inner.source) : inner,
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
    !(value instanceof JsonNumber)
  );
}
