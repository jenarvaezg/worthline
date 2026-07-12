import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import {
  deriveProviderCooldownUntil,
  providersOutsideCooldown,
} from "./provider-cooldown";

const NOW = new Date("2026-07-12T10:00:00.000Z");

function apiError(
  message: string,
  responseHeaders?: Record<string, string>,
  data?: unknown,
): APICallError {
  return new APICallError({
    message,
    url: "https://provider.invalid/chat",
    requestBodyValues: {},
    statusCode: 429,
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

describe("deriveProviderCooldownUntil", () => {
  it.each([
    [apiError("quota exhausted", { "retry-after-ms": "2500" }), 2_500],
    [apiError("quota exhausted", { "retry-after": "45" }), 45_000],
    [apiError("try again in 2m 15s"), 135_000],
  ])("honours provider reset information", (error, expectedMs) => {
    expect(deriveProviderCooldownUntil(error, "quota_exhausted", NOW)?.getTime()).toBe(
      NOW.getTime() + expectedMs,
    );
  });

  it("accepts an HTTP-date Retry-After", () => {
    const reset = "Sun, 12 Jul 2026 10:03:00 GMT";
    expect(
      deriveProviderCooldownUntil(
        apiError("quota exhausted", { "retry-after": reset }),
        "quota_exhausted",
        NOW,
      )?.toISOString(),
    ).toBe("2026-07-12T10:03:00.000Z");
  });

  it("derives reset time from structured provider error data", () => {
    expect(
      deriveProviderCooldownUntil(
        apiError("quota exhausted", undefined, {
          error: { detail: "Please try again in 3m 5s." },
        }),
        "quota_exhausted",
        NOW,
      )?.toISOString(),
    ).toBe("2026-07-12T10:03:05.000Z");
  });

  it.each([
    [{ retryDelay: "20s" }, "2026-07-12T10:00:20.000Z"],
    [{ retry_after: "2m" }, "2026-07-12T10:02:00.000Z"],
    [{ retryAfter: 30 }, "2026-07-12T10:00:30.000Z"],
  ])("derives reset time from canonical structured retry fields", (data, expected) => {
    expect(
      deriveProviderCooldownUntil(
        apiError("quota exhausted", undefined, data),
        "quota_exhausted",
        NOW,
      )?.toISOString(),
    ).toBe(expected);
  });

  it("defaults daily quota failures to the next UTC reset", () => {
    expect(
      deriveProviderCooldownUntil(
        apiError("tokens per day limit reached"),
        "quota_exhausted",
        NOW,
      )?.toISOString(),
    ).toBe("2026-07-13T00:00:00.000Z");
  });

  it("uses a short default for quota windows without reset information", () => {
    expect(
      deriveProviderCooldownUntil(
        apiError("tokens per minute limit reached"),
        "quota_exhausted",
        NOW,
      )?.toISOString(),
    ).toBe("2026-07-12T10:01:00.000Z");
  });

  it("never persists request-too-large failures", () => {
    expect(
      deriveProviderCooldownUntil(
        apiError("request too large"),
        "request_too_large",
        NOW,
      ),
    ).toBeNull();
  });
});

describe("providersOutsideCooldown", () => {
  const providers = [
    { provider: "google", modelId: "gemini" },
    { provider: "cerebras", modelId: "gpt-oss" },
  ] as const;

  it("skips active cooldowns and automatically restores expired entries", () => {
    const cooldowns = [
      {
        provider: "google",
        cooldownUntil: "2026-07-12T10:00:01.000Z",
      },
    ];

    expect(
      providersOutsideCooldown(providers, cooldowns, NOW).map((p) => p.provider),
    ).toEqual(["cerebras"]);
    expect(
      providersOutsideCooldown(
        providers,
        cooldowns,
        new Date("2026-07-12T10:00:01.000Z"),
      ).map((p) => p.provider),
    ).toEqual(["google", "cerebras"]);
  });
});
