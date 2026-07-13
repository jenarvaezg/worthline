import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Static invariant of the public landing (#951, gate of PRD #877): the route
 * prerenders at build time and serves as pure static HTML — no per-visit
 * cookie reads or DB access. #953 permits exactly one progressive client island
 * for session presentation and motion orchestration; this tripwire keeps that
 * exception narrow instead of letting the route drift into dynamic rendering.
 *
 * Estreno (#954): the route file moved to `app/page.tsx` when the landing was
 * promoted to `/`, so the force-static assertion follows it to the root page;
 * the landing module (this directory) keeps holding the components.
 */

const landingDir = dirname(fileURLToPath(import.meta.url));
const rootPagePath = join(landingDir, "..", "page.tsx");

const componentSources = readdirSync(landingDir)
  .filter((name) => /\.(ts|tsx|css)$/.test(name) && !name.includes(".test."))
  .map((name) => ({ name, text: readFileSync(join(landingDir, name), "utf8") }));

const rootPage = { name: "../page.tsx", text: readFileSync(rootPagePath, "utf8") };

/** Anything that reads the request or a store makes the route dynamic. */
const FORBIDDEN = [
  "force-dynamic",
  "next/headers",
  "@worthline/db",
  "@web/read-store-target",
  "@web/store",
  "next-auth",
  "@web/auth",
];

describe("landing static invariant (#951, estreno #954)", () => {
  test("the root page opts into static rendering explicitly", () => {
    expect(rootPage.text).toContain('export const dynamic = "force-static"');
  });

  test("neither the root page nor any landing source reads cookies, a store, or opts into dynamic rendering", () => {
    const sources = [rootPage, ...componentSources];
    expect(sources.length).toBeGreaterThan(1);

    for (const { name, text } of sources) {
      for (const marker of FORBIDDEN) {
        expect(text.includes(marker), `${name} contains forbidden «${marker}»`).toBe(
          false,
        );
      }
    }
  });

  test("allows exactly the single progressive landing experience island", () => {
    const clientSources = componentSources.filter(({ text }) =>
      text.includes('"use client"'),
    );

    expect(clientSources.map(({ name }) => name)).toEqual(["landing-experience.tsx"]);
  });
});
