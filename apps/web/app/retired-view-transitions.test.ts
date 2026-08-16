import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(appDirectory, "globals.css"), "utf8");
const nextConfig = readFileSync(join(appDirectory, "..", "next.config.ts"), "utf8");

/**
 * The View Transitions layer stays retired (#1379).
 *
 * It shipped for two years without ever running: React only opens a transition
 * from inside a `<ViewTransition>` boundary (`shouldStartViewTransition` is set
 * from ViewTransition fibers alone), the app never had one, and Next's client
 * runtime does not add one either. Measured on a production build with a
 * `document.startViewTransition` probe: zero calls.
 *
 * It was retired rather than revived because reviving it buys a page-root
 * cross-fade and nothing else — the directional slide selectors were already
 * deleted in #640 — and that cross-fade fades into a Suspense skeleton, since
 * every section page streams. Meanwhile the boundary would move the outgoing
 * route's hide inside the `startViewTransition` callback, which is the exact
 * mechanism behind #1296 and #1351. See ADR 0036 §5.
 *
 * These two assertions are the tripwire. The CSS one catches pseudo-element
 * rules coming back; the config one catches the subtler regression — flipping
 * `experimental.viewTransition` back on without a boundary just recreates the
 * inert layer that already misled one investigation.
 */
describe("retired View Transitions layer (#1379)", () => {
  test("globals.css ships no view-transition rules", () => {
    expect(css).not.toContain("::view-transition-");
    expect(css).not.toContain("view-transition-name");
    expect(css).not.toContain("@view-transition");
  });

  test("the experimental viewTransition flag stays off", () => {
    expect(nextConfig).not.toMatch(/viewTransition\s*:/);
  });
});
