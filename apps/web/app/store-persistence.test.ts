import { describe, expect, test } from "vitest";

import { bootstrapHealthcheck } from "./store";

/**
 * Estreno leak fix (PRD #877 S6, #954): the persistence footer renders on every
 * authenticated page, so the raw workspace libSQL URL — which exposes the Turso
 * host and the workspace id — must never reach `displayPath`.
 */
describe("hosted workspace persistence never leaks the database URL (#954)", () => {
  const dbUrl = "libsql://wl-abc123def456.turso.io";
  const target = {
    kind: "authenticated",
    workspaceId: "wl-abc123def456",
    dbUrl,
    token: "group-token",
  } as const;

  test("displayPath is a friendly label, not the raw Turso URL", async () => {
    const status = await bootstrapHealthcheck(target);

    expect(status.displayPath).toBe("tu espacio · base de datos privada");
    expect(status.displayPath).not.toContain("turso");
    expect(status.displayPath).not.toContain("libsql");
    expect(status.displayPath).not.toContain("wl-abc123def456");
  });

  test("databasePath keeps the raw URL for the owner-only technical panel", async () => {
    const status = await bootstrapHealthcheck(target);

    expect(status.databasePath).toBe(dbUrl);
  });
});
