import { describe, expect, it } from "vitest";

import { chatModelLabel, resolveChatModel } from "./chat-model";

describe("chat model resolution", () => {
  it("resolves no model or label from an empty credential pool", () => {
    expect(resolveChatModel({})).toBeNull();
    expect(chatModelLabel({})).toBeNull();
  });

  it.each([
    [
      { GOOGLE_GENERATIVE_AI_API_KEY: "google-key" },
      "gemini-3.1-flash-lite",
      "google · gemini-3.1-flash-lite",
    ],
    [{ CEREBRAS_API_KEY: "cerebras-key" }, "gpt-oss-120b", "cerebras · gpt-oss-120b"],
    [
      { GROQ_API_KEY: "groq-key" },
      "llama-3.3-70b-versatile",
      "groq · llama-3.3-70b-versatile",
    ],
  ])("resolves one credential-backed candidate", (env, modelId, label) => {
    expect(resolveChatModel(env)).not.toBeNull();
    expect(chatModelLabel(env)).toBe(label);
    expect(label).toContain(modelId);
  });
});
