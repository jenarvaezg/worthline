import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrapHealthcheck } from "@worthline/db";
import { createDashboardShell } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("worthline bootstrap", () => {
  test("loads a dashboard shell through domain logic and SQLite persistence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worthline-bootstrap-"));
    tempDirs.push(dataDir);

    const persistence = await runBootstrapHealthcheck({
      databasePath: join(dataDir, "worthline.sqlite"),
      now: () => new Date("2026-06-08T12:00:00.000Z"),
    });

    const dashboard = createDashboardShell({ persistence });

    expect(dashboard.productName).toBe("worthline");
    expect(dashboard.baseCurrency).toBe("EUR");
    expect(dashboard.generatedAt).toBe("2026-06-08T12:00:00.000Z");
    expect(dashboard.persistence.status).toBe("ok");
    expect(dashboard.persistence.checkValue).toBe("2026-06-08T12:00:00.000Z");
  });
});
