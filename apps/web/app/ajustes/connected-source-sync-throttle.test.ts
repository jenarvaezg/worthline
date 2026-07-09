import { describe, expect, test } from "vitest";

import {
  CONNECTED_SOURCE_SYNC_LIMIT,
  connectedSourceSyncPlan,
  connectedSourceSyncWindow,
} from "./connected-source-sync-throttle";

describe("connected source sync throttle policy", () => {
  test("uses a fixed UTC-hour window", () => {
    expect(connectedSourceSyncWindow("2026-07-09T08:45:12.000Z")).toBe("2026-07-09T08");
  });

  test("meters authenticated users with a hashed user key", () => {
    const plan = connectedSourceSyncPlan({
      target: {
        kind: "authenticated",
        workspaceId: "ws_1",
        dbUrl: "libsql://workspace",
        token: "token",
      },
      userEmail: "Ana@Example.com ",
    });

    expect(plan).toEqual({
      mode: "count",
      key: expect.stringMatching(/^connected-source-sync:user:[a-f0-9]{64}$/),
      limit: CONNECTED_SOURCE_SYNC_LIMIT,
    });
    expect(plan.mode === "count" ? plan.key : "").not.toContain("Ana");
  });

  test("bypasses local mode", () => {
    expect(
      connectedSourceSyncPlan({ target: { kind: "local" }, userEmail: null }),
    ).toEqual({ mode: "bypass" });
  });
});
