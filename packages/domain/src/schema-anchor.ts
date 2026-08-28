/**
 * Anchoring a zod schema to a type the domain already owns (#1602).
 *
 * A schema that reproduces a domain type is a second declaration of that type,
 * and second declarations drift. These two helpers make the drift a COMPILE
 * ERROR at the schema instead of a document the app silently mishandles — which
 * is what the workspace export/import contract had been doing: rejecting a
 * `housing` rung, the `coingecko` provider and the `binance` price source, and
 * dropping four FIRE declarations on every round-trip.
 *
 * They are pure type machinery: `reproduces` is the identity at runtime and
 * `vocabularyOf` only builds the `z.enum`. Neither validates anything the schema
 * does not already validate itself.
 */

import { z } from "zod";

/** The keys of `T` that may be absent. */
type OptionalKeyOf<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * `T` with `undefined` admitted on its optional properties — the shape zod
 * produces for a `.optional()` field, which `exactOptionalPropertyTypes`
 * otherwise refuses to match against a domain interface's `field?: X`. This is
 * the ONLY gap between a schema's output and the domain type it reproduces.
 */
type ZodOptionality<T> = T extends unknown
  ? Omit<T, OptionalKeyOf<T>> & { [K in OptionalKeyOf<T>]?: T[K] | undefined }
  : never;

/** The keys of `T` that the schema `S` does not declare at all. */
type UndeclaredKeyOf<T, S extends z.ZodType> = Exclude<keyof T, keyof z.output<S>>;

/**
 * Declares that `schema` reproduces the domain type `T`, and hands back a schema
 * whose output IS `T`.
 *
 * Two constraints do the work, and they catch different mistakes:
 *
 * - the output must SATISFY `T`, so a field whose type the schema got wrong fails
 *   to compile;
 * - every key of `T` must be DECLARED, so a field the schema simply forgot fails
 *   too — **including an optional one**. That second check is the one that matters:
 *   satisfaction alone is blind to a forgotten optional field, and the four FIRE
 *   declarations #1602 found being dropped (#1428, #1460) were all optional.
 *
 * Declared-but-narrower stays allowed on purpose, because a document may
 * NORMALIZE: an operation's `source` carries `.default("manual")`, so its output
 * is tighter than the domain's optional field rather than equal to it.
 *
 * What this does NOT promise, so nobody reads more into it than it says:
 *
 * - nothing about RUNTIME. A schema may be typed `CurrencyCode` while validating
 *   only `z.string().min(1)`; the type says what travels, not what is checked.
 * - nothing about EXTRA fields. A schema may declare a key the domain type no
 *   longer has, and the dead field goes on travelling until someone notices.
 *
 * Narrowing the output past {@link ZodOptionality} is the one assertion here, and
 * it is confined to that single gap. It also erases `S`, so `.shape` / `.extend`
 * are gone from the result — anchor at the leaf and compose with the anchored
 * schema, as the export contract does.
 */
export const reproduces =
  <T>() =>
  <S extends z.ZodType<ZodOptionality<T>>>(
    schema: [UndeclaredKeyOf<T, S>] extends [never] ? S : never,
  ): z.ZodType<T, unknown> =>
    schema as unknown as z.ZodType<T, unknown>;

/**
 * A vocabulary that must match a domain union EXACTLY: the values must cover it
 * (nothing missing) and stay inside it (no stranger). Both directions matter — a
 * missing member makes every document that uses it unimportable, which is how
 * `housing`, `coingecko` and `binance` came to be refused before #1602.
 *
 * Where a domain module already exports its vocabulary as a `const` tuple
 * (`LIQUIDITY_LADDER`, `INVESTMENT_PRICE_PROVIDERS`), prefer `z.enum(THAT)`: one
 * list beats two lists that are checked against each other. This helper is for
 * the unions that have no such tuple, and it buys the same exactness without
 * asking fourteen domain modules to grow one for the sake of a schema.
 */
export const vocabularyOf =
  <T extends string>() =>
  <const V extends readonly T[]>(values: [T] extends [V[number]] ? V : never) =>
    z.enum(values as unknown as readonly [T, ...T[]]);
