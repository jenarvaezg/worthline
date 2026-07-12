import { describe, expect, it } from "vitest";

import {
  candidatePolicy,
  parseEvalArgs,
  shouldStopAfterProviderError,
} from "./candidate-config";

describe("parseEvalArgs", () => {
  it("selects provider and model explicitly without production configuration", () => {
    expect(
      parseEvalArgs([
        "--provider",
        "google",
        "--model",
        "gemini-3.1-flash-lite",
        "--threshold",
        "0.7",
        "--output",
        "run.json",
      ]),
    ).toEqual({
      provider: "google",
      model: "gemini-3.1-flash-lite",
      threshold: 0.7,
      output: "run.json",
    });
  });

  it("requires both provider and model", () => {
    expect(() => parseEvalArgs(["--provider", "groq"])).toThrow(/--model/);
    expect(() => parseEvalArgs(["--model", "llama-3.3-70b-versatile"])).toThrow(
      /--provider/,
    );
  });

  it("rejects unsupported providers and invalid thresholds", () => {
    expect(() => parseEvalArgs(["--provider", "unknown", "--model", "model"])).toThrow(
      /provider/i,
    );
    expect(() =>
      parseEvalArgs(["--provider", "groq", "--model", "model", "--threshold", "1.1"]),
    ).toThrow(/threshold/i);
  });
});

describe("candidatePolicy", () => {
  it("paces multi-step turns for each provider's free-tier request limit", () => {
    expect(candidatePolicy("google")).toEqual({
      delayBetweenQuestionsMs: 20_000,
    });
    expect(candidatePolicy("cerebras")).toEqual({
      delayBetweenQuestionsMs: 55_000,
    });
    expect(candidatePolicy("groq")).toEqual({
      delayBetweenQuestionsMs: 8_000,
    });
  });
});

describe("shouldStopAfterProviderError", () => {
  it("stops a run when provider quota is exhausted", () => {
    expect(
      shouldStopAfterProviderError({
        statusCode: 429,
        message: "tokens per day exhausted",
      }),
    ).toBe(true);
  });

  it("keeps evaluating after a request-specific size rejection", () => {
    expect(
      shouldStopAfterProviderError({
        statusCode: 429,
        message: "request too large for model on tokens per minute",
      }),
    ).toBe(false);
  });

  it("keeps evaluating independent provider errors", () => {
    expect(
      shouldStopAfterProviderError({ statusCode: 500, message: "temporary error" }),
    ).toBe(false);
  });
});
