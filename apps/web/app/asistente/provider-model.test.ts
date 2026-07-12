import { describe, expect, it } from "vitest";
import {
  resolveAllowedProviderModels,
  resolveFirstAllowedProviderModel,
  resolveProviderModel,
} from "./provider-model";
import { DEFAULT_PROVIDER_ALLOWLIST } from "./provider-pool";

describe("shared provider model resolution", () => {
  it.each(
    DEFAULT_PROVIDER_ALLOWLIST,
  )("resolves the explicit $provider eval candidate with credential and label", ({
    provider,
    modelId,
    envKey,
  }) => {
    const resolved = resolveProviderModel(
      { provider, modelId },
      { [envKey]: "test-key" },
    );

    expect(resolved).toMatchObject({
      provider,
      modelId,
      credentialEnvKey: envKey,
      label: `${provider} · ${modelId}`,
    });
    expect(resolved?.model).toBeDefined();
  });

  it("allows eval to resolve an explicit pre-admission model", () => {
    expect(
      resolveProviderModel(
        { provider: "google", modelId: "gemini-next-candidate" },
        { GOOGLE_GENERATIVE_AI_API_KEY: "test-key" },
      ),
    ).toMatchObject({
      provider: "google",
      modelId: "gemini-next-candidate",
      label: "google · gemini-next-candidate",
    });
  });

  it("keeps arbitrary candidates outside production resolution", () => {
    expect(() =>
      resolveProviderModel(
        { provider: "google", modelId: "gemini-unreviewed" },
        { GOOGLE_GENERATIVE_AI_API_KEY: "test-key" },
        { requireAdmission: true },
      ),
    ).toThrow(/allowlist/i);
  });

  it("resolves the first credential-backed allowlisted candidate for chat", () => {
    expect(
      resolveFirstAllowedProviderModel({
        CEREBRAS_API_KEY: "cerebras-key",
        GROQ_API_KEY: "groq-key",
      }),
    ).toMatchObject({
      provider: "cerebras",
      modelId: "gpt-oss-120b",
      credentialEnvKey: "CEREBRAS_API_KEY",
      label: "cerebras · gpt-oss-120b",
    });
  });

  it("returns null when the candidate credential is absent", () => {
    expect(
      resolveProviderModel({ provider: "groq", modelId: "candidate" }, {}),
    ).toBeNull();
    expect(resolveFirstAllowedProviderModel({})).toBeNull();
  });

  it("resolves every credential-backed candidate in strict pool order", () => {
    expect(
      resolveAllowedProviderModels({
        GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
        CEREBRAS_API_KEY: "cerebras-key",
        GROQ_API_KEY: "groq-key",
        WORTHLINE_CHAT_PROVIDER_ORDER: "cerebras,google",
      }).map(({ provider, modelId }) => ({ provider, modelId })),
    ).toEqual([
      { provider: "cerebras", modelId: "gpt-oss-120b" },
      { provider: "google", modelId: "gemini-3.1-flash-lite" },
      { provider: "groq", modelId: "llama-3.3-70b-versatile" },
    ]);
  });
});
