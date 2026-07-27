import type { EvalDimension } from "./dimension";

/** One dimension of a committed run, so a mark says WHAT it measured. */
interface EvidenceDimension {
  dimension: EvalDimension;
  passed: number;
  total: number;
}

interface EvidenceRun {
  evaluatedAt: string;
  complete: boolean;
  passed: number;
  total: number;
  executedQuestions: number;
  totalQuestions: number;
  /**
   * The same checks broken down by dimension (#1265). A mark with a MISSING
   * dimension is not an omission: it is a run from before those questions existed,
   * so it states nothing about what they measure (ADR 0067). Two such gaps exist
   * today — Groq's `tool-discipline`, and `attachments` in every mark, because all
   * three runs predate #1254.
   */
  dimensions: readonly EvidenceDimension[];
}

interface AdmittedEvidence {
  status: "admitted";
  provider: "google" | "cerebras";
  model: string;
  run: EvidenceRun & { complete: true };
}

interface GrandfatheredEvidence {
  status: "grandfathered";
  provider: "groq";
  model: string;
  reason: string;
  run: EvidenceRun & { complete: false };
}

export type AdmissionEvidence = AdmittedEvidence | GrandfatheredEvidence;

/**
 * Reviewed evidence, shaped for the committed pool marks in #957. Scores are the
 * real results, not a claim that every check was green.
 *
 * Gemini and Cerebras were re-run against the two-dimension set on 2026-07-27
 * (#1265). Groq could not be: its free tier rejects a single request of the
 * current turn outright — 12.000 tokens per minute against 13.017 requested — so
 * every question errored and its old mark stands, stating reading only (#1278).
 *
 * One of Cerebras's eighteen questions died on tokens-per-minute even at 55 s of
 * pacing, and a dead question scores zero. Its reading number is therefore a floor,
 * not a measurement of how well it reads.
 *
 * All three runs predate the `attachments` dimension (#1254), so no mark here says
 * anything about how its model behaves when the turn carries a document — the half of
 * the write path where PRD #1241's incident actually happened. Refreshing that is a
 * real re-run of the 22-question set, never an added line.
 */
export const ADMISSION_EVIDENCE = [
  {
    status: "admitted",
    provider: "google",
    model: "gemini-3.1-flash-lite",
    run: {
      evaluatedAt: "2026-07-27",
      complete: true,
      passed: 50,
      total: 65,
      executedQuestions: 18,
      totalQuestions: 18,
      dimensions: [
        { dimension: "reading", passed: 30, total: 42 },
        { dimension: "tool-discipline", passed: 20, total: 23 },
      ],
    },
  },
  {
    status: "admitted",
    provider: "cerebras",
    model: "gpt-oss-120b",
    run: {
      evaluatedAt: "2026-07-27",
      complete: true,
      passed: 49,
      total: 65,
      executedQuestions: 18,
      totalQuestions: 18,
      dimensions: [
        { dimension: "reading", passed: 32, total: 42 },
        { dimension: "tool-discipline", passed: 17, total: 23 },
      ],
    },
  },
  {
    status: "grandfathered",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    reason:
      "Titular anterior al gate: la revalidación agotó el TPD gratuito tras 6 de 12 preguntas.",
    run: {
      evaluatedAt: "2026-07-10",
      complete: false,
      passed: 11,
      total: 14,
      executedQuestions: 6,
      totalQuestions: 12,
      dimensions: [{ dimension: "reading", passed: 11, total: 14 }],
    },
  },
] as const satisfies readonly AdmissionEvidence[];
