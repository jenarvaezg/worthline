import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "globals.css"),
  "utf8",
);

describe("view-transition CSS contract (#640)", () => {
  test("documents typed navigation honestly and does not ship dormant slide selectors", () => {
    expect(css).toContain("transitionTypes");
    expect(css).toContain("React <ViewTransition>");
    expect(css).not.toContain("::view-transition-old(.slide-forward)");
    expect(css).not.toContain("::view-transition-new(.slide-back)");
    expect(css).not.toContain("no NavigationTracker island exists");
  });
});
