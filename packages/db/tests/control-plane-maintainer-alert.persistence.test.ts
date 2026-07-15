/**
 * Maintainer-alert store tests (#1050, ADR 0064). The control-plane-only alert
 * store: dedup by workspace+holding+category, accumulated occurrences (each with
 * the full forensic payload), the open→resolved|dismissed lifecycle, and a
 * re-trigger after closure that mints a NEW alert linked to the prior one.
 */
import { createInMemoryControlPlaneStore } from "@db/control-plane";
import { describe, expect, test } from "vitest";

const KEY = {
  workspaceId: "ws-ana",
  holdingId: "wl_hld_loan",
  category: "infidelity" as const,
};

describe("control-plane maintainer alerts", () => {
  test("raising a first alert mints an open alert with one occurrence", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { alert, created } = await cp.raiseMaintainerAlert({
        ...KEY,
        payload: { note: "painted != recomputed", trace: { faithful: false } },
        occurredAt: "2026-07-15T10:00:00.000Z",
      });

      expect(created).toBe(true);
      expect(alert.status).toBe("open");
      expect(alert.occurrenceCount).toBe(1);
      expect(alert.firstSeenAt).toBe("2026-07-15T10:00:00.000Z");
      expect(alert.lastSeenAt).toBe("2026-07-15T10:00:00.000Z");
      expect(alert.supersedesAlertId).toBeNull();

      const detail = await cp.getMaintainerAlert(alert.id);
      expect(detail?.occurrences).toHaveLength(1);
      expect(detail?.occurrences[0]?.payload).toEqual({
        note: "painted != recomputed",
        trace: { faithful: false },
      });
    } finally {
      cp.close();
    }
  });

  test("re-raising an open key accumulates occurrences on the same alert", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const first = await cp.raiseMaintainerAlert({
        ...KEY,
        payload: { seq: 1 },
        occurredAt: "2026-07-15T10:00:00.000Z",
      });
      const second = await cp.raiseMaintainerAlert({
        ...KEY,
        payload: { seq: 2 },
        occurredAt: "2026-07-15T12:00:00.000Z",
      });

      expect(second.created).toBe(false);
      expect(second.alert.id).toBe(first.alert.id);
      expect(second.alert.occurrenceCount).toBe(2);
      // The most recent occurrence advances last-seen; first-seen is pinned.
      expect(second.alert.lastSeenAt).toBe("2026-07-15T12:00:00.000Z");
      expect(second.alert.firstSeenAt).toBe("2026-07-15T10:00:00.000Z");

      const detail = await cp.getMaintainerAlert(first.alert.id);
      expect(detail?.occurrences.map((o) => o.payload)).toEqual([{ seq: 1 }, { seq: 2 }]);

      // Exactly one open alert exists for the key.
      const alerts = await cp.listMaintainerAlerts();
      expect(alerts).toHaveLength(1);
    } finally {
      cp.close();
    }
  });

  test("a different category is a distinct alert, not a dedup", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await cp.raiseMaintainerAlert({
        ...KEY,
        payload: {},
        occurredAt: "2026-07-15T10:00:00.000Z",
      });
      await cp.raiseMaintainerAlert({
        ...KEY,
        category: "residual",
        payload: {},
        occurredAt: "2026-07-15T11:00:00.000Z",
      });

      const alerts = await cp.listMaintainerAlerts();
      expect(alerts).toHaveLength(2);
      // Most-recently-seen first.
      expect(alerts[0]?.category).toBe("residual");
      expect(alerts[1]?.category).toBe("infidelity");
    } finally {
      cp.close();
    }
  });

  test("resolving an alert closes it with a note and link", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { alert } = await cp.raiseMaintainerAlert({
        ...KEY,
        payload: {},
        occurredAt: "2026-07-15T10:00:00.000Z",
      });

      const resolved = await cp.updateMaintainerAlertStatus(alert.id, {
        status: "resolved",
        note: "ripple bug fixed in #1042",
        link: "https://github.com/jenarvaezg/worthline/issues/1042",
      });

      expect(resolved.status).toBe("resolved");
      expect(resolved.resolutionNote).toBe("ripple bug fixed in #1042");
      expect(resolved.resolutionLink).toBe(
        "https://github.com/jenarvaezg/worthline/issues/1042",
      );
      expect(resolved.resolvedAt).not.toBeNull();
      expect(await cp.countOpenMaintainerAlerts()).toBe(0);
    } finally {
      cp.close();
    }
  });

  test("dismissing an alert closes it and drops it from the open count", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { alert } = await cp.raiseMaintainerAlert({
        ...KEY,
        payload: {},
        occurredAt: "2026-07-15T10:00:00.000Z",
      });
      const dismissed = await cp.updateMaintainerAlertStatus(alert.id, {
        status: "dismissed",
      });
      expect(dismissed.status).toBe("dismissed");
      expect(dismissed.resolutionNote).toBeNull();
      expect(await cp.countOpenMaintainerAlerts()).toBe(0);
    } finally {
      cp.close();
    }
  });

  test("re-triggering after closure mints a NEW alert linked to the prior one", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const first = await cp.raiseMaintainerAlert({
        ...KEY,
        payload: { seq: 1 },
        occurredAt: "2026-07-15T10:00:00.000Z",
      });
      await cp.updateMaintainerAlertStatus(first.alert.id, { status: "resolved" });

      const regression = await cp.raiseMaintainerAlert({
        ...KEY,
        payload: { seq: 2 },
        occurredAt: "2026-07-20T10:00:00.000Z",
      });

      expect(regression.created).toBe(true);
      expect(regression.alert.id).not.toBe(first.alert.id);
      expect(regression.alert.status).toBe("open");
      expect(regression.alert.occurrenceCount).toBe(1);
      // Linked back to the resolved alert — this smells like a regression.
      expect(regression.alert.supersedesAlertId).toBe(first.alert.id);

      // The regression's occurrences are its own, not the prior alert's.
      const detail = await cp.getMaintainerAlert(regression.alert.id);
      expect(detail?.occurrences.map((o) => o.payload)).toEqual([{ seq: 2 }]);
      expect(await cp.countOpenMaintainerAlerts()).toBe(1);

      const alerts = await cp.listMaintainerAlerts();
      expect(alerts).toHaveLength(2);
    } finally {
      cp.close();
    }
  });

  test("open count spans workspaces and getMaintainerAlert is null for unknown ids", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await cp.raiseMaintainerAlert({
        ...KEY,
        payload: {},
        occurredAt: "2026-07-15T10:00:00.000Z",
      });
      await cp.raiseMaintainerAlert({
        workspaceId: "ws-jorge",
        holdingId: "wl_hld_loan",
        category: "sync_source",
        payload: {},
        occurredAt: "2026-07-15T11:00:00.000Z",
      });

      expect(await cp.countOpenMaintainerAlerts()).toBe(2);
      expect(await cp.getMaintainerAlert("nope")).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("updating an unknown alert throws", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await expect(
        cp.updateMaintainerAlertStatus("nope", { status: "resolved" }),
      ).rejects.toThrow(/not found/i);
    } finally {
      cp.close();
    }
  });
});
