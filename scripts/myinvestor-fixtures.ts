/**
 * Regenerates the MyInvestor fixtures from the raw captures, checks that no common factor
 * links the invented amounts to the real ones, and runs the careo (#1887).
 * The whole procedure, with its rules, is the skill `.claude/skills/myinvestor-fixtures/`.
 *
 *   bun run fixtures:myinvestor            # anonymize → rebuild → factor check → biome → careo
 *   bun run fixtures:myinvestor check      # careo only (needs the raw captures, not the secret)
 *
 * Environment (both default to the `.local/` of the checkout, which git ignores):
 *   MYINVESTOR_RAW_DIR              the raw captures, one `.json` per call of `myinvestor raw`
 *   MYINVESTOR_CAREO_BASE           the base the careo diffs against (default origin/main)
 *   MYINVESTOR_FIXTURE_SECRET_FILE  the secret behind the fakes; it never
 *                                   enters git (default: `myinvestor-fixtures.secret` next to
 *                                   the raw folder). `MYINVESTOR_FIXTURE_SECRET` wins if set.
 *
 * It never prints a raw value or the secret: a leak is reported by file, kind
 * and a masked hint.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  planCaptureFixtures,
  type RawCapture,
} from "@pricing/myinvestor/fixtures/capture-plan";
import {
  createFigureMap,
  hasCommonFactor,
} from "@pricing/myinvestor/fixtures/figure-map";
import { findValidIdentities } from "@pricing/myinvestor/fixtures/identity-checks";
import {
  collectSecrets,
  findLeaks,
  findTextLeaks,
  pairedAmounts,
} from "@pricing/myinvestor/fixtures/leak-check";
import { createPseudonymizer } from "@pricing/myinvestor/fixtures/pseudonymizer";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(ROOT, "packages/pricing/src/__fixtures__/myinvestor");
const CAPTURE_DIR = join(FIXTURES_DIR, "capture");
const RAW_DIR = process.env.MYINVESTOR_RAW_DIR ?? join(ROOT, ".local/myinvestor-raw");
/** What the work is compared against: every file changed since it is scanned. */
const CAREO_BASE = process.env.MYINVESTOR_CAREO_BASE ?? "origin/main";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readRaw(): RawCapture[] {
  if (!existsSync(RAW_DIR)) {
    fail(
      `No hay capturas en ${RAW_DIR}. Apunta MYINVESTOR_RAW_DIR a la carpeta de \`capture.sh\`.`,
    );
  }
  return readdirSync(RAW_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name: name.slice(0, -".json".length),
      text: readFileSync(join(RAW_DIR, name), "utf8"),
    }));
}

function readSecret(): string {
  const inline = process.env.MYINVESTOR_FIXTURE_SECRET;
  if (inline) return inline.trim();
  const file =
    process.env.MYINVESTOR_FIXTURE_SECRET_FILE ??
    join(dirname(RAW_DIR), "myinvestor-fixtures.secret");
  if (!existsSync(file)) {
    fail(
      `Falta el secreto (${file}). Créalo con \`openssl rand -hex 32\`; nunca va a git.`,
    );
  }
  const secret = readFileSync(file, "utf8").trim();
  if (secret.length < 32)
    fail("El secreto es demasiado corto: usa al menos 32 caracteres.");
  return secret;
}

function listFixtures(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      file: relative(FIXTURES_DIR, join(dir, name)),
      text: readFileSync(join(dir, name), "utf8"),
    }));
}

const mask = (value: string) => `${value.slice(0, 2)}…(${value.length})`;

const vcs = (...args: string[]) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Every line the work adds against `CAREO_BASE` (committed, staged, unstaged or in a new
 * file), by file, plus the branch's commit messages: code, tests, comments, docs and the
 * skill are leak paths too. The fixture bodies are checked field by field instead.
 */
function changedTexts(): { file: string; text: string }[] {
  const added = new Map<string, string[]>();
  let current = "";
  const diff = vcs("diff", "--unified=0", "--no-color", "--no-ext-diff", CAREO_BASE);
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/") ? line.slice("+++ b/".length) : "";
    } else if (current && line.startsWith("+")) {
      added.set(current, [...(added.get(current) ?? []), line.slice(1)]);
    }
  }
  for (const name of vcs("ls-files", "--others", "--exclude-standard").split("\n")) {
    if (name) added.set(name, [readFileSync(join(ROOT, name), "utf8")]);
  }
  const fixtureBodies = relative(ROOT, FIXTURES_DIR);
  const files = [...added]
    .filter(([name]) => !(name.startsWith(fixtureBodies) && name.endsWith(".json")))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, lines]) => ({ file, text: lines.join("\n") }));
  const messages = vcs("log", "--format=%B", `${CAREO_BASE}..HEAD`);
  return [...files, { file: `(mensajes de commit desde ${CAREO_BASE})`, text: messages }];
}

function careo(raw: readonly RawCapture[]): void {
  const secrets = collectSecrets(raw);
  const fixtures = listFixtures(FIXTURES_DIR);
  const texts = changedTexts();
  const leaks = [...findLeaks(secrets, fixtures), ...findTextLeaks(secrets, texts)];
  const identities = [...fixtures, ...texts].flatMap(({ file, text }) =>
    findValidIdentities(text).map((hit) => ({ file, kind: hit.kind, value: hit.value })),
  );
  for (const leak of [...leaks, ...identities]) {
    console.error(`  ${leak.file}: ${leak.kind} ${mask(leak.value)}`);
  }
  if (leaks.length + identities.length > 0) {
    fail(
      `Careo SUCIO: ${leaks.length} datos de la captura y ${identities.length} IBAN/DNI válidos.`,
    );
  }
  console.log(
    `✓ Careo limpio: ${fixtures.length} fixtures y ${texts.length - 1} ficheros más del cambio, con los mensajes de commit desde ${CAREO_BASE}, contra ${raw.length} capturas en crudo: sin datos de la captura ni IBAN/DNI válidos.`,
  );
}

function generate(raw: readonly RawCapture[]): void {
  const secret = readSecret();
  const secrets = collectSecrets(raw);
  const forbidden = { amounts: secrets.amounts, quantities: secrets.quantities };
  const plan = planCaptureFixtures(raw, {
    pseudonyms: createPseudonymizer(secret),
    // An invented figure never takes a value the real capture has.
    figures: createFigureMap(secret, forbidden),
    forbidden,
  });
  const rawBySource = new Map(raw.map((capture) => [capture.name, capture.text]));
  const pairs = plan.fixtures.flatMap((fixture) =>
    pairedAmounts(rawBySource.get(fixture.source) ?? "{}", fixture.text),
  );
  if (hasCommonFactor(pairs)) {
    fail(
      "Los importes del fixture guardan un factor común con los reales: no se escribe nada.",
    );
  }
  const distinct = new Map(pairs.map(({ real, fake }) => [real, fake]));
  const ratios = new Set(
    [...distinct].map(([real, fake]) => (Number(fake) / Number(real)).toFixed(3)),
  ).size;
  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const fixture of plan.fixtures)
    writeFileSync(join(FIXTURES_DIR, fixture.file), fixture.text);
  writeFileSync(
    join(CAPTURE_DIR, "manifest.json"),
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
  );
  execFileSync(
    join(ROOT, "node_modules/.bin/biome"),
    ["format", "--write", CAPTURE_DIR],
    {
      stdio: "ignore",
    },
  );
  console.log(
    `✓ ${plan.fixtures.length} fixtures en ${relative(ROOT, CAPTURE_DIR)}; fuera a propósito: ${plan.skipped.join(", ")}.
✓ Sin factor común: ${distinct.size} importes reales distintos, ${ratios} cocientes falso/real distintos.`,
  );
}

const mode = process.argv[2] ?? "generate";
if (mode !== "generate" && mode !== "check")
  fail(`Modo desconocido: ${mode} (generate | check)`);
const raw = readRaw();
if (mode === "generate") generate(raw);
careo(raw);
