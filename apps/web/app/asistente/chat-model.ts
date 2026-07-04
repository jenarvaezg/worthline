import { createGroq } from "@ai-sdk/groq";
import { gateway, type LanguageModel } from "ai";

/**
 * Shared-baseline model resolution (ADR 0050): Vercel AI Gateway when its key
 * is present (hosted — GROQ_API_KEY lives there as BYOK, spend ceiling
 * included), direct Groq via env credential otherwise (local dev, no gateway
 * dependency). Same `model` binding either way; no visible model selector —
 * the id is a server-side constant, env-overridable only.
 */

const DEFAULT_CHAT_MODEL = "groq/llama-3.3-70b-versatile";

export function resolveChatModel(): LanguageModel | null {
  const modelId = process.env["WORTHLINE_CHAT_MODEL"] ?? DEFAULT_CHAT_MODEL;

  if (process.env["AI_GATEWAY_API_KEY"]) {
    return gateway(modelId);
  }

  const groqKey = process.env["GROQ_API_KEY"];
  if (groqKey) {
    const groq = createGroq({ apiKey: groqKey });
    return groq(modelId.replace(/^groq\//, ""));
  }

  return null; // no shared credential — the route answers 503, never guesses
}

/**
 * A human label for the resolved model — `provider · model-id` — so an eval run
 * (#668) names exactly what it measured and runs stay comparable. Null mirrors
 * `resolveChatModel`: no credential, nothing to evaluate.
 */
export function chatModelLabel(): string | null {
  const modelId = process.env["WORTHLINE_CHAT_MODEL"] ?? DEFAULT_CHAT_MODEL;
  if (process.env["AI_GATEWAY_API_KEY"]) return `gateway · ${modelId}`;
  if (process.env["GROQ_API_KEY"]) return `groq · ${modelId.replace(/^groq\//, "")}`;
  return null;
}
