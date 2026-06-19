/**
 * Demo store provider tests (S1 #299). The provider is shallow I/O plumbing
 * (the e2e journey is its main exercise), so these cover only its load-bearing
 * contract: in demo mode it opens a writable copy seeded with the persona's data,
 * memoizes that copy per persona, and NEVER mutates a bundled fixture.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorthlineStore } from "@worthline/db";

import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";
import {
  getDemoStorePath,
  openDemoStore,
  resetDemoStoreCache,
} from "@web/demo/store-provider";

const AS_OF = "2026-06-19";

afterEach(() => {
  resetDemoStoreCache();
  delete process.env.WORTHLINE_DEMO_FIXTURE_DIR;
});

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("demo store provider", () => {
  it("lazily seeds and opens a usable familia store when no fixture is bundled", () => {
    const store = openDemoStore("familia", AS_OF);
    const workspace = store.workspace.readWorkspace();
    expect(workspace?.members.length).toBe(2);
    store.close();
  });

  it("memoizes the temp copy per persona within a process", () => {
    const first = getDemoStorePath("familia", AS_OF);
    const second = getDemoStorePath("familia", AS_OF);
    expect(second).toBe(first);
  });

  it("opens a copy in a temp dir, never the bundled fixture, and leaves it intact", () => {
    // Build a "bundled" fixture on disk.
    const fixtureDir = mkdtempSync(join(tmpdir(), "worthline-demo-fixtures-"));
    const fixturePath = join(fixtureDir, "familia.sqlite");
    const seed = createWorthlineStore({ databasePath: fixturePath });
    seedPersona(seed, FAMILIA_SPEC, AS_OF);
    seed.close();
    const fixtureHashBefore = hashFile(fixturePath);

    process.env.WORTHLINE_DEMO_FIXTURE_DIR = fixtureDir;
    resetDemoStoreCache();

    const openedPath = getDemoStorePath("familia", AS_OF);
    expect(openedPath).not.toBe(fixturePath);

    // An involuntary write (as a page load would make) lands on the copy.
    const store = openDemoStore("familia", AS_OF);
    store.assets.updateAssetValuation("asset_familia_checking", 99_999_00);
    store.close();

    // The bundled fixture is byte-for-byte unchanged.
    expect(hashFile(fixturePath)).toBe(fixtureHashBefore);
  });
});
