import {
  MISSED_PASS_REPORT_LIMIT,
  missedDailyCapturePasses,
  parseDailyCapturePass,
} from "@db/daily-capture-gap";
import { describe, expect, test } from "vitest";

describe("parseDailyCapturePass (#1339)", () => {
  test("splits a run key into its day and pass", () => {
    expect(parseDailyCapturePass("2026-07-28:am")).toMatchObject({
      dateKey: "2026-07-28",
      pass: "am",
    });
    expect(parseDailyCapturePass("2026-07-28:pm")).toMatchObject({
      dateKey: "2026-07-28",
      pass: "pm",
    });
  });

  test("orders the two daily passes and consecutive days by ordinal", () => {
    const am = parseDailyCapturePass("2026-07-28:am")!.ordinal;
    const pm = parseDailyCapturePass("2026-07-28:pm")!.ordinal;
    const nextAm = parseDailyCapturePass("2026-07-29:am")!.ordinal;
    expect(pm).toBe(am + 1);
    expect(nextAm).toBe(pm + 1);
  });

  test("rejects a key with no pass, a bad calendar date, and junk", () => {
    // A pass-less key is a pre-#895 ledger row, not a pass: callers degrade.
    expect(parseDailyCapturePass("2026-07-28")).toBeNull();
    // Date.UTC would roll this over into 2027 — the round-trip catches it.
    expect(parseDailyCapturePass("2026-13-45:pm")).toBeNull();
    expect(parseDailyCapturePass("2026-02-30:am")).toBeNull();
    expect(parseDailyCapturePass("nonsense")).toBeNull();
  });
});

describe("missedDailyCapturePasses (#1339)", () => {
  test("reports nothing when the immediately previous pass was invoked", () => {
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-07-30:pm",
        latestInvokedRunKey: "2026-07-30:am",
      }),
    ).toEqual({ missed: [], omitted: 0 });
  });

  test("reports the single pass that was never invoked", () => {
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-07-30:am",
        latestInvokedRunKey: "2026-07-29:am",
      }),
    ).toEqual({ missed: ["2026-07-29:pm"], omitted: 0 });
  });

  test("reports every pass in a multi-day gap, oldest first", () => {
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-07-30:am",
        latestInvokedRunKey: "2026-07-28:am",
      }),
    ).toEqual({
      missed: ["2026-07-28:pm", "2026-07-29:am", "2026-07-29:pm"],
      omitted: 0,
    });
  });

  test("crosses month, year, and leap-day boundaries", () => {
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-01-01:am",
        latestInvokedRunKey: "2025-12-31:am",
      }).missed,
    ).toEqual(["2025-12-31:pm"]);
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2024-03-01:am",
        latestInvokedRunKey: "2024-02-29:am",
      }).missed,
    ).toEqual(["2024-02-29:pm"]);
  });

  test("reports nothing on a fresh deploy with no baseline", () => {
    // No history means nothing was MISSED — the fleet simply has none yet.
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-07-30:am",
        latestInvokedRunKey: null,
      }),
    ).toEqual({ missed: [], omitted: 0 });
  });

  test("reports nothing when the baseline is at or ahead of this pass", () => {
    // A redelivered/replayed pass (or clock skew) must never invent a gap.
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-07-30:am",
        latestInvokedRunKey: "2026-07-30:am",
      }),
    ).toEqual({ missed: [], omitted: 0 });
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-07-30:am",
        latestInvokedRunKey: "2026-07-31:pm",
      }),
    ).toEqual({ missed: [], omitted: 0 });
  });

  test("keeps the most recent passes and counts the older ones it dropped", () => {
    // A month-long outage must not raise a month of alerts: the cap keeps the
    // freshest passes and reports how many older ones it left out.
    const { missed, omitted } = missedDailyCapturePasses({
      currentRunKey: "2026-07-30:am",
      latestInvokedRunKey: "2026-06-30:am",
    });
    expect(missed).toHaveLength(MISSED_PASS_REPORT_LIMIT);
    expect(missed.at(-1)).toBe("2026-07-29:pm");
    expect(missed.at(0)).toBe("2026-07-26:am");
    // 2026-06-30:pm … 2026-07-29:pm is 59 passes; 8 reported, 51 dropped.
    expect(omitted).toBe(51);
  });

  test("reports nothing for unparseable keys instead of throwing", () => {
    expect(
      missedDailyCapturePasses({
        currentRunKey: "nonsense",
        latestInvokedRunKey: "2026-07-29:pm",
      }),
    ).toEqual({ missed: [], omitted: 0 });
    expect(
      missedDailyCapturePasses({
        currentRunKey: "2026-07-30:am",
        // A pre-#895 bare date: no pass to compare against, so stay silent.
        latestInvokedRunKey: "2026-07-29",
      }),
    ).toEqual({ missed: [], omitted: 0 });
  });
});
