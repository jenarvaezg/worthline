import { daysBetween } from "./dates";

const YEAR_DAYS = 365;

export interface GrowthSeriesPoint {
  dateKey: string;
  value: number;
}

export interface BenchmarkComparisonPoint {
  dateKey: string;
  subjectGrowth: number;
  benchmarkGrowth: number;
  realGrowth: number;
}

export interface BenchmarkComparison {
  sinceDate: string;
  untilDate: string;
  subjectGrowth: number;
  benchmarkGrowth: number;
  realGrowth: number;
  subjectAnnualGrowth: number;
  benchmarkAnnualGrowth: number;
  realAnnualGrowth: number;
  points: BenchmarkComparisonPoint[];
}

export type BenchmarkComparisonUnavailableReason =
  | "benchmark_unavailable"
  | "zero_start_value";

export type BenchmarkComparisonResult =
  | { comparison: BenchmarkComparison; unavailableReason?: never }
  | { comparison: null; unavailableReason: BenchmarkComparisonUnavailableReason };

export function compareGrowthToBenchmark(input: {
  subject: GrowthSeriesPoint[];
  benchmark: GrowthSeriesPoint[];
}): BenchmarkComparisonResult {
  const benchmarkByMonth = new Map(
    input.benchmark.map((point) => [monthKey(point.dateKey), point]),
  );
  const points = input.subject
    .slice()
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey))
    .flatMap((subject) => {
      const benchmark = benchmarkByMonth.get(monthKey(subject.dateKey));
      return benchmark ? [{ benchmark, subject }] : [];
    });

  if (points.length < 2) {
    return { comparison: null, unavailableReason: "benchmark_unavailable" };
  }

  const first = points[0]!;
  const last = points.at(-1)!;
  if (first.subject.value === 0 || first.benchmark.value === 0) {
    return { comparison: null, unavailableReason: "zero_start_value" };
  }
  const spanDays = daysBetween(first.subject.dateKey, last.subject.dateKey);
  if (spanDays <= 0) {
    return { comparison: null, unavailableReason: "benchmark_unavailable" };
  }

  const comparisonPoints = points.map(({ benchmark, subject }) => {
    const subjectIndex = subject.value / first.subject.value;
    const benchmarkIndex = benchmark.value / first.benchmark.value;
    return {
      dateKey: subject.dateKey,
      benchmarkGrowth: benchmarkIndex - 1,
      realGrowth: subjectIndex / benchmarkIndex - 1,
      subjectGrowth: subjectIndex - 1,
    };
  });
  const finalPoint = comparisonPoints.at(-1)!;

  return {
    comparison: {
      sinceDate: first.subject.dateKey,
      untilDate: last.subject.dateKey,
      benchmarkGrowth: finalPoint.benchmarkGrowth,
      benchmarkAnnualGrowth: annualize(finalPoint.benchmarkGrowth, spanDays),
      points: comparisonPoints,
      realGrowth: finalPoint.realGrowth,
      realAnnualGrowth: annualize(finalPoint.realGrowth, spanDays),
      subjectAnnualGrowth: annualize(finalPoint.subjectGrowth, spanDays),
      subjectGrowth: finalPoint.subjectGrowth,
    },
  };
}

function annualize(growth: number, spanDays: number): number {
  return (1 + growth) ** (YEAR_DAYS / spanDays) - 1;
}

function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}
