import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import {
  type AssistantProvider,
  availableProviderEntries,
  isAdmittedProvider,
  OLLAMA_API_KEY_ENV_KEY,
  type ProviderCredentialEnvKey,
  type ProviderEnvironment,
  providerCredentialEnvKey,
  servedModelId,
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
  credentials: { apiKey?: string; baseURL?: string },
): LanguageModel {
  switch (candidate.provider) {
    case "google":
      return createGoogle({ apiKey: credentials.apiKey! })(candidate.modelId);
    case "cerebras":
      return createCerebras({ apiKey: credentials.apiKey! })(candidate.modelId);
    case "ollama":
      // Ollama's OpenAI-compatible endpoint: no API key by default (one is sent
      // only when the user configured it), and `includeUsage` stays off because
      // the local endpoint can reject the `stream_options` field it would send.
      // Token metering then records nothing for this provider, which the meter
      // already tolerates (ADR 0113).
      return createOpenAICompatible({
        name: "ollama",
        baseURL: credentials.baseURL!,
        ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
      })(candidate.modelId);
  }
}

/**
 * Shared resolution seam for chat and eval: candidate, provider credential,
 * model construction, and stable label are resolved together. Pre-admission
 * eval candidates remain valid because allowlisting is a production option.
 *
 * A self-hosted candidate's «credential» is its server base URL, present as
 * `WORTHLINE_OLLAMA_BASE_URL`; the API key is optional on top of it. The served
 * model is exactly the candidate's — env model selection is a POOL mapping
 * (`resolveAllowedProviderModels`), so an eval run measures precisely what its
 * `--model` names (ADR 0113).
 */
export function resolveProviderModel(
  candidate: ProviderCandidate,
  env: ProviderEnvironment = process.env,
  options: { requireAdmission?: boolean } = {},
): ResolvedProviderModel | null {
  if (options.requireAdmission && !isAdmittedProvider(candidate)) {
    throw new Error("Provider/model pair is not in the validated allowlist.");
  }
  const credentialEnvKey = providerCredentialEnvKey(candidate.provider);

  if (candidate.provider === "ollama") {
    const baseURL = env[credentialEnvKey]?.trim();
    if (!baseURL) return null;
    const apiKey = env[OLLAMA_API_KEY_ENV_KEY]?.trim();
    return {
      provider: candidate.provider,
      modelId: candidate.modelId,
      credentialEnvKey,
      label: providerModelLabel(candidate),
      model: createProviderModel(candidate, {
        baseURL,
        ...(apiKey ? { apiKey } : {}),
      }),
    };
  }

  const apiKey = env[credentialEnvKey];
  if (!apiKey?.trim()) return null;
  return {
    ...candidate,
    credentialEnvKey,
    label: providerModelLabel(candidate),
    model: createProviderModel(candidate, { apiKey }),
  };
}

export function resolveFirstAllowedProviderModel(
  env: ProviderEnvironment = process.env,
): ResolvedProviderModel | null {
  return resolveAllowedProviderModels(env)[0] ?? null;
}

/**
 * Every credential-backed production candidate, in configured priority order.
 * A self-hosted entry serves the model its env names (`WORTHLINE_OLLAMA_MODEL`)
 * instead of the committed reference tag, so the label, failover and metering
 * all describe what the request actually hits.
 */
export function resolveAllowedProviderModels(
  env: ProviderEnvironment = process.env,
): readonly ResolvedProviderModel[] {
  return availableProviderEntries(env).flatMap((entry) => {
    const candidate = {
      provider: entry.provider,
      modelId: servedModelId(entry, env),
    };
    const resolved = resolveProviderModel(candidate, env, { requireAdmission: true });
    return resolved ? [resolved] : [];
  });
}
