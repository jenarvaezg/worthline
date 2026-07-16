import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  extractPositionsFromImage,
  IMAGE_EXTRACTOR_DEFAULT_MODEL,
} from "@web/asistente/attachment-image-extractor";
import { extractBalanceSeriesFromPdf } from "@web/asistente/attachment-pdf-extractor";
import { attachmentMimeTypeForFileName } from "@web/asistente/attachment-types";

import {
  type AdmissionCheck,
  type AdmissionQuestionResult,
  buildAdmissionReport,
  DEFAULT_ADMISSION_THRESHOLD,
} from "@web/asistente/eval/admission";
import { parseExtractorEvalArgs } from "./args";
import {
  gradeBalanceSeriesAgainstExpected,
  gradeExtractionAgainstExpected,
} from "./graders";
import {
  BALANCE_SERIES_GOLDEN_FIXTURES,
  type BalanceSeriesGoldenFixture,
  EXTRACTOR_GOLDEN_FIXTURES,
  type GoldenFixture,
  parseBalanceSeriesGoldenExpected,
  parseGoldenExpected,
} from "./manifest";
import {
  resolveBalanceSeriesExpectedPath,
  resolveBalanceSeriesSourcePath,
  resolveFixtureExpectedPath,
  resolveFixtureImagePath,
} from "./paths";

const DELAY_BETWEEN_FIXTURES_MS = 20_000;

export interface FixtureRunResult {
  id: string;
  scenario: string;
  status: "completed" | "error" | "skipped";
  sourcePath: string;
  checks: AdmissionCheck[];
  error?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function assertKnownIds(only: string[]): void {
  const known = new Set([
    ...EXTRACTOR_GOLDEN_FIXTURES.map((fixture) => fixture.id),
    ...BALANCE_SERIES_GOLDEN_FIXTURES.map((fixture) => fixture.id),
  ]);
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown fixture id(s): ${unknown.join(", ")}`);
  }
}

function selectedFixtures(only?: string[]): GoldenFixture[] {
  if (!only || only.length === 0) return EXTRACTOR_GOLDEN_FIXTURES;
  const allowed = new Set(only);
  return EXTRACTOR_GOLDEN_FIXTURES.filter((fixture) => allowed.has(fixture.id));
}

function selectedBalanceSeriesFixtures(only?: string[]): BalanceSeriesGoldenFixture[] {
  if (!only || only.length === 0) return BALANCE_SERIES_GOLDEN_FIXTURES;
  const allowed = new Set(only);
  return BALANCE_SERIES_GOLDEN_FIXTURES.filter((fixture) => allowed.has(fixture.id));
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
      sourcePath: imagePath,
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
      sourcePath: imagePath,
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
      sourcePath: imagePath,
      scenario: fixture.scenario,
      status: "error",
    };
  }
}

export async function runBalanceSeriesFixture(
  fixture: BalanceSeriesGoldenFixture,
  env: Record<string, string | undefined>,
): Promise<FixtureRunResult> {
  const sourcePath = resolveBalanceSeriesSourcePath(fixture);
  const expectedPath = resolveBalanceSeriesExpectedPath(fixture);
  const rowLabel = `${fixture.scenario}/${fixture.id}`.padEnd(36);

  const hasSource = await fileExists(sourcePath);
  const hasExpected = await fileExists(expectedPath);
  if (!hasSource || !hasExpected) {
    const missing = [!hasSource ? "pdf" : null, !hasExpected ? "expected" : null]
      .filter((part): part is string => part !== null)
      .join(" + ");
    console.error(`SKIP  ${rowLabel} missing ${missing} under ${fixture.storage}`);
    return {
      checks: [],
      error: `Missing ${missing} fixture files.`,
      id: fixture.id,
      sourcePath,
      scenario: fixture.scenario,
      status: "skipped",
    };
  }

  try {
    const [bytes, expectedRaw] = await Promise.all([
      readFile(sourcePath),
      readFile(expectedPath, "utf8"),
    ]);
    const expected = parseBalanceSeriesGoldenExpected(JSON.parse(expectedRaw));
    const result = await extractBalanceSeriesFromPdf(
      {
        bytes: new Uint8Array(bytes),
        fileName: fixture.sourceFile,
        mimeType: "application/pdf",
      },
      { env },
    );
    const checks = gradeBalanceSeriesAgainstExpected(result, expected);
    const passed = checks.filter((check) => check.pass).length;
    const green = passed === checks.length;
    console.error(`${green ? "PASS" : "FAIL"}  ${rowLabel} ${passed}/${checks.length}`);
    for (const check of checks.filter((candidate) => !candidate.pass)) {
      console.error(`        ✗ ${check.name}`);
    }
    return {
      checks,
      id: fixture.id,
      sourcePath,
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
      sourcePath,
      scenario: fixture.scenario,
      status: "error",
    };
  }
}

export async function runExtractorEval(argv: readonly string[]): Promise<number> {
  const args = parseExtractorEvalArgs(argv);
  if (args.only) assertKnownIds(args.only);
  const fixtures = selectedFixtures(args.only);
  const balanceSeriesFixtures = selectedBalanceSeriesFixtures(args.only);
  const env = {
    ...process.env,
    ...(args.model ? { WORTHLINE_EXTRACTOR_MODEL: args.model } : {}),
  };
  const model = env.WORTHLINE_EXTRACTOR_MODEL?.trim() || IMAGE_EXTRACTOR_DEFAULT_MODEL;
  const startedAt = new Date().toISOString();
  const subset = args.only !== undefined && args.only.length > 0;

  console.error(`\nExtractor eval · google/${model}`);
  console.error("─".repeat(64));

  const fixtureResults: FixtureRunResult[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    if (index > 0) await sleep(DELAY_BETWEEN_FIXTURES_MS);
    fixtureResults.push(await runExtractorFixture(fixture, env));
  }
  for (const fixture of balanceSeriesFixtures) {
    if (fixtureResults.length > 0) await sleep(DELAY_BETWEEN_FIXTURES_MS);
    fixtureResults.push(await runBalanceSeriesFixture(fixture, env));
  }

  const attempted = fixtureResults.filter((result) => result.status !== "skipped");
  const report = buildAdmissionReport({
    expectedQuestionIds: [
      ...fixtures.map((fixture) => fixture.id),
      ...balanceSeriesFixtures.map((fixture) => fixture.id),
    ],
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
      sourcePath: result.sourcePath,
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
    ...(subset ? { subset: true as const } : {}),
  };
  const json = `${JSON.stringify(enriched, null, 2)}\n`;
  process.stdout.write(json);
  if (args.output) await writeFile(args.output, json, "utf8");

  console.error("─".repeat(64));
  console.error(
    `${report.summary.passed}/${report.summary.total} checks passed · ` +
      `${report.complete ? "complete" : "incomplete"} · ` +
      `${enriched.skipped} skipped · ` +
      `${subset ? "subset · " : ""}` +
      `${report.summary.admitted ? "ADMITTED" : "REJECTED"}\n`,
  );

  const totalFixtures = fixtures.length + balanceSeriesFixtures.length;
  const incompleteBecauseSkipped =
    fixtureResults.some((result) => result.status === "skipped") &&
    attempted.length < totalFixtures;
  if (incompleteBecauseSkipped) return 1;
  return report.summary.admitted ? 0 : 1;
}

export { DEFAULT_ADMISSION_THRESHOLD } from "@web/asistente/eval/admission";
export { DEFAULT_EXTRACTOR_THRESHOLD, type ExtractorEvalArgs } from "./args";

async function main(): Promise<void> {
  process.exitCode = await runExtractorEval(process.argv.slice(2));
}

function isCliEntry(): boolean {
  if (import.meta.main) return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Extractor eval failed: ${message}`);
    process.exitCode = 1;
  });
}
