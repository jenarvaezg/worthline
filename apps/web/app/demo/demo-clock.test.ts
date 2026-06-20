import { afterEach, describe, expect, it, vi } from "vitest";

import { demoAsOfDateKey, demoNowDate } from "@web/demo/demo-clock";

describe("demo clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves a configured date-only day at demo noon", () => {
    expect(demoAsOfDateKey("2026-06-20")).toBe("2026-06-20");
    expect(demoNowDate("2026-06-20").toISOString()).toBe("2026-06-20T12:00:00.000Z");
  });

  it("preserves the written calendar day even when the ISO offset crosses UTC", () => {
    expect(demoAsOfDateKey("2026-06-20T00:30:00+02:00")).toBe("2026-06-20");
    expect(demoNowDate("2026-06-20T00:30:00+02:00").toISOString()).toBe(
      "2026-06-20T12:00:00.000Z",
    );
  });

  it("falls back to the current local day when no valid demo date is configured", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 20, 0, 30, 0));

    expect(demoAsOfDateKey("")).toBe("2026-06-20");
    expect(demoAsOfDateKey("not a date")).toBe("2026-06-20");
  });
});
