import { describe, expect, it } from "vitest";

import { maintainerAlertSubject } from "./missed-capture-alert";
import {
  buildProvisioningCapAlert,
  isProvisioningCapPayload,
  PROVISIONING_CAP_ALERT_WORKSPACE_ID,
  provisioningCapDayFromHoldingId,
} from "./provisioning-cap-alert";

// Illustrative figures only — the real cap lives in the deployment's env.
const REFUSAL = { dailyCap: 2, dayKey: "2026-03-14", used: 2 };

describe("buildProvisioningCapAlert (#1175)", () => {
  it("is a fleet alert keyed by the day, so a day's refusals pile onto one incident", () => {
    const alert = buildProvisioningCapAlert({
      detectedAt: "2026-03-14T10:00:00.000Z",
      reason: "cap_reached",
      refusal: REFUSAL,
    });

    expect(alert.workspaceId).toBe(PROVISIONING_CAP_ALERT_WORKSPACE_ID);
    expect(alert.workspaceId).toBe("fleet");
    expect(alert.holdingId).toBe("provisioning-cap:2026-03-14");
    expect(alert.category).toBe("provisioning_cap");
    expect(alert.occurredAt).toBe("2026-03-14T10:00:00.000Z");
    expect(provisioningCapDayFromHoldingId(alert.holdingId)).toBe("2026-03-14");
  });

  it("says in words that the day is full and what the cap was", () => {
    const { payload } = buildProvisioningCapAlert({
      detectedAt: "2026-03-14T10:00:00.000Z",
      reason: "cap_reached",
      refusal: REFUSAL,
    });

    expect(payload).toMatchObject({
      category: "provisioning_cap",
      dailyCap: 2,
      dayKey: "2026-03-14",
      reason: "cap_reached",
      used: 2,
    });
    expect(payload.summary).toContain("14-03-2026");
    expect(payload.summary).toContain("2");
    expect(isProvisioningCapPayload(payload)).toBe(true);
  });

  it("names a misconfigured cap as the cause, with the value that failed to parse", () => {
    const { payload } = buildProvisioningCapAlert({
      configuredValue: "cinco",
      detectedAt: "2026-03-14T10:00:00.000Z",
      reason: "misconfigured",
      refusal: { dailyCap: 0, dayKey: "2026-03-14", used: 0 },
    });

    expect(payload.reason).toBe("misconfigured");
    expect(payload.configuredValue).toBe("cinco");
    expect(payload.summary).toContain("WORTHLINE_DAILY_PROVISIONING_CAP");
    expect(payload.summary).toContain("cinco");
  });

  it("carries nothing about WHO was turned away", () => {
    // The builder never receives the identity, so it cannot leak it; this pins
    // that no future field starts carrying one.
    const alert = buildProvisioningCapAlert({
      detectedAt: "2026-03-14T10:00:00.000Z",
      reason: "cap_reached",
      refusal: REFUSAL,
    });
    expect(JSON.stringify(alert)).not.toContain("@");
  });
});

describe("isProvisioningCapPayload (#1175)", () => {
  it("rejects partial or foreign payloads", () => {
    expect(isProvisioningCapPayload(null)).toBe(false);
    expect(isProvisioningCapPayload({ category: "provisioning_cap" })).toBe(false);
    expect(isProvisioningCapPayload({ category: "missed_capture", summary: "x" })).toBe(
      false,
    );
  });
});

describe("maintainerAlertSubject for a provisioning-cap alert (#1175)", () => {
  it("names the fleet and the day's sign-ups, never the raw sentinels", () => {
    const subject = maintainerAlertSubject({
      category: "provisioning_cap",
      holdingId: "provisioning-cap:2026-03-14",
      workspaceId: "fleet",
    });
    expect(subject.isFleet).toBe(true);
    expect(subject.workspace).toBe("flota");
    expect(subject.subject).toBe("altas del 14-03-2026");
  });

  it("returns null for any other holding id", () => {
    expect(provisioningCapDayFromHoldingId("daily-capture:2026-03-14:am")).toBeNull();
  });
});
