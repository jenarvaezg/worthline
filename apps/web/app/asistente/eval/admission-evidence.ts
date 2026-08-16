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
   * today — `attachments` on the Cerebras mark, whose run predates #1254.
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
 * Groq is not here and is no longer in the pool (#1278): its free tier rejects a
 * single request of the current turn outright — 12.000 tokens per minute against
 * 14.285 measured on 2026-07-30 — so every question errored.
 *
 * **Gemini, 2026-08-03 (#1342).** The first mark from the full 22-question,
 * three-dimension set, re-run because the system prompt and the tool contract both
 * changed, which is ADR 0061's own revalidation trigger. It is also the first mark
 * that says anything about `attachments` (#1254) — the half of the write path where
 * PRD #1241's incident actually happened.
 *
 * That run is one of three taken the same day, and the other two are why a −4 swing
 * is read as variance rather than as a slimmed prompt losing a rule: `main` scored
 * 61/83 (reading 29, tool-discipline 18, attachments 14) and an earlier build of the
 * same slice 57/83 (27/16/14), so the slice spans 57–62 with `main` in the middle.
 * Check by check, no rule-shaped check changed state — the swing sits in
 * `responde en español`, a marker-count grader on prose that moved in BOTH
 * directions between the two runs, and the two rule checks that do fail
 * (`normaliza la magnitud`, `no reconstruye … una serie que nadie ha validado`) fail
 * on `main` too. Single samples, so this bounds the noise; it does not prove the
 * absence of a small regression.
 *
 * **Cerebras, 2026-07-27 — REVALIDATION PENDING.** #1342 changed the same prompt and
 * tool contract for this entry too, so this mark is stale by ADR 0061's rule and is
 * knowingly carried, not overlooked. Two attempts on 2026-08-03 could not produce a
 * complete run: the first reached 20 of 22 questions before the process died, and the
 * second lost four of its first six to «Tokens per minute limit exceeded» even at 55 s
 * of pacing, because the day's earlier runs had spent the free-tier allowance. A mark
 * from either would be a mark from an incomplete run, which this file must never
 * carry. Re-run it on a fresh allowance; nothing else in the pool depends on the
 * result, since Gemini is the first entry in every environment.
 *
 * The mark below therefore still describes the July prompt, and one of its eighteen
 * questions died on tokens-per-minute back then as well — a dead question scores
 * zero, so its reading number is a floor rather than a measurement of how well it
 * reads. It says nothing about `attachments` either: that dimension did not exist.
 *
 * **Both marks are stale as of #1376**, which added a 23rd question and took the set
 * to 91 checks (`attachments` from 18 to 26). Their totals describe the sets they were
 * measured on and are left exactly as measured: a mark is a run, and editing one in
 * place would turn a record into a claim.
 */
export const ADMISSION_EVIDENCE = [
  {
    status: "admitted",
    provider: "google",
    model: "gemini-3.1-flash-lite",
    run: {
      evaluatedAt: "2026-08-03",
      complete: true,
      passed: 62,
      total: 83,
      executedQuestions: 22,
      totalQuestions: 22,
      dimensions: [
        { dimension: "reading", passed: 28, total: 42 },
        { dimension: "tool-discipline", passed: 18, total: 23 },
        { dimension: "attachments", passed: 16, total: 18 },
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
