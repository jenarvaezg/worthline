/**
 * Golden-vector generator for the Rust↔TS amortization parity gate
 * (PRD #280, Module C / issue #287).
 *
 * The `big.js`-backed TS engine is the oracle. For a set of named fixtures plus
 * a SEEDED fuzz of randomized plans, this dumps each plan's inputs together with
 * the TS engine's `firstCuota` and its outstanding balance at every sampled date
 * (every payment boundary across the full range — i.e. the schedule — plus
 * intra-month samples and out-of-range probes). The Rust harness
 * (`tests/parity_golden_vectors.rs`) reads this JSON and asserts integer-identical
 * output. The seed makes the fixture reproducible: same seed → same plans.
 *
 * Run from the repo root:
 *   npx tsx crates/worthline-core/parity/generate-golden-vectors.ts
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  addMonths,
  amortizableBalanceAtDate,
  assertEventWithinTerm,
  firstCuota,
} from "@worthline/domain";
import type {
  AmortizationPlanInput,
  EarlyRepayment,
  InterestRateRevision,
} from "@worthline/domain";

const SEED = 20_260_618;
const FUZZ_COUNT = 60;

// ---- seeded PRNG (mulberry32) ------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const randInt = (min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

// ---- date helpers (UTC-midnight, matching the engine's daysBetween) ----------

const MS_PER_DAY = 86_400_000;
const toMs = (key: string): number => Date.parse(`${key}T00:00:00.000Z`);
const toKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (key: string, days: number): string =>
  toKey(toMs(key) + days * MS_PER_DAY);
const daysBetween = (from: string, to: string): number =>
  Math.round((toMs(to) - toMs(from)) / MS_PER_DAY);

function randomDate(minKey: string, maxKey: string): string {
  const min = toMs(minKey);
  const max = toMs(maxKey);
  return toKey(min + Math.floor(rand() * (max - min)));
}

/** Pin `yearMonth` (YYYY-MM) to `day`, clamped to the month's last valid day. */
function withClampedDay(yearMonth: string, day: number): string {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clamped = Math.min(day, last);
  return `${yearMonth}-${String(clamped).padStart(2, "0")}`;
}

/** Schedule boundary date m (mirrors the engine's boundaryDate). */
function boundaryDate(plan: AmortizationPlanInput, m: number): string {
  return m === 0 ? plan.disbursementDate : addMonths(plan.firstPaymentDate, m - 1);
}

// ---- random plan / events ----------------------------------------------------

function randomRate(): string {
  return rand() < 0.1 ? "0" : (0.005 + rand() * 0.075).toFixed(5);
}

function randomPlan(): AmortizationPlanInput {
  const initialCapitalMinor = randInt(1_000_00, 1_000_000_00);
  const annualInterestRate = randomRate();
  const termMonths = randInt(12, 120);
  const disbursementDate = randomDate("2000-01-01", "2020-12-31");
  const stubMonths = randInt(1, 3);
  const yearMonth = addMonths(disbursementDate, stubMonths).slice(0, 7);
  const firstPaymentDate = withClampedDay(yearMonth, pick([1, 5, 15, 28, 31]));
  return {
    initialCapitalMinor,
    annualInterestRate,
    termMonths,
    disbursementDate,
    firstPaymentDate,
  };
}

function randomRevisions(plan: AmortizationPlanInput): InterestRateRevision[] {
  const out: InterestRateRevision[] = [];
  for (let i = 0; i < randInt(0, 3); i += 1) {
    const m = randInt(1, plan.termMonths - 1);
    const revisionDate = addMonths(plan.firstPaymentDate, m - 1);
    try {
      assertEventWithinTerm(plan, revisionDate, "Revision date");
      out.push({ revisionDate, newAnnualInterestRate: randomRate() });
    } catch {
      // out-of-term event would be silently dropped by both engines; skip it.
    }
  }
  return out;
}

function randomRepayments(plan: AmortizationPlanInput): EarlyRepayment[] {
  const out: EarlyRepayment[] = [];
  for (let i = 0; i < randInt(0, 3); i += 1) {
    const m = randInt(1, plan.termMonths - 1);
    let repaymentDate = addMonths(plan.firstPaymentDate, m - 1);
    if (rand() < 0.3) repaymentDate = addDays(repaymentDate, randInt(1, 20));
    const half = Math.max(10_00, Math.floor(plan.initialCapitalMinor / 2));
    const amountMinor = rand() < 0.15 ? plan.initialCapitalMinor : randInt(10_00, half);
    const mode = pick(["reduce-payment", "reduce-term"] as const);
    try {
      assertEventWithinTerm(plan, repaymentDate, "Repayment date");
      out.push({ repaymentDate, amountMinor, mode });
    } catch {
      // out-of-term event would be silently dropped by both engines; skip it.
    }
  }
  return out;
}

// ---- date sampling -----------------------------------------------------------

/** Boundaries (capped to ~150/plan via stride) + intra-month + out-of-range. */
function sampleDates(plan: AmortizationPlanInput): string[] {
  const term = plan.termMonths;
  const dates = new Set<string>();

  dates.add(addDays(plan.disbursementDate, -10)); // before disbursement → flat
  dates.add(plan.disbursementDate);

  const stride = Math.max(1, Math.ceil(term / 150));
  for (let m = 0; m <= term; m += stride) dates.add(boundaryDate(plan, m));
  for (const m of [0, 1, 2, term - 1, term]) {
    if (m >= 0) dates.add(boundaryDate(plan, m));
  }

  for (let i = 0; i < Math.min(5, term - 1); i += 1) {
    const m = randInt(1, term - 1);
    const start = boundaryDate(plan, m);
    const end = boundaryDate(plan, m + 1);
    const span = daysBetween(start, end);
    if (span > 1) dates.add(addDays(start, Math.floor(span / 2)));
  }

  dates.add(addDays(boundaryDate(plan, term), 5)); // after final payment → 0
  dates.add(addMonths(plan.firstPaymentDate, term + 12)); // far future → 0

  return [...dates].sort();
}

// ---- vector assembly ---------------------------------------------------------

interface Vector {
  label: string;
  plan: AmortizationPlanInput;
  revisions: InterestRateRevision[];
  earlyRepayments: EarlyRepayment[];
  firstCuota: ReturnType<typeof firstCuota>;
  balances: { date: string; expected: number }[];
}

function buildVector(
  label: string,
  plan: AmortizationPlanInput,
  revisions: InterestRateRevision[],
  earlyRepayments: EarlyRepayment[],
): Vector {
  const balances = sampleDates(plan).map((date) => ({
    date,
    expected: amortizableBalanceAtDate({
      plan,
      revisions,
      earlyRepayments,
      targetDate: date,
    }),
  }));
  return {
    label,
    plan,
    revisions,
    earlyRepayments,
    firstCuota: firstCuota(plan),
    balances,
  };
}

// Named fixtures — the canonical curves from the TS unit suite, dumped at full
// density. A few carry the exact revision/repayment scenarios the suite pins.
const NAMED: Vector[] = [
  buildVector(
    "named:prd-example",
    {
      annualInterestRate: "0.025",
      initialCapitalMinor: 200_000_00,
      termMonths: 360,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
    },
    [],
    [],
  ),
  buildVector(
    "named:bank-240",
    {
      annualInterestRate: "0.03",
      initialCapitalMinor: 200_000_00,
      termMonths: 240,
      disbursementDate: "2020-01-15",
      firstPaymentDate: "2020-03-01",
    },
    [],
    [],
  ),
  buildVector(
    "named:loan-120",
    {
      annualInterestRate: "0.03",
      initialCapitalMinor: 100_000_00,
      termMonths: 120,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
    },
    [],
    [],
  ),
  buildVector(
    "named:loan-revision-and-repayment",
    {
      annualInterestRate: "0.03",
      initialCapitalMinor: 100_000_00,
      termMonths: 120,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
    },
    [{ revisionDate: "2021-01-01", newAnnualInterestRate: "0.05" }],
    [{ repaymentDate: "2022-01-01", amountMinor: 20_000_00, mode: "reduce-payment" }],
  ),
  buildVector(
    "named:zero-rate-12",
    {
      annualInterestRate: "0",
      initialCapitalMinor: 1_200_00,
      termMonths: 12,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
    },
    [],
    [],
  ),
  buildVector(
    "named:clamping-day31",
    {
      annualInterestRate: "0.03",
      initialCapitalMinor: 100_000_00,
      termMonths: 120,
      disbursementDate: "2019-12-31",
      firstPaymentDate: "2020-01-31",
    },
    [{ revisionDate: "2021-02-28", newAnnualInterestRate: "0.06" }],
    [{ repaymentDate: "2021-02-28", amountMinor: 15_000_00, mode: "reduce-term" }],
  ),
  buildVector(
    "named:zero-rate-2900-day31",
    {
      annualInterestRate: "0",
      initialCapitalMinor: 2_900_00,
      termMonths: 12,
      disbursementDate: "2019-12-31",
      firstPaymentDate: "2020-01-31",
    },
    [],
    [],
  ),
];

const fuzz: Vector[] = [];
for (let i = 0; i < FUZZ_COUNT; i += 1) {
  const plan = randomPlan();
  fuzz.push(
    buildVector(`fuzz#${i}`, plan, randomRevisions(plan), randomRepayments(plan)),
  );
}

const vectors = [...NAMED, ...fuzz];
const balanceCaseCount = vectors.reduce((sum, v) => sum + v.balances.length, 0);

const fixture = {
  generatedBy: "crates/worthline-core/parity/generate-golden-vectors.ts",
  oracle: "@worthline/domain (big.js) — PRD #280, issue #287",
  seed: SEED,
  fuzzCount: FUZZ_COUNT,
  vectorCount: vectors.length,
  balanceCaseCount,
  vectors,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "tests", "fixtures", "golden-vectors.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(fixture));

console.log(
  `wrote ${vectors.length} vectors (${NAMED.length} named + ${FUZZ_COUNT} fuzz), ` +
    `${balanceCaseCount} balance cases → ${outPath}`,
);
