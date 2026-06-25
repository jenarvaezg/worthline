import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Inject fake deps so the route's real secret gate + real `runDailyCapture`
// wiring run with zero workspaces — no control plane, no Turso, no network.
vi.mock("./daily-capture-deps", () => ({
  buildDailyCaptureDeps: () => ({
    now: "2026-06-25T21:00:00.000Z",
    listAllWorkspaces: async () => [],
    openStore: async () => {
      throw new Error("no workspaces to open");
    },
    fetchPrices: async () => [],
  }),
}));

import { GET } from "./route";

const URL = "http://localhost:3000/api/cron/snapshot";
const SECRET = "s3cr3t";

describe("/api/cron/snapshot", () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  test("rejects a request with no Authorization (401)", async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(401);
  });

  test("rejects a wrong bearer secret (401)", async () => {
    const res = await GET(
      new Request(URL, { headers: { Authorization: "Bearer wrong" } }),
    );
    expect(res.status).toBe(401);
  });

  test("with the secret, runs the capture and returns a summary (200)", async () => {
    const res = await GET(
      new Request(URL, { headers: { Authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 0, captured: 0, failures: [] });
  });

  test("fails closed when CRON_SECRET is unset (401 even with a bearer)", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(
      new Request(URL, { headers: { Authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(401);
  });
});
