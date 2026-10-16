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
      resolveProviderModel({ provider: "cerebras", modelId: "candidate" }, {}),
    ).toBeNull();
    expect(resolveFirstAllowedProviderModel({})).toBeNull();
  });

  it("resolves every credential-backed candidate in strict pool order", () => {
    expect(
      resolveAllowedProviderModels({
        GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
        CEREBRAS_API_KEY: "cerebras-key",
        WORTHLINE_CHAT_PROVIDER_ORDER: "cerebras,google",
      }).map(({ provider, modelId }) => ({ provider, modelId })),
    ).toEqual([
      { provider: "cerebras", modelId: "gpt-oss-120b" },
      { provider: "google", modelId: "gemini-3.5-flash-lite" },
    ]);
  });
});

describe("self-hosted ollama resolution (ADR 0113)", () => {
  const baseURL = "http://127.0.0.1:51335/v1";

  it("activates on the base URL alone, without an API key", () => {
    expect(
      resolveProviderModel(
        { provider: "ollama", modelId: "llama3.2:3b" },
        { WORTHLINE_OLLAMA_BASE_URL: baseURL },
      ),
    ).toMatchObject({
      provider: "ollama",
      modelId: "llama3.2:3b",
      credentialEnvKey: "WORTHLINE_OLLAMA_BASE_URL",
      label: "ollama · llama3.2:3b",
    });
  });

  it("returns null when the server base URL is absent", () => {
    expect(
      resolveProviderModel({ provider: "ollama", modelId: "llama3.2:3b" }, {}),
    ).toBeNull();
    expect(
      resolveProviderModel(
        { provider: "ollama", modelId: "llama3.2:3b" },
        { WORTHLINE_OLLAMA_API_KEY: "token" },
      ),
    ).toBeNull();
  });

  it("serves the model named by WORTHLINE_OLLAMA_MODEL instead of the reference tag", () => {
    expect(
      resolveAllowedProviderModels({
        WORTHLINE_OLLAMA_BASE_URL: baseURL,
        WORTHLINE_OLLAMA_MODEL: "qwen2.5:14b",
      }).map(({ provider, modelId, label }) => ({ provider, modelId, label })),
    ).toEqual([
      { provider: "ollama", modelId: "qwen2.5:14b", label: "ollama · qwen2.5:14b" },
    ]);
  });

  it("admits the provider slot for any served tag, not just the reference pair", () => {
    expect(
      resolveProviderModel(
        { provider: "ollama", modelId: "some-local-tag" },
        { WORTHLINE_OLLAMA_BASE_URL: baseURL },
        { requireAdmission: true },
      ),
    ).toMatchObject({ provider: "ollama", modelId: "some-local-tag" });
    expect(() =>
      resolveProviderModel(
        { provider: "cerebras", modelId: "some-local-tag" },
        { CEREBRAS_API_KEY: "key" },
        { requireAdmission: true },
      ),
    ).toThrow(/allowlist/i);
  });

  it("resolves the explicit eval candidate from a configured server", () => {
    expect(
      resolveProviderModel(
        { provider: "ollama", modelId: "eval-candidate" },
        { WORTHLINE_OLLAMA_BASE_URL: baseURL },
      ),
    ).toMatchObject({ provider: "ollama", modelId: "eval-candidate" });
  });
});
