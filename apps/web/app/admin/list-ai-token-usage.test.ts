import type { AiDailyTokenUsage, UsageLimits } from "@worthline/db";
import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_TOKEN_USAGE_WINDOW_DAYS,
  listAdminAiTokenUsage,
  tokenUsageSinceDayKey,
} from "./list-ai-token-usage";

describe("tokenUsageSinceDayKey", () => {
  it("spans the day of now and the days before it, inclusive", () => {
    // A 14-day window ending 2026-07-22 floors at 2026-07-09 (today + 13 prior).
    expect(tokenUsageSinceDayKey("2026-07-22T18:00:00.000Z", 14)).toBe("2026-07-09");
  });

  it("floors at today itself for a one-day window", () => {
    expect(tokenUsageSinceDayKey("2026-07-22T00:00:00.000Z", 1)).toBe("2026-07-22");
  });
});

describe("listAdminAiTokenUsage", () => {
  it("reads the global daily series from the window floor via the injected port", async () => {
    const series: AiDailyTokenUsage[] = [
      { dayKey: "2026-07-22", tokens: 1200 },
      { dayKey: "2026-07-21", tokens: 800 },
    ];
    const readRecentGlobalAiTokenUsage = vi.fn().mockResolvedValue(series);
    const store: Pick<UsageLimits, "readRecentGlobalAiTokenUsage"> = {
      readRecentGlobalAiTokenUsage,
    };

    const result = await listAdminAiTokenUsage(
      "2026-07-22T18:00:00.000Z",
      ADMIN_TOKEN_USAGE_WINDOW_DAYS,
      store,
    );

    expect(result).toEqual(series);
    expect(readRecentGlobalAiTokenUsage).toHaveBeenCalledWith("2026-07-09");
  });
});
