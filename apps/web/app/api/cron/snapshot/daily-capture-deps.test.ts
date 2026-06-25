import { describe, expect, test } from "vitest";

import { buildDailyCaptureDeps } from "./daily-capture-deps";

describe("buildDailyCaptureDeps", () => {
  test("now is the real clock — a WORTHLINE_DEMO_NOW in the env never pins it", () => {
    const deps = buildDailyCaptureDeps({
      WORTHLINE_DEMO_NOW: "2000-01-01T00:00:00.000Z",
      WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
      WORTHLINE_DB_AUTH_TOKEN: "tok",
    });

    expect(deps.now.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(deps.now.startsWith("2000")).toBe(false);
  });
});
