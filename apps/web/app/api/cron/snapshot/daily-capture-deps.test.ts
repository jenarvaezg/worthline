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

import { buildDailyCaptureDeps } from "./daily-capture-deps";

describe("buildDailyCaptureDeps", () => {
  beforeEach(() => {
    openAuthorizedStore.mockClear();
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

    await deps.openStore({ id: "wl-a", dbUrl: "libsql://wl-a.turso.io" });

    expect(openAuthorizedStore).toHaveBeenCalledTimes(1);
    expect(openAuthorizedStore).toHaveBeenCalledWith({
      kind: "system",
      options: { url: "libsql://wl-a.turso.io", authToken: "group-token" },
    });
  });

  test("carries ONLY the handed workspace's coordinates — it cannot reach a sibling", async () => {
    const deps = buildDailyCaptureDeps({
      WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
      WORTHLINE_DB_AUTH_TOKEN: "group-token",
    });

    await deps.openStore({ id: "wl-a", dbUrl: "libsql://wl-a.turso.io" });
    await deps.openStore({ id: "wl-b", dbUrl: "libsql://wl-b.turso.io" });

    // Each call opens exactly the dbUrl it was iterated onto: A's open never
    // carries B's url and vice versa (the `system` principal brings its own
    // coordinates, it does not resolve them from anywhere shared).
    const urls = openAuthorizedStore.mock.calls.map(
      ([principal]) => (principal as { options: { url: string } }).options.url,
    );
    expect(urls).toEqual(["libsql://wl-a.turso.io", "libsql://wl-b.turso.io"]);
    for (const [principal] of openAuthorizedStore.mock.calls) {
      expect((principal as { kind: string }).kind).toBe("system");
    }
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
