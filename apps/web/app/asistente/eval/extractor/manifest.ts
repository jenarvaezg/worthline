import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  extractedPositionSchema,
} from "@web/asistente/attachment-extraction-contract";
import { z } from "zod";

export const EXTRACTOR_GOLDEN_SCENARIOS = [
  "desktop",
  "mobile",
  "reflections",
  "misaligned-columns",
  "ticker-name-ambiguity",
  "thousand-separator",
] as const;

export type ExtractorGoldenScenario = (typeof EXTRACTOR_GOLDEN_SCENARIOS)[number];

const nonEmptyMessageSchema = z.string().trim().min(1).max(300);

const goldenExpectedSchema = z
  .object({
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

export type GoldenExpected = z.infer<typeof goldenExpectedSchema>;

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
 * Golden extractor fixtures (#991). Committed entries ship safe synthetic assets;
 * local entries reference private captures under `.local/extractor-golden/`.
 */
export const EXTRACTOR_GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    expectedFile: "expected/synthetic-baseline.json",
    id: "synthetic-baseline",
    imageFile: "fixtures/synthetic-baseline.png",
    scenario: "desktop",
    storage: "committed",
  },
  {
    expectedFile: "mobile.expected.json",
    id: "mobile",
    imageFile: "mobile.png",
    scenario: "mobile",
    storage: "local",
  },
  {
    expectedFile: "reflections.expected.json",
    id: "reflections",
    imageFile: "reflections.png",
    scenario: "reflections",
    storage: "local",
  },
  {
    expectedFile: "misaligned-columns.expected.json",
    id: "misaligned-columns",
    imageFile: "misaligned-columns.png",
    scenario: "misaligned-columns",
    storage: "local",
  },
  {
    expectedFile: "ticker-name-ambiguity.expected.json",
    id: "ticker-name-ambiguity",
    imageFile: "ticker-name-ambiguity.png",
    scenario: "ticker-name-ambiguity",
    storage: "local",
  },
  {
    expectedFile: "thousand-separator.expected.json",
    id: "thousand-separator",
    imageFile: "thousand-separator.png",
    scenario: "thousand-separator",
    storage: "local",
  },
];

export function parseGoldenExpected(input: unknown): GoldenExpected {
  return goldenExpectedSchema.parse(input);
}

// --- Dated balance series (PDF) golden track (PRD #1048 S4) ---------------------

export const BALANCE_SERIES_GOLDEN_SCENARIOS = [
  "debt-statement",
  "amortization-schedule",
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

export type BalanceSeriesGoldenFixture = BalanceSeriesGoldenFixtureBase & {
  storage: "local";
};

/**
 * Balance-series PDF fixtures are private by nature (real bank statements and
 * amortization schedules). They live only under `.local/extractor-golden/` and
 * are never committed — the CLI eval skips any scenario whose files are absent,
 * exactly like #865's private capture set.
 */
export const BALANCE_SERIES_GOLDEN_FIXTURES: BalanceSeriesGoldenFixture[] = [
  {
    expectedFile: "debt-statement.expected.json",
    id: "debt-statement",
    scenario: "debt-statement",
    sourceFile: "debt-statement.pdf",
    storage: "local",
  },
  {
    expectedFile: "amortization-schedule.expected.json",
    id: "amortization-schedule",
    scenario: "amortization-schedule",
    sourceFile: "amortization-schedule.pdf",
    storage: "local",
  },
];

export function parseBalanceSeriesGoldenExpected(
  input: unknown,
): BalanceSeriesGoldenExpected {
  return balanceSeriesGoldenExpectedSchema.parse(input);
}
