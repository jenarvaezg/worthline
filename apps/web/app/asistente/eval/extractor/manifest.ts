import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  extractedPositionSchema,
} from "@web/asistente/attachment-extraction-contract";
import { z } from "zod";

/**
 * The catalog of degradations worth grading — NOT the list of what is graded. Since
 * #1254 those are deliberately different things: the fixture arrays below declare
 * only captures git ships, and a scenario with no fixture is simply uncovered.
 *
 * It was the other way round until then, and that is how the set came to lie. Nine
 * entries pointed at `.local/extractor-golden/`, a directory that existed in no
 * checkout: every full run ended `incomplete` with exit 1, so the rojo was permanent
 * noise instead of signal, the merge gate #1243 wrote («una corrida humana del set
 * completo») could not be run by anybody, and reading the manifest suggested six
 * graded image scenarios where there was one.
 *
 * Uncovered today, awaiting real captures — `mobile`, `reflections`,
 * `misaligned-columns`, `ticker-name-ambiguity`, `thousand-separator`. They are kept
 * here because they are what a real capture buys over a synthetic render (which is,
 * in #1247's words, «more limpio que la vida»), and the README says what each one
 * must show. Add the file first, then the fixture entry.
 */
export const EXTRACTOR_GOLDEN_SCENARIOS = [
  "desktop",
  "mobile",
  "reflections",
  "misaligned-columns",
  "ticker-name-ambiguity",
  "thousand-separator",
  "payment-screen",
] as const;

export type ExtractorGoldenScenario = (typeof EXTRACTOR_GOLDEN_SCENARIOS)[number];

const nonEmptyMessageSchema = z.string().trim().min(1).max(300);

const goldenPositiveExpectedSchema = z
  .object({
    expect: z.literal("positions").optional(),
    positions: z
      .array(extractedPositionSchema)
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    totalEur: z.number().finite().optional(),
    warnings: z.array(nonEmptyMessageSchema).max(20),
    mustBeUncertain: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    warningIncludes: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();

/**
 * A negative case declares the absence of an extraction explicitly (#1247). The
 * shape is deliberately closed and separate from the positive one: relaxing
 * `positions` to optional would let a mistyped positive expected pass as a
 * negative case without anyone noticing.
 */
const goldenNegativeExpectedSchema = z
  .object({ expect: z.literal("unrecognized") })
  .strict();

const goldenExpectedSchema = z.union([
  goldenNegativeExpectedSchema,
  goldenPositiveExpectedSchema,
]);

export type GoldenExpectedPositive = z.infer<typeof goldenPositiveExpectedSchema>;
export type GoldenExpectedNegative = z.infer<typeof goldenNegativeExpectedSchema>;
export type GoldenExpected = GoldenExpectedPositive | GoldenExpectedNegative;

/** True when the fixture expects the extractor to recognize nothing at all. */
export function isNegativeGoldenExpected(
  expected: GoldenExpected,
): expected is GoldenExpectedNegative {
  return expected.expect === "unrecognized";
}

interface GoldenFixtureBase {
  id: string;
  scenario: ExtractorGoldenScenario;
  imageFile: string;
  expectedFile: string;
}

export type GoldenFixture =
  | (GoldenFixtureBase & { storage: "committed" })
  | (GoldenFixtureBase & { storage: "local" });

/**
 * Golden extractor fixtures (#991) — every one of them a file this repo ships.
 *
 * The `local` storage arm stays in the type because private captures are the point
 * of the uncovered scenarios above, and `run.ts` skips a declared fixture whose
 * files are absent. What no longer happens is declaring one BEFORE its capture
 * exists (#1254): an entry with no file on disk turns every full run red and makes
 * the set claim coverage it does not have.
 */
export const EXTRACTOR_GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    expectedFile: "expected/synthetic-baseline.json",
    id: "synthetic-baseline",
    imageFile: "fixtures/synthetic-baseline.png",
    scenario: "desktop",
    storage: "committed",
  },
  // Negative case (#1247): a payment screen is not a portfolio and not a dated balance
  // series either, so it is none of the documents the seam knows how to extract. It stays
  // negative after #1243 — the guarantee under test is "does not hallucinate positions".
  //
  // It stays negative after #1244 too, and for a SHARPER reason worth stating, because
  // that slice added `holding_event` — a payment screen is exactly its shape. This
  // capture is still none of them: the only date it shows belongs to «Próxima cuota»,
  // never to the payment itself, and a `holding_event` needs the fact's OWN day. The
  // honest answer is therefore `unrecognized`, and the way to fail this fixture is now
  // the most dangerous invention the new document can make — borrowing the next
  // instalment's date for the payment. `describeUnexpectedRecognition` names the
  // document that came back, so a red run says which lane invented it.
  {
    expectedFile: "expected/synthetic-payment-screen.json",
    id: "synthetic-payment-screen",
    imageFile: "fixtures/synthetic-payment-screen.png",
    scenario: "payment-screen",
    storage: "committed",
  },
];

export function parseGoldenExpected(input: unknown): GoldenExpected {
  return goldenExpectedSchema.parse(input);
}

// --- Dated balance series golden track (PRD #1048 S4, widened by #1243) ----------

export const BALANCE_SERIES_GOLDEN_SCENARIOS = [
  "debt-statement",
  "amortization-schedule",
  "amortization-schedule-screenshot",
] as const;

export type BalanceSeriesGoldenScenario =
  (typeof BALANCE_SERIES_GOLDEN_SCENARIOS)[number];

const balanceSeriesGoldenExpectedSchema = z
  .object({
    balances: z
      .array(
        z
          .object({
            date: z
              .string()
              .trim()
              .regex(/^\d{4}-\d{2}-\d{2}$/),
            amount: z.number().finite(),
            currency: z
              .string()
              .trim()
              .regex(/^[A-Z]{3}$/),
            uncertain: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    warnings: z.array(nonEmptyMessageSchema).max(20),
    mustBeUncertain: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\d{4}-\d{2}-\d{2}$/),
      )
      .max(20)
      .optional(),
    warningIncludes: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();

export type BalanceSeriesGoldenExpected = z.infer<
  typeof balanceSeriesGoldenExpectedSchema
>;

interface BalanceSeriesGoldenFixtureBase {
  id: string;
  scenario: BalanceSeriesGoldenScenario;
  sourceFile: string;
  expectedFile: string;
}

export type BalanceSeriesGoldenFixture =
  | (BalanceSeriesGoldenFixtureBase & { storage: "committed" })
  | (BalanceSeriesGoldenFixtureBase & { storage: "local" });

/**
 * Balance-series fixtures. Since #1243 the track is no longer PDF-only, because the
 * document is no longer decided by the file kind: the synthetic amortization
 * **screenshot** grades the same `balance_series` document from an image, and it is
 * safe to commit. That crossing is the whole point of the slice, so it belongs in the
 * set git ships — and today it is the only fixture here.
 *
 * The `debt-statement` and `amortization-schedule` PDF scenarios above are uncovered
 * (#1254). Real bank statements and amortization schedules are private by nature and
 * are never committed, so covering them means putting the file under
 * `.local/extractor-golden/` FIRST and declaring the fixture second.
 */
export const BALANCE_SERIES_GOLDEN_FIXTURES: BalanceSeriesGoldenFixture[] = [
  {
    expectedFile: "expected/synthetic-amortization-schedule.json",
    id: "synthetic-amortization-schedule",
    scenario: "amortization-schedule-screenshot",
    sourceFile: "fixtures/synthetic-amortization-schedule.png",
    storage: "committed",
  },
];

export function parseBalanceSeriesGoldenExpected(
  input: unknown,
): BalanceSeriesGoldenExpected {
  return balanceSeriesGoldenExpectedSchema.parse(input);
}

// --- Positions + movements (XLSX/CSV) golden track (PRD #1103 S4) ----------------

export const POSITIONS_MOVEMENTS_GOLDEN_SCENARIOS = [
  "portfolio-snapshot",
  "portfolio-with-movements",
] as const;

export type PositionsMovementsGoldenScenario =
  (typeof POSITIONS_MOVEMENTS_GOLDEN_SCENARIOS)[number];

const HOLDING_FIDELITY = z.enum(["movements", "declared_cost", "value_only"]);

const positionsMovementsGoldenExpectedSchema = z
  .object({
    holdings: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(240),
            type: z.string().trim().min(1).max(120),
            isin: z
              .string()
              .trim()
              .regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/)
              .optional(),
            value: z.number().finite(),
            currency: z
              .string()
              .trim()
              .regex(/^[A-Z]{3}$/),
            fidelity: HOLDING_FIDELITY,
          })
          .strict(),
      )
      .min(1)
      .max(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows),
    movementCount: z.number().int().min(0).optional(),
    warningIncludes: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();

export type PositionsMovementsGoldenExpected = z.infer<
  typeof positionsMovementsGoldenExpectedSchema
>;

interface PositionsMovementsGoldenFixtureBase {
  id: string;
  scenario: PositionsMovementsGoldenScenario;
  sourceFile: string;
  expectedFile: string;
}

export type PositionsMovementsGoldenFixture = PositionsMovementsGoldenFixtureBase & {
  storage: "local";
};

/**
 * **Uncovered today (#1254).** Both scenarios were declared as `.local` XLSX fixtures
 * that no checkout had, which is what made every full run incomplete; the track now
 * declares nothing rather than pretending.
 *
 * Two ways back, and the second is the cheap one:
 *  - a real portfolio export, private by nature, under `.local/extractor-golden/`;
 *  - or a SYNTHETIC workbook committed like the vision captures — this extractor is
 *    deterministic and needs no API key, so a safe synthetic book would grade the
 *    fidelity tiers in CI itself. `portfolio-snapshot` even fits a plain CSV;
 *    `portfolio-with-movements` needs a second sheet, so it needs an .xlsx.
 *
 * The grading logic is not idle meanwhile: `graders.test.ts` covers
 * `gradePositionsMovementsAgainstExpected` in CI, and the extractor has its own unit
 * tests. What is missing is an end-to-end reading of a real book.
 */
export const POSITIONS_MOVEMENTS_GOLDEN_FIXTURES: PositionsMovementsGoldenFixture[] = [];

export function parsePositionsMovementsGoldenExpected(
  input: unknown,
): PositionsMovementsGoldenExpected {
  return positionsMovementsGoldenExpectedSchema.parse(input);
}
