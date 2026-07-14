import { readFile } from "node:fs/promises";

import {
  extractPositionsFromImage,
  IMAGE_EXTRACTOR_DEFAULT_MODEL,
} from "@web/asistente/attachment-image-extractor";
import { attachmentMimeTypeForFileName } from "@web/asistente/attachment-types";

import {
  type AdmissionCheck,
  type AdmissionQuestionResult,
  buildAdmissionReport,
  DEFAULT_ADMISSION_THRESHOLD,
} from "@web/asistente/eval/admission";
import { gradeExtractionAgainstExpected } from "./graders";
import {
  EXTRACTOR_GOLDEN_FIXTURES,
  type GoldenFixture,
  parseGoldenExpected,
} from "./manifest";
import { resolveFixtureExpectedPath, resolveFixtureImagePath } from "./paths";

const DEFAULT_EXTRACTOR_THRESHOLD = 1;
const DELAY_BETWEEN_FIXTURES_MS = 20_000;

export interface ExtractorEvalArgs {
  model?: string;
  threshold: number;
  output?: string;
  only?: string[];
}

export interface FixtureRunResult {
  id: string;
  scenario: string;
  status: "completed" | "error" | "skipped";
  imagePath: string;
  checks: AdmissionCheck[];
  error?: string;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function valuesAfter(argv: readonly string[], flag: string): string[] | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const values: string[] = [];
  for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
    const value = argv[cursor];
    if (!value || value.startsWith("--")) break;
    values.push(value);
  }
  if (values.length === 0) throw new Error(`${flag} requires at least one value.`);
  return values;
}

export function parseExtractorEvalArgs(argv: readonly string[]): ExtractorEvalArgs {
  const thresholdValue = valueAfter(argv, "--threshold");
  const threshold = thresholdValue
    ? Number.parseFloat(thresholdValue)
    : DEFAULT_EXTRACTOR_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be a number between 0 and 1.");
  }

  const model = valueAfter(argv, "--model");
  const output = valueAfter(argv, "--output");
  const only = valuesAfter(argv, "--only");
  return {
    threshold,
    ...(model ? { model } : {}),
    ...(output ? { output } : {}),
    ...(only ? { only } : {}),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function selectedFixtures(only?: string[]): GoldenFixture[] {
  if (!only || only.length === 0) return EXTRACTOR_GOLDEN_FIXTURES;
  const allowed = new Set(only);
  const fixtures = EXTRACTOR_GOLDEN_FIXTURES.filter((fixture) => allowed.has(fixture.id));
  if (fixtures.length !== allowed.size) {
    const known = new Set(EXTRACTOR_GOLDEN_FIXTURES.map((fixture) => fixture.id));
    const unknown = [...allowed].filter((id) => !known.has(id));
    throw new Error(`Unknown fixture id(s): ${unknown.join(", ")}`);
  }
  return fixtures;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runExtractorFixture(
  fixture: GoldenFixture,
  env: Record<string, string | undefined>,
): Promise<FixtureRunResult> {
  const imagePath = resolveFixtureImagePath(fixture);
  const expectedPath = resolveFixtureExpectedPath(fixture);
  const rowLabel = `${fixture.scenario}/${fixture.id}`.padEnd(36);

  const hasImage = await fileExists(imagePath);
  const hasExpected = await fileExists(expectedPath);
  if (!hasImage || !hasExpected) {
    const missing = [!hasImage ? "image" : null, !hasExpected ? "expected" : null]
      .filter((part): part is string => part !== null)
      .join(" + ");
    console.error(`SKIP  ${rowLabel} missing ${missing} under ${fixture.storage}`);
    return {
      checks: [],
      error: `Missing ${missing} fixture files.`,
      id: fixture.id,
      imagePath,
      scenario: fixture.scenario,
      status: "skipped",
    };
  }

  try {
    const [bytes, expectedRaw] = await Promise.all([
      readFile(imagePath),
      readFile(expectedPath, "utf8"),
    ]);
    const expected = parseGoldenExpected(JSON.parse(expectedRaw));
    const mimeType = attachmentMimeTypeForFileName(fixture.imageFile) || "image/png";
    const result = await extractPositionsFromImage(
      {
        bytes: new Uint8Array(bytes),
        fileName: fixture.imageFile,
        mimeType,
      },
      { env },
    );
    const checks = gradeExtractionAgainstExpected(result, expected);
    const passed = checks.filter((check) => check.pass).length;
    const green = passed === checks.length;
    console.error(`${green ? "PASS" : "FAIL"}  ${rowLabel} ${passed}/${checks.length}`);
    for (const check of checks.filter((candidate) => !candidate.pass)) {
      console.error(`        ✗ ${check.name}`);
    }
    return {
      checks,
      id: fixture.id,
      imagePath,
      scenario: fixture.scenario,
      status: "completed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERR   ${rowLabel} ${message}`);
    return {
      checks: [],
      error: message,
      id: fixture.id,
      imagePath,
      scenario: fixture.scenario,
      status: "error",
    };
  }
}

export async function runExtractorEval(argv: readonly string[]): Promise<number> {
  const args = parseExtractorEvalArgs(argv);
  const fixtures = selectedFixtures(args.only);
  const env = {
    ...process.env,
    ...(args.model ? { WORTHLINE_EXTRACTOR_MODEL: args.model } : {}),
  };
  const model = env.WORTHLINE_EXTRACTOR_MODEL?.trim() || IMAGE_EXTRACTOR_DEFAULT_MODEL;
  const startedAt = new Date().toISOString();

  console.error(`\nExtractor eval · google/${model}`);
  console.error("─".repeat(64));

  const fixtureResults: FixtureRunResult[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    if (index > 0) await sleep(DELAY_BETWEEN_FIXTURES_MS);
    fixtureResults.push(await runExtractorFixture(fixture, env));
  }

  const attempted = fixtureResults.filter((result) => result.status !== "skipped");
  const report = buildAdmissionReport({
    expectedQuestionIds: fixtures.map((fixture) => fixture.id),
    finishedAt: new Date().toISOString(),
    model,
    provider: "google",
    questionResults: attempted.map(
      (result): AdmissionQuestionResult => ({
        checks: result.checks,
        id: result.id,
        persona: result.scenario,
        status: result.status === "error" ? "error" : "completed",
        ...(result.error ? { error: result.error } : {}),
      }),
    ),
    startedAt,
    threshold: args.threshold,
  });
  const enriched = {
    ...report,
    fixtures: fixtureResults.map((result) => ({
      id: result.id,
      imagePath: result.imagePath,
      scenario: result.scenario,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      ...(result.checks.length > 0
        ? {
            passed: result.checks.filter((check) => check.pass).length,
            total: result.checks.length,
          }
        : {}),
    })),
    skipped: fixtureResults.filter((result) => result.status === "skipped").length,
  };
  const json = `${JSON.stringify(enriched, null, 2)}\n`;
  process.stdout.write(json);
  if (args.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.output, json, "utf8");
  }

  console.error("─".repeat(64));
  console.error(
    `${report.summary.passed}/${report.summary.total} checks passed · ` +
      `${report.complete ? "complete" : "incomplete"} · ` +
      `${enriched.skipped} skipped · ` +
      `${report.summary.admitted ? "ADMITTED" : "REJECTED"}\n`,
  );

  const incompleteBecauseSkipped =
    fixtureResults.some((result) => result.status === "skipped") &&
    attempted.length < fixtures.length;
  if (incompleteBecauseSkipped) return 1;
  return report.summary.admitted ? 0 : 1;
}

export { DEFAULT_ADMISSION_THRESHOLD, DEFAULT_EXTRACTOR_THRESHOLD };

async function main(): Promise<void> {
  process.exitCode = await runExtractorEval(process.argv.slice(2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Extractor eval failed: ${message}`);
  process.exitCode = 1;
});
