import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

import {
  type AssistantProvider,
  availableProviderEntries,
  findAllowedProvider,
  type ProviderCredentialEnvKey,
  type ProviderEnvironment,
  providerCredentialEnvKey,
} from "./provider-pool";

export interface ProviderCandidate {
  provider: AssistantProvider;
  modelId: string;
}

export interface ResolvedProviderModel extends ProviderCandidate {
  credentialEnvKey: ProviderCredentialEnvKey;
  label: string;
  model: LanguageModel;
}

export function providerModelLabel(candidate: ProviderCandidate): string {
  return `${candidate.provider} · ${candidate.modelId}`;
}

function createProviderModel(
  candidate: ProviderCandidate,
  apiKey: string,
): LanguageModel {
  switch (candidate.provider) {
    case "google":
      return createGoogle({ apiKey })(candidate.modelId);
    case "cerebras":
      return createCerebras({ apiKey })(candidate.modelId);
    case "groq":
      return createGroq({ apiKey })(candidate.modelId);
  }
}

/**
 * Shared resolution seam for chat and eval: candidate, provider credential,
 * model construction, and stable label are resolved together. Pre-admission
 * eval candidates remain valid because allowlisting is a production option.
 */
export function resolveProviderModel(
  candidate: ProviderCandidate,
  env: ProviderEnvironment = process.env,
  options: { requireAdmission?: boolean } = {},
): ResolvedProviderModel | null {
  if (
    options.requireAdmission &&
    !findAllowedProvider(candidate.provider, candidate.modelId)
  ) {
    throw new Error("Provider/model pair is not in the validated allowlist.");
  }
  const credentialEnvKey = providerCredentialEnvKey(candidate.provider);
  const apiKey = env[credentialEnvKey];
  if (!apiKey?.trim()) return null;
  return {
    ...candidate,
    credentialEnvKey,
    label: providerModelLabel(candidate),
    model: createProviderModel(candidate, apiKey),
  };
}

export function resolveFirstAllowedProviderModel(
  env: ProviderEnvironment = process.env,
): ResolvedProviderModel | null {
  return resolveAllowedProviderModels(env)[0] ?? null;
}

/** Every credential-backed production candidate, in configured priority order. */
export function resolveAllowedProviderModels(
  env: ProviderEnvironment = process.env,
): readonly ResolvedProviderModel[] {
  return availableProviderEntries(env).flatMap((entry) => {
    const resolved = resolveProviderModel(entry, env, { requireAdmission: true });
    return resolved ? [resolved] : [];
  });
}
