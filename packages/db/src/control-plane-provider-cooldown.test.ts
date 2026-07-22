import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createControlPlaneStore, type UsageLimits } from "./control-plane";

// Cross the real UsageLimits port seam across two separate connections.
type UsageLimitsStore = UsageLimits & { close(): void };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("control plane provider cooldowns", () => {
  it("shares cooldowns across store instances by deployment and provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-provider-cooldown-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.db")}`;
    const writer: UsageLimitsStore = await createControlPlaneStore({ url });
    const reader: UsageLimitsStore = await createControlPlaneStore({ url });
    try {
      await writer.recordProviderCooldown(
        "preview-959",
        "google",
        "2026-07-12T11:00:00.000Z",
      );

      expect(await reader.readProviderCooldowns("preview-959")).toEqual([
        {
          provider: "google",
          cooldownUntil: "2026-07-12T11:00:00.000Z",
        },
      ]);
      expect(await reader.readProviderCooldowns("production")).toEqual([]);
    } finally {
      writer.close();
      reader.close();
    }
  });

  it("concurrent writes never shorten the existing cooldown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-provider-cooldown-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.db")}`;
    const first: UsageLimitsStore = await createControlPlaneStore({ url });
    const second: UsageLimitsStore = await createControlPlaneStore({ url });
    try {
      await Promise.all([
        first.recordProviderCooldown("production", "groq", "2026-07-13T00:00:00.000Z"),
        second.recordProviderCooldown("production", "groq", "2026-07-12T10:01:00.000Z"),
      ]);

      expect(await first.readProviderCooldowns("production")).toEqual([
        { provider: "groq", cooldownUntil: "2026-07-13T00:00:00.000Z" },
      ]);
    } finally {
      first.close();
      second.close();
    }
  });
});
