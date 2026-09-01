import { describe, expect, test } from "vitest";

import { maintainerAlertSubject } from "./missed-capture-alert";
import {
  buildSourceSyncAlerts,
  sourceSyncWorkspaceFromHoldingId,
} from "./source-sync-alert";

const AT = "2026-09-01T21:31:41.175Z";

describe("buildSourceSyncAlerts (#1755)", () => {
  test("a clean pass raises nothing", () => {
    expect(buildSourceSyncAlerts([], AT)).toEqual([]);
  });

  test("one alert per workspace, keyed on its sync phase", () => {
    const alerts = buildSourceSyncAlerts(
      [
        { workspaceId: "ws-jose", error: "Numista credentials unavailable." },
        { workspaceId: "ws-jorge", error: "Numista credentials unavailable." },
      ],
      AT,
    );

    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.workspaceId)).toEqual(["ws-jose", "ws-jorge"]);
    // The alert belongs to the tenant, unlike a missed pass (fleet-wide): which
    // workspace is degraded is half the diagnosis.
    expect(alerts[0]).toMatchObject({
      category: "sync_source",
      holdingId: "source-sync:ws-jose",
      occurredAt: AT,
    });
  });

  test("several errors of one workspace ride ONE alert, all of them kept", () => {
    const alerts = buildSourceSyncAlerts(
      [
        { workspaceId: "ws-jose", error: "primero" },
        { workspaceId: "ws-jose", error: "segundo" },
        { workspaceId: "ws-jose", error: "tercero" },
      ],
      AT,
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload.errors).toEqual(["primero", "segundo", "tercero"]);
    // The summary leads with the first error and says how many more there were —
    // the full list is in the payload for the detail view.
    expect(alerts[0]?.payload.summary).toContain("primero");
    expect(alerts[0]?.payload.summary).toContain("2 error(es) más");
  });

  test("the dedup key is stable across nights, so a repeat accumulates", () => {
    const first = buildSourceSyncAlerts([{ workspaceId: "ws", error: "a" }], AT);
    const second = buildSourceSyncAlerts(
      [{ workspaceId: "ws", error: "a" }],
      "2026-09-02T21:31:44.000Z",
    );

    // `workspace + holding + category` is what the control plane dedupes on: the
    // 21 identical nights that started this ticket must read as ONE incident with
    // a count, not 21 alerts.
    expect(second[0]?.holdingId).toBe(first[0]?.holdingId);
    expect(second[0]?.workspaceId).toBe(first[0]?.workspaceId);
    expect(second[0]?.category).toBe(first[0]?.category);
  });
});

describe("the sentinel holding id", () => {
  test("round-trips its workspace, and ignores a real holding id", () => {
    expect(sourceSyncWorkspaceFromHoldingId("source-sync:ws-jose")).toBe("ws-jose");
    expect(sourceSyncWorkspaceFromHoldingId("hld-1234")).toBeNull();
  });

  test("/admin names the subject instead of printing the sentinel raw", () => {
    expect(
      maintainerAlertSubject({
        category: "sync_source",
        workspaceId: "ws-jose",
        holdingId: "source-sync:ws-jose",
      }),
    ).toEqual({
      isFleet: false,
      subject: "sincronización de fuentes conectadas",
      workspace: "ws-jose",
    });
  });

  test("a sync_source alert about a REAL holding is left alone", () => {
    // The assistant raises this category over an actual holding (ADR 0064); only
    // the cron's sentinel gets translated.
    expect(
      maintainerAlertSubject({
        category: "sync_source",
        workspaceId: "ws-jose",
        holdingId: "hld-1234",
      }),
    ).toEqual({ isFleet: false, subject: "hld-1234", workspace: "ws-jose" });
  });
});
