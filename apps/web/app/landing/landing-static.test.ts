import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Static invariant of the public landing (#951, gate of PRD #877): the route
 * prerenders at build time and serves as pure static HTML — no per-visit
 * cookie reads, no DB access, no client components. This test is the CI
 * tripwire: any import that would drag the route into dynamic rendering
 * fails here instead of shipping.
 */

const landingDir = dirname(fileURLToPath(import.meta.url));

const sources = readdirSync(landingDir)
  .filter((name) => /\.(ts|tsx|css)$/.test(name) && !name.includes(".test."))
  .map((name) => ({ name, text: readFileSync(join(landingDir, name), "utf8") }));

/** Anything that reads the request or a store makes the route dynamic. */
const FORBIDDEN = [
  "use client",
  "force-dynamic",
  "next/headers",
  "@worthline/db",
  "@web/read-store-target",
  "@web/store",
  "next-auth",
  "@web/auth",
];

describe("landing static invariant (#951)", () => {
  test("the page opts into static rendering explicitly", () => {
    const page = sources.find((s) => s.name === "page.tsx");

    expect(page, "app/landing/page.tsx missing").toBeDefined();
    expect(page!.text).toContain('export const dynamic = "force-static"');
  });

  test("no landing source can read cookies, a store, or go client-side", () => {
    expect(sources.length).toBeGreaterThan(0);

    for (const { name, text } of sources) {
      for (const marker of FORBIDDEN) {
        expect(text.includes(marker), `${name} contains forbidden «${marker}»`).toBe(
          false,
        );
      }
    }
  });
});
