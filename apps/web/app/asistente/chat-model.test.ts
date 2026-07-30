import { describe, expect, it } from "vitest";

import { chatModelLabel, resolveChatModel, resolveChatModels } from "./chat-model";

describe("chat model resolution", () => {
  it("resolves no model or label from an empty credential pool", () => {
    expect(resolveChatModel({})).toBeNull();
    expect(resolveChatModels({})).toEqual([]);
    expect(chatModelLabel({})).toBeNull();
  });

  it("resolves the whole ordered production pool for failover", () => {
    expect(
      resolveChatModels({
        GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
        CEREBRAS_API_KEY: "cerebras-key",
        WORTHLINE_CHAT_PROVIDER_ORDER: "cerebras,google",
      }).map(({ provider }) => provider),
    ).toEqual(["cerebras", "google"]);
  });

  it.each([
    [
      { GOOGLE_GENERATIVE_AI_API_KEY: "google-key" },
      "gemini-3.1-flash-lite",
      "google · gemini-3.1-flash-lite",
    ],
    [{ CEREBRAS_API_KEY: "cerebras-key" }, "gpt-oss-120b", "cerebras · gpt-oss-120b"],
  ])("resolves one credential-backed candidate", (env, modelId, label) => {
    expect(resolveChatModel(env)).not.toBeNull();
    expect(chatModelLabel(env)).toBe(label);
    expect(label).toContain(modelId);
  });
});
