import { describe, expect, test } from "vitest";

import { tursoPortFromEnv } from "./turso-port";

describe("tursoPortFromEnv", () => {
  test("without Turso's env it names what is missing and both surfaces that need it", () => {
    expect(() => tursoPortFromEnv({})).toThrow(
      "Reaching Turso's Platform API (provisioning a workspace, or minting its read-only token to share it) requires WORTHLINE_CONTROL_PLANE_DB_URL, TURSO_ORG, and TURSO_API_TOKEN.",
    );
  });

  test("with it, builds the port", () => {
    const port = tursoPortFromEnv({
      TURSO_API_TOKEN: "token",
      TURSO_ORG: "org",
      WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp.turso.io",
    });

    expect(typeof port.createDatabaseToken).toBe("function");
  });
});
