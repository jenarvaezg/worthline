import { describe, expect, it, vi } from "vitest";

import { admitFeedbackSend, FEEDBACK_SENDS_PER_HOUR } from "./feedback-rate-limit";

const NOW = "2026-10-11T10:42:00.000Z";

describe("admitFeedbackSend (#1174)", () => {
  it("counts per workspace in a fixed UTC-hour window", async () => {
    const record = vi.fn().mockResolvedValue(1);

    await admitFeedbackSend("ws-ana", { now: NOW, record });

    expect(record).toHaveBeenCalledWith("ws:ws-ana", "2026-10-11T10");
  });

  it("admits up to the limit and refuses the send after it", async () => {
    const at = (count: number) =>
      admitFeedbackSend("ws-ana", { now: NOW, record: vi.fn().mockResolvedValue(count) });

    expect(await at(FEEDBACK_SENDS_PER_HOUR)).toBe("ok");
    expect(await at(FEEDBACK_SENDS_PER_HOUR + 1)).toBe("limited");
  });

  it("holds the limit under concurrent sends — each one gets its own count", async () => {
    // The counter hands back a distinct running total per call (the upsert-returning
    // statement), so N concurrent sends at the boundary admit exactly the remainder.
    let running = FEEDBACK_SENDS_PER_HOUR - 2;
    const record = vi.fn(async () => {
      running += 1;
      return running;
    });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => admitFeedbackSend("ws-ana", { now: NOW, record })),
    );

    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === "limited")).toHaveLength(3);
  });

  it("lets the message through when the counter cannot be read, and says so", async () => {
    // Failing open on purpose: the counter lives in the same control plane as the
    // alert, so when it is down the email may be the only copy left — and a
    // counter outage is not a reason to drop a real user's message.
    const log = { error: vi.fn() };

    expect(
      await admitFeedbackSend("ws-ana", {
        log,
        now: NOW,
        record: vi.fn().mockRejectedValue(new Error("libsql down")),
      }),
    ).toBe("ok");
    expect(log.error).toHaveBeenCalled();
    expect(
      await admitFeedbackSend("ws-ana", {
        now: NOW,
        record: vi.fn().mockResolvedValue(null),
      }),
    ).toBe("ok");
  });
});
