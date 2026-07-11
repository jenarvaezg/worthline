import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

import type { EvalProvider } from "./candidate-config";

export function createEvalModel(
  provider: EvalProvider,
  modelId: string,
  apiKey: string,
): LanguageModel {
  switch (provider) {
    case "google":
      return createGoogle({ apiKey })(modelId);
    case "cerebras":
      return createCerebras({ apiKey })(modelId);
    case "groq":
      return createGroq({ apiKey })(modelId);
  }
}
