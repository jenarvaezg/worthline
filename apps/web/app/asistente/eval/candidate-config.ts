import { type AssistantProvider, PROVIDERS } from "@web/asistente/provider-pool";

import { DEFAULT_ADMISSION_THRESHOLD } from "./admission";

export type EvalProvider = AssistantProvider;

export interface EvalArgs {
  provider: EvalProvider;
  model: string;
  threshold: number;
  output?: string;
}

const POLICIES: Record<EvalProvider, { delayBetweenQuestionsMs: number }> = {
  google: { delayBetweenQuestionsMs: 20_000 },
  cerebras: { delayBetweenQuestionsMs: 55_000 },
  groq: { delayBetweenQuestionsMs: 8_000 },
};

export function candidatePolicy(provider: EvalProvider) {
  return POLICIES[provider];
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function isEvalProvider(value: string): value is EvalProvider {
  return PROVIDERS.some((provider) => provider === value);
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const providerValue = valueAfter(argv, "--provider");
  if (!providerValue) throw new Error("--provider is required.");
  if (!isEvalProvider(providerValue)) {
    throw new Error(`Unsupported provider: ${providerValue}.`);
  }

  const model = valueAfter(argv, "--model");
  if (!model) throw new Error("--model is required.");

  const thresholdValue = valueAfter(argv, "--threshold");
  const threshold = thresholdValue
    ? Number.parseFloat(thresholdValue)
    : DEFAULT_ADMISSION_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be a number between 0 and 1.");
  }

  const output = valueAfter(argv, "--output");
  return { provider: providerValue, model, threshold, ...(output ? { output } : {}) };
}

export function shouldStopAfterProviderError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { statusCode?: unknown; message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (/request too large/i.test(message)) return false;
  return (
    candidate.statusCode === 429 ||
    /too many requests|rate limit|quota|tokens per day/i.test(message)
  );
}
