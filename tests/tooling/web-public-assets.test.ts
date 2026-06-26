import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = join(repoRoot, "apps/web/public");

function publicAsset(pathname: string): string {
  return join(publicDir, pathname.replace(/^\//, ""));
}

describe("web public PWA assets", () => {
  test("manifest icons and service-worker precache entries resolve to public files", () => {
    const manifest = JSON.parse(
      readFileSync(join(publicDir, "manifest.json"), "utf8"),
    ) as {
      icons: Array<{ src: string }>;
    };
    const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
    const precacheAssets = [...sw.matchAll(/"(?<asset>\/[^"]+)"/g)]
      .map((match) => match.groups?.asset)
      .filter((asset): asset is string => asset !== undefined)
      .filter((asset) =>
        ["/manifest.json", "/icon.svg", "/mcp-icon.svg"].includes(asset),
      );

    for (const asset of [...manifest.icons.map((icon) => icon.src), ...precacheAssets]) {
      expect(existsSync(publicAsset(asset)), asset).toBe(true);
    }
  });
});
