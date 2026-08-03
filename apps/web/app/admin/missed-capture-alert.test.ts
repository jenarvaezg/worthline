import { describe, expect, it } from "vitest";

import {
  buildMissedCaptureAlerts,
  dailyCapturePassLabel,
  isMissedCapturePayload,
  MISSED_CAPTURE_ALERT_WORKSPACE_ID,
  maintainerAlertSubject,
  missedCapturePassFromHoldingId,
} from "./missed-capture-alert";

const REPORT = {
  missed: ["2026-07-28:pm", "2026-07-29:am"],
  omitted: 0,
  detectedByRunKey: "2026-07-29:pm",
  latestInvokedRunKey: "2026-07-28:am",
  detectedAt: "2026-07-29T21:04:00.000Z",
};

describe("dailyCapturePassLabel (#1339)", () => {
  it("names both passes of a day in Spanish", () => {
    expect(dailyCapturePassLabel("2026-07-28:am")).toBe(
      "28-07-2026, captura de mañana (≈09:00 UTC)",
    );
    expect(dailyCapturePassLabel("2026-07-28:pm")).toBe(
      "28-07-2026, captura de tarde (≈21:00 UTC)",
    );
  });

  it("degrades to the raw key when the parser rejects it", () => {
    expect(dailyCapturePassLabel("2026-07-28")).toBe("2026-07-28");
    expect(dailyCapturePassLabel("nonsense")).toBe("nonsense");
  });
});

describe("buildMissedCaptureAlerts (#1339)", () => {
  it("mints one fleet-keyed alert per missed pass", () => {
    const alerts = buildMissedCaptureAlerts(REPORT);

    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.holdingId)).toEqual([
      "daily-capture:2026-07-28:pm",
      "daily-capture:2026-07-29:am",
    ]);
    for (const alert of alerts) {
      // Fleet-wide: no tenant owns this alert, and the category is the one no
      // model can raise.
      expect(alert.workspaceId).toBe(MISSED_CAPTURE_ALERT_WORKSPACE_ID);
      expect(alert.category).toBe("missed_capture");
      // The occurrence is stamped when the gap was noticed, not "now".
      expect(alert.occurredAt).toBe(REPORT.detectedAt);
    }
  });

  it("carries the forensic facts of the gap in the payload", () => {
    const [first] = buildMissedCaptureAlerts(REPORT);

    expect(first?.payload).toMatchObject({
      category: "missed_capture",
      missedRunKey: "2026-07-28:pm",
      latestInvokedRunKey: "2026-07-28:am",
      detectedByRunKey: "2026-07-29:pm",
      detectedAt: "2026-07-29T21:04:00.000Z",
      omittedOlderPasses: 0,
    });
    // The summary names the pass in words and makes the NARROW claim the baseline
    // supports: the invocation never arrived, so nothing was even enqueued.
    expect(first?.payload.summary).toContain("28-07-2026, captura de tarde");
    expect(first?.payload.summary).toMatch(/nunca se invocó/i);
    expect(first?.payload.summary).toMatch(/no se encoló/i);
  });

  it("says out loud how many older passes the cap left out", () => {
    const [first] = buildMissedCaptureAlerts({ ...REPORT, omitted: 51 });

    expect(first?.payload.omittedOlderPasses).toBe(51);
    expect(first?.payload.summary).toContain("51");
  });

  it("mints nothing for an empty report", () => {
    expect(buildMissedCaptureAlerts({ ...REPORT, missed: [] })).toEqual([]);
  });
});

describe("missedCapturePassFromHoldingId (#1339)", () => {
  it("recovers the run key from the sentinel holding id", () => {
    expect(missedCapturePassFromHoldingId("daily-capture:2026-07-28:pm")).toBe(
      "2026-07-28:pm",
    );
  });

  it("returns null for a real holding id", () => {
    expect(missedCapturePassFromHoldingId("wl_hld_loan")).toBeNull();
  });
});

describe("maintainerAlertSubject (#1339)", () => {
  it("names a tenant alert by workspace and holding", () => {
    expect(
      maintainerAlertSubject({
        category: "infidelity",
        workspaceId: "ws-ana",
        holdingId: "wl_hld_loan",
      }),
    ).toEqual({ isFleet: false, subject: "wl_hld_loan", workspace: "ws-ana" });
  });

  it("translates a fleet alert's sentinels into the fleet and the pass", () => {
    expect(
      maintainerAlertSubject({
        category: "missed_capture",
        workspaceId: "fleet",
        holdingId: "daily-capture:2026-07-28:pm",
      }),
    ).toEqual({
      isFleet: true,
      subject: "28-07-2026, captura de tarde (≈21:00 UTC)",
      workspace: "flota",
    });
  });
});

describe("isMissedCapturePayload (#1339)", () => {
  it("accepts a payload built here", () => {
    expect(isMissedCapturePayload(buildMissedCaptureAlerts(REPORT)[0]?.payload)).toBe(
      true,
    );
  });

  it("rejects anything else, including an assistant alert payload", () => {
    expect(isMissedCapturePayload(null)).toBe(false);
    expect(isMissedCapturePayload({ category: "infidelity", summary: "x" })).toBe(false);
    expect(isMissedCapturePayload({ category: "missed_capture" })).toBe(false);
  });

  it("rejects a payload missing a field the surface dereferences", () => {
    const { omittedOlderPasses, ...withoutCap } =
      buildMissedCaptureAlerts(REPORT)[0]!.payload;
    expect(omittedOlderPasses).toBe(0);
    expect(isMissedCapturePayload(withoutCap)).toBe(false);
  });
});
