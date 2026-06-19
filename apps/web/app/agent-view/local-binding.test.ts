import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("agent-view local server binding", () => {
  test("local Next entrypoints bind to loopback", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts.dev).toContain("--hostname 127.0.0.1");
    expect(pkg.scripts.start).toContain("--hostname 127.0.0.1");
  });
});
