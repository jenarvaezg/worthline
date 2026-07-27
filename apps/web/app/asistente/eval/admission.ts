export const DEFAULT_ADMISSION_THRESHOLD = 0.6;

export interface QuestionScore {
  id: string;
  passed: number;
  total: number;
}

/** One dimension's score, computed on its own so it cannot be diluted. */
export interface AdmissionDimensionScore {
  dimension: string;
  passed: number;
  total: number;
  ratio: number;
  meetsThreshold: boolean;
}

export interface AdmissionVerdict {
  admitted: boolean;
  complete: boolean;
  passed: number;
  total: number;
  ratio: number;
  threshold: number;
}

export interface AdmissionCheck {
  name: string;
  pass: boolean;
}

export interface AdmissionQuestionResult {
  id: string;
  dimension: string;
  persona: string;
  status: "completed" | "error";
  checks: AdmissionCheck[];
  error?: string;
}

export interface AdmissionReport {
  schemaVersion: 2;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  complete: boolean;
  questions: Array<
    AdmissionQuestionResult & {
      passed: number;
      total: number;
    }
  >;
  dimensions: AdmissionDimensionScore[];
  summary: Omit<AdmissionVerdict, "complete">;
}

export function decideSummarizedAdmission(input: {
  complete: boolean;
  passed: number;
  total: number;
  threshold?: number;
}): AdmissionVerdict {
  const threshold = input.threshold ?? DEFAULT_ADMISSION_THRESHOLD;
  if (threshold < 0 || threshold > 1) {
    throw new RangeError("Admission threshold must be between 0 and 1.");
  }
  const ratio = input.total === 0 ? 0 : input.passed / input.total;
  return {
    admitted: input.complete && input.total > 0 && ratio >= threshold,
    complete: input.complete,
    passed: input.passed,
    total: input.total,
    ratio,
    threshold,
  };
}

export function decideAdmission(input: {
  expectedQuestionIds: readonly string[];
  questionResults: readonly QuestionScore[];
  threshold?: number;
}): AdmissionVerdict {
  const expectedIds = new Set(input.expectedQuestionIds);
  const resultIds = new Set(input.questionResults.map((result) => result.id));
  const complete =
    resultIds.size === expectedIds.size &&
    input.questionResults.length === expectedIds.size &&
    [...expectedIds].every((id) => resultIds.has(id));
  const passed = input.questionResults.reduce((sum, result) => sum + result.passed, 0);
  const total = input.questionResults.reduce((sum, result) => sum + result.total, 0);
  return decideSummarizedAdmission({
    complete,
    passed,
    total,
    ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
  });
}

/**
 * Each dimension scored on its own, in first-appearance order.
 *
 * A single ratio over a bag of checks lets a strong dimension pay for a broken one:
 * thirty-odd reading checks outvoted every write-path property and the gate said
 * 0.88 (#1265, ADR 0067). Whatever the aggregate says, these numbers are what
 * answer «is this model fit for the path that writes».
 */
export function scoreDimensions(
  questionResults: readonly (QuestionScore & { dimension: string })[],
  threshold: number = DEFAULT_ADMISSION_THRESHOLD,
): AdmissionDimensionScore[] {
  const order = [...new Set(questionResults.map((result) => result.dimension))];
  return order.map((dimension) => {
    const own = questionResults.filter((result) => result.dimension === dimension);
    const passed = own.reduce((sum, result) => sum + result.passed, 0);
    const total = own.reduce((sum, result) => sum + result.total, 0);
    const ratio = total === 0 ? 0 : passed / total;
    return {
      dimension,
      passed,
      total,
      ratio,
      meetsThreshold: total > 0 && ratio >= threshold,
    };
  });
}

export function buildAdmissionReport(input: {
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  expectedQuestionIds: readonly string[];
  questionResults: readonly AdmissionQuestionResult[];
  threshold?: number;
}): AdmissionReport {
  const questions = input.questionResults.map((result) => ({
    ...result,
    passed: result.checks.filter((check) => check.pass).length,
    total: result.checks.length,
  }));
  const verdict = decideAdmission({
    expectedQuestionIds: input.expectedQuestionIds,
    questionResults: questions,
    ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
  });
  const dimensions = scoreDimensions(questions, verdict.threshold);

  return {
    schemaVersion: 2,
    provider: input.provider,
    model: input.model,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    complete: verdict.complete,
    questions,
    dimensions,
    summary: {
      // Admission needs the aggregate AND every dimension: a model that reads well
      // and cannot be trusted to write is not admitted, it is a routing question.
      admitted:
        verdict.admitted && dimensions.every((dimension) => dimension.meetsThreshold),
      passed: verdict.passed,
      total: verdict.total,
      ratio: verdict.ratio,
      threshold: verdict.threshold,
    },
  };
}
