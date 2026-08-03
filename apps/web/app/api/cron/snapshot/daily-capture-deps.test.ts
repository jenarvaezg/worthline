import type { RaiseMaintainerAlertInput } from "@worthline/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Hostile suite · cron surface (#1009). Mock the authorization port so we can
// observe exactly how the cron reaches a workspace store — without opening a
// real DB. The point is the SEAM: the cron must go through the port, as a
// `system` principal, carrying only the coordinates of the workspace it was
// handed (so it opens exactly that dbUrl and cannot cross into another).
const { openAuthorizedStore } = vi.hoisted(() => ({
  openAuthorizedStore: vi.fn(
    async (_principal: unknown) => ({ close: vi.fn() }) as never,
  ),
}));
vi.mock("@web/principal", () => ({ openAuthorizedStore }));

// The control plane is a real libsql client in production; stand in for it so the
// missed-pass detection wiring (#1339) can be observed without a database.
const { controlPlane, createControlPlaneStore } = vi.hoisted(() => {
  const controlPlane = {
    close: vi.fn(),
    raiseMaintainerAlert: vi.fn(async (_input: RaiseMaintainerAlertInput) => ({
      alert: {} as never,
      created: true,
    })),
    readLatestJobDedupeKey: vi.fn(
      async (_input: { kind: string; before: string }): Promise<string | null> => null,
    ),
  };
  return { controlPlane, createControlPlaneStore: vi.fn(async () => controlPlane) };
});
vi.mock("@worthline/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@worthline/db")>()),
  createControlPlaneStore,
}));

import { buildDailyCaptureDeps } from "./daily-capture-deps";

const CONTROL_PLANE_ENV = {
  WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
  WORTHLINE_DB_AUTH_TOKEN: "group-token",
};

describe("buildDailyCaptureDeps", () => {
  beforeEach(() => {
    openAuthorizedStore.mockClear();
    controlPlane.close.mockClear();
    controlPlane.raiseMaintainerAlert.mockClear();
    controlPlane.readLatestJobDedupeKey.mockClear();
    controlPlane.readLatestJobDedupeKey.mockResolvedValue(null);
  });

  test("now is the real clock — a WORTHLINE_DEMO_NOW in the env never pins it", () => {
    const deps = buildDailyCaptureDeps({
      WORTHLINE_DEMO_NOW: "2000-01-01T00:00:00.000Z",
      WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
      WORTHLINE_DB_AUTH_TOKEN: "tok",
    });

    expect(deps.now.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(deps.now.startsWith("2000")).toBe(false);
  });

  test("opens each workspace THROUGH the port as a system principal, never a raw open", async () => {
    const deps = buildDailyCaptureDeps({
      WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
      WORTHLINE_DB_AUTH_TOKEN: "group-token",
    });

    await deps.openStore({
      id: "wl-a",
      dbUrl: "libsql://wl-a.turso.io",
      authToken: "scoped-a",
    });

    expect(openAuthorizedStore).toHaveBeenCalledTimes(1);
    expect(openAuthorizedStore).toHaveBeenCalledWith({
      kind: "system",
      options: { url: "libsql://wl-a.turso.io", authToken: "scoped-a" },
    });
  });

  test("carries ONLY the handed workspace's coordinates — it cannot reach a sibling", async () => {
    const deps = buildDailyCaptureDeps({
      WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
      WORTHLINE_DB_AUTH_TOKEN: "group-token",
    });

    await deps.openStore({
      id: "wl-a",
      dbUrl: "libsql://wl-a.turso.io",
      authToken: "scoped-a",
    });
    await deps.openStore({
      id: "wl-b",
      dbUrl: "libsql://wl-b.turso.io",
      authToken: "scoped-b",
    });

    // Each call opens exactly the dbUrl + scoped token it was iterated onto:
    // A's open never carries B's coordinates and vice versa.
    const opens = openAuthorizedStore.mock.calls.map(
      ([principal]) =>
        (principal as { options: { url: string; authToken?: string } }).options,
    );
    expect(opens).toEqual([
      { url: "libsql://wl-a.turso.io", authToken: "scoped-a" },
      { url: "libsql://wl-b.turso.io", authToken: "scoped-b" },
    ]);
    for (const [principal] of openAuthorizedStore.mock.calls) {
      expect((principal as { kind: string }).kind).toBe("system");
    }
  });

  test("takes the detection baseline from the daily-capture QUEUE, not from finalization (#1339)", async () => {
    const deps = buildDailyCaptureDeps(CONTROL_PLANE_ENV);

    expect(await deps.readLatestInvokedPass?.("2026-07-30:am")).toBeNull();
    // Only daily-capture jobs, and only keys BELOW the pass now running (which has
    // already enqueued its own row).
    expect(controlPlane.readLatestJobDedupeKey).toHaveBeenCalledWith({
      kind: "daily-capture",
      before: "2026-07-30:am",
    });

    controlPlane.readLatestJobDedupeKey.mockResolvedValue("2026-07-29:am");
    expect(await deps.readLatestInvokedPass?.("2026-07-30:am")).toBe("2026-07-29:am");
    // The cron opens a control-plane connection per seam call and always closes it.
    expect(controlPlane.close).toHaveBeenCalledTimes(2);
  });

  test("raises one fleet-keyed maintainer alert per missed pass (#1339)", async () => {
    const deps = buildDailyCaptureDeps(CONTROL_PLANE_ENV);

    await deps.reportMissedPasses?.({
      missed: ["2026-07-28:pm", "2026-07-29:am"],
      omitted: 0,
      detectedByRunKey: "2026-07-29:pm",
      latestInvokedRunKey: "2026-07-28:am",
      detectedAt: "2026-07-29T21:04:00.000Z",
    });

    expect(controlPlane.raiseMaintainerAlert).toHaveBeenCalledTimes(2);
    expect(controlPlane.raiseMaintainerAlert.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        workspaceId: "fleet",
        holdingId: "daily-capture:2026-07-28:pm",
        category: "missed_capture",
      }),
      expect.objectContaining({
        workspaceId: "fleet",
        holdingId: "daily-capture:2026-07-29:am",
        category: "missed_capture",
      }),
    ]);
    expect(controlPlane.close).toHaveBeenCalledTimes(1);
  });

  test("omits the auth token when the deploy configures none (local/dev cron)", async () => {
    const deps = buildDailyCaptureDeps({
      WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
    });

    await deps.openStore({ id: "wl-a", dbUrl: "libsql://wl-a.turso.io" });

    expect(openAuthorizedStore).toHaveBeenCalledWith({
      kind: "system",
      options: { url: "libsql://wl-a.turso.io" },
    });
  });
});
