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

const committedFixtureSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    scenario: z.enum(EXTRACTOR_GOLDEN_SCENARIOS),
    storage: z.literal("committed"),
    imageFile: z.string().trim().min(1),
    expectedFile: z.string().trim().min(1),
  })
  .strict();

const localFixtureSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    scenario: z.enum(EXTRACTOR_GOLDEN_SCENARIOS),
    storage: z.literal("local"),
    imageFile: z.string().trim().min(1),
    expectedFile: z.string().trim().min(1),
  })
  .strict();

export type GoldenFixture =
  | z.infer<typeof committedFixtureSchema>
  | z.infer<typeof localFixtureSchema>;

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
