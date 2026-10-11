import { describe, expect, it } from "vitest";

import { maintainerAlertSubject } from "./missed-capture-alert";
import {
  buildProvisioningCapAlert,
  isProvisioningCapPayload,
  PROVISIONING_CAP_ALERT_WORKSPACE_ID,
  provisioningCapDayFromHoldingId,
} from "./provisioning-cap-alert";

// Illustrative figures only — the real cap lives in the deployment's env.
const FULL_DAY = {
  dayKey: "2026-03-14",
  policy: { kind: "limited" as const, limit: 2 },
  provisionedToday: 2,
};
const DETECTED_AT = "2026-03-14T10:00:00.000Z";

describe("buildProvisioningCapAlert (#1175)", () => {
  it("is a fleet alert keyed by the day, so a day's refusals pile onto one incident", () => {
    const alert = buildProvisioningCapAlert({
      detectedAt: DETECTED_AT,
      refusal: FULL_DAY,
    });

    expect(alert.workspaceId).toBe(PROVISIONING_CAP_ALERT_WORKSPACE_ID);
    expect(alert.workspaceId).toBe("fleet");
    expect(alert.holdingId).toBe("provisioning-cap:2026-03-14");
    expect(alert.category).toBe("provisioning_cap");
    expect(alert.occurredAt).toBe(DETECTED_AT);
    expect(provisioningCapDayFromHoldingId(alert.holdingId)).toBe("2026-03-14");
  });

  it("says in words that the day is full and what the limit was", () => {
    const { payload } = buildProvisioningCapAlert({
      detectedAt: DETECTED_AT,
      refusal: FULL_DAY,
    });

    expect(payload).toMatchObject({
      category: "provisioning_cap",
      cause: "cap_reached",
      dayKey: "2026-03-14",
      limit: 2,
      provisionedToday: 2,
    });
    expect(payload).not.toHaveProperty("configuredValue");
    expect(payload.summary).toContain("14-03-2026");
    expect(payload.summary).toContain("(2)");
    expect(isProvisioningCapPayload(payload)).toBe(true);
  });

  it("tells a deliberately closed registration apart from a full day", () => {
    const { payload } = buildProvisioningCapAlert({
      detectedAt: DETECTED_AT,
      refusal: {
        ...FULL_DAY,
        policy: { kind: "limited", limit: 0 },
        provisionedToday: 0,
      },
    });
    expect(payload.cause).toBe("closed");
    expect(payload.summary).toContain("está a 0");
  });

  it("names a misconfigured cap as the cause, with the value that failed to parse", () => {
    const { payload } = buildProvisioningCapAlert({
      detectedAt: DETECTED_AT,
      refusal: {
        dayKey: "2026-03-14",
        policy: { configuredValue: "cinco", kind: "misconfigured" },
        provisionedToday: 0,
      },
    });

    expect(payload.cause).toBe("misconfigured");
    expect(payload.limit).toBe(0);
    expect(payload.configuredValue).toBe("cinco");
    expect(payload.summary).toContain("WORTHLINE_DAILY_PROVISIONING_CAP");
    expect(payload.summary).toContain("cinco");
  });

  it("names a production deploy that forgot the variable, exactly", () => {
    const { payload } = buildProvisioningCapAlert({
      detectedAt: DETECTED_AT,
      refusal: { dayKey: "2026-03-14", policy: { kind: "unset" }, provisionedToday: 0 },
    });

    expect(payload.cause).toBe("unset_in_production");
    expect(payload.limit).toBe(0);
    expect(payload.summary).toContain("no define WORTHLINE_DAILY_PROVISIONING_CAP");
    expect(payload.summary).toContain("producción");
  });

  it("carries nothing about WHO was turned away", () => {
    // The builder never receives the identity, so it cannot leak it; this pins
    // that no future field starts carrying one.
    const alert = buildProvisioningCapAlert({
      detectedAt: DETECTED_AT,
      refusal: FULL_DAY,
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
    expect(
      isProvisioningCapPayload({
        category: "provisioning_cap",
        cause: "nonsense",
        dayKey: "2026-03-14",
        limit: 1,
        provisionedToday: 1,
        summary: "x",
      }),
    ).toBe(false);
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
