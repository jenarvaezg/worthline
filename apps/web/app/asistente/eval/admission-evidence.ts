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
   * so it states nothing about what they measure (ADR 0067). One such gap remains
   * today — `attachments`, absent from both marks, because both runs predate #1254.
   */
  dimensions: readonly EvidenceDimension[];
}

/**
 * The only shape a mark can have since #1278. There used to be a second,
 * `grandfathered`, carrying Groq as the incumbent from before the gate; retiring
 * that entry retired the exception with it, so «admitted» and «in the pool» are now
 * the same statement.
 */
interface AdmittedEvidence {
  status: "admitted";
  provider: "google" | "cerebras";
  model: string;
  run: EvidenceRun & { complete: true };
}

export type AdmissionEvidence = AdmittedEvidence;

/**
 * Reviewed evidence, shaped for the committed pool marks in #957. Scores are the
 * real results, not a claim that every check was green.
 *
 * Gemini and Cerebras were re-run against the two-dimension set on 2026-07-27
 * (#1265). Groq could not be, and is no longer in the pool (#1278): its free tier
 * rejects a single request of the current turn outright — 12.000 tokens per minute
 * against 14.285 measured on 2026-07-30 — so every question errored.
 *
 * One of Cerebras's eighteen questions died on tokens-per-minute even at 55 s of
 * pacing, and a dead question scores zero. Its reading number is therefore a floor,
 * not a measurement of how well it reads.
 *
 * Both runs predate the `attachments` dimension (#1254), so no mark here says
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
] as const satisfies readonly AdmissionEvidence[];
