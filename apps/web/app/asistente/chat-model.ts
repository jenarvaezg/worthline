import type { LanguageModel } from "ai";

import { resolveFirstAllowedProviderModel } from "./provider-model";

/**
 * Shared-baseline model resolution (ADR 0061): the first credential-backed
 * entry in the committed, validated provider pool. No visible model selector;
 * environment config may only reorder the admitted entries.
 */

export function resolveChatModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LanguageModel | null {
  return resolveFirstAllowedProviderModel(env)?.model ?? null;
}

/**
 * A human label for the resolved model — `provider · model-id` — so an eval run
 * (#668) names exactly what it measured and runs stay comparable. Null mirrors
 * `resolveChatModel`: no credential, nothing to evaluate.
 */
export function chatModelLabel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return resolveFirstAllowedProviderModel(env)?.label ?? null;
}
