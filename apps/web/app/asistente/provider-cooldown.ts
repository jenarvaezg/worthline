import { providerErrorHeader, providerErrorText } from "./provider-error";
import type { ProviderFailureClassification } from "./provider-failover";

export interface ProviderCooldownState {
  provider: string;
  cooldownUntil: string;
}

const SHORT_QUOTA_COOLDOWN_MS = 60_000;
const UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;
const INVALID_CREDENTIAL_COOLDOWN_MS = 15 * 60_000;

function durationFromText(text: string): number | null {
  const proseMatch = text.match(
    /(?:try again|retry)(?:\s+after|\s+in)?\s+((?:\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)[,\s]*)+)/i,
  );
  const structuredMatch = text.match(
    /["']?(retryDelay|retry_delay|retryAfter|retry_after)["']?\s*:\s*["']?(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)?/i,
  );
  const structuredUnit = structuredMatch?.[3];
  const duration = proseMatch?.[1]
    ? proseMatch[1]
    : structuredMatch?.[2] && structuredUnit
      ? `${structuredMatch[2]}${structuredUnit}`
      : structuredMatch?.[2] &&
          structuredMatch[1]?.toLowerCase().replace("_", "") === "retryafter"
        ? `${structuredMatch[2]}s`
        : null;
  if (!duration) return null;
  let total = 0;
  const units =
    /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gi;
  for (const part of duration.matchAll(units)) {
    const amount = Number(part[1]);
    const unit = part[2]!.toLowerCase();
    const multiplier = unit.startsWith("d")
      ? 86_400_000
      : unit.startsWith("h")
        ? 3_600_000
        : unit === "ms" || unit.startsWith("mill") || unit.startsWith("msec")
          ? 1
          : unit.startsWith("m")
            ? 60_000
            : unit.startsWith("s")
              ? 1_000
              : 1;
    total += amount * multiplier;
  }
  return total > 0 ? total : null;
}

function explicitCooldownMs(error: unknown, now: Date): number | null {
  const retryAfterMs = Number(providerErrorHeader(error, "retry-after-ms"));
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;

  const retryAfter = providerErrorHeader(error, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
    const resetAt = Date.parse(retryAfter);
    if (Number.isFinite(resetAt) && resetAt > now.getTime()) {
      return resetAt - now.getTime();
    }
  }
  return durationFromText(providerErrorText(error));
}

function nextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

/** Pure provider-reset policy. Request shape failures deliberately return null. */
export function deriveProviderCooldownUntil(
  error: unknown,
  classification: ProviderFailureClassification,
  now: Date = new Date(),
): Date | null {
  if (classification === "request_too_large") return null;

  const explicitMs = explicitCooldownMs(error, now);
  if (explicitMs !== null) return new Date(now.getTime() + explicitMs);

  if (classification === "quota_exhausted") {
    if (
      /tokens? per day|requests? per day|\btpd\b|daily (?:quota|limit)/i.test(
        providerErrorText(error),
      )
    ) {
      return nextUtcDay(now);
    }
    return new Date(now.getTime() + SHORT_QUOTA_COOLDOWN_MS);
  }
  const defaultMs =
    classification === "invalid_credential"
      ? INVALID_CREDENTIAL_COOLDOWN_MS
      : UNAVAILABLE_COOLDOWN_MS;
  return new Date(now.getTime() + defaultMs);
}

/** Strict priority with active entries omitted; equality means expired. */
export function providersOutsideCooldown<Provider extends { provider: string }>(
  providers: readonly Provider[],
  cooldowns: readonly ProviderCooldownState[],
  now: Date = new Date(),
): readonly Provider[] {
  const active = new Set(
    cooldowns
      .filter(({ cooldownUntil }) => Date.parse(cooldownUntil) > now.getTime())
      .map(({ provider }) => provider),
  );
  return providers.filter(({ provider }) => !active.has(provider));
}
