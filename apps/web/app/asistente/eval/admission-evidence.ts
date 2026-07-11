interface EvidenceRun {
  evaluatedAt: string;
  complete: boolean;
  passed: number;
  total: number;
  executedQuestions: number;
  totalQuestions: number;
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
 * Reviewed evidence from #841/#842, shaped for the committed pool marks in
 * #957. Scores are the real results, not a claim that every check was green.
 */
export const ADMISSION_EVIDENCE = [
  {
    status: "admitted",
    provider: "google",
    model: "gemini-3.1-flash-lite",
    run: {
      evaluatedAt: "2026-07-10",
      complete: true,
      passed: 27,
      total: 39,
      executedQuestions: 12,
      totalQuestions: 12,
    },
  },
  {
    status: "admitted",
    provider: "cerebras",
    model: "gpt-oss-120b",
    run: {
      evaluatedAt: "2026-07-10",
      complete: true,
      passed: 24,
      total: 39,
      executedQuestions: 12,
      totalQuestions: 12,
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
    },
  },
] as const satisfies readonly AdmissionEvidence[];
