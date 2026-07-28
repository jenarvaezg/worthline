import type { UsageLimits, VisionCallDailyUsage } from "@worthline/db";
import { describe, expect, it, vi } from "vitest";

import { ADMIN_TOKEN_USAGE_WINDOW_DAYS } from "./list-ai-token-usage";
import { listAdminVisionCallUsage } from "./list-vision-call-usage";

describe("listAdminVisionCallUsage", () => {
  it("reads the global daily reading series from the window floor via the injected port", async () => {
    const series: VisionCallDailyUsage[] = [
      { dayKey: "2026-07-28", calls: 12 },
      { dayKey: "2026-07-27", calls: 3 },
    ];
    const readRecentGlobalVisionCallUsage = vi.fn().mockResolvedValue(series);
    const store: Pick<UsageLimits, "readRecentGlobalVisionCallUsage"> = {
      readRecentGlobalVisionCallUsage,
    };

    const result = await listAdminVisionCallUsage(
      "2026-07-28T18:00:00.000Z",
      ADMIN_TOKEN_USAGE_WINDOW_DAYS,
      store,
    );

    expect(result).toEqual(series);
    // Same 14-day floor as the token series, so the two sections read the same window.
    expect(readRecentGlobalVisionCallUsage).toHaveBeenCalledWith("2026-07-15");
  });
});
