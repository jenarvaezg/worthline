import { describe, expect, test } from "vitest";

import authConfig from "./auth.config";

const DAY_SECONDS = 60 * 60 * 24;

describe("auth session lifetime (#1180)", () => {
  test("the JWT session expires after 7 days, not Auth.js's 30-day default", () => {
    expect(authConfig.session?.strategy).toBe("jwt");
    expect(authConfig.session?.maxAge).toBe(7 * DAY_SECONDS);
  });

  test("the session refreshes at most once a day (rolling, not per request)", () => {
    expect(authConfig.session?.updateAge).toBe(DAY_SECONDS);
  });

  test("the refresh window is shorter than the lifetime, so an active session rolls", () => {
    const { maxAge, updateAge } = authConfig.session ?? {};
    expect(maxAge).toBeDefined();
    expect(updateAge).toBeDefined();
    expect(updateAge!).toBeLessThan(maxAge!);
  });
});
