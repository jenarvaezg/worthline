/**
 * Exposure-profile read + v3 backup contract (PRD #539 / ADR 0039, #942).
 * Workspace store is read-only for profiles (#1014); v3 backups no longer
 * export or import profiles — seeding uses direct SQL on the legacy table.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import type { ExposureProfile } from "@worthline/domain";
import { parseWorkspaceExport } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createWorthlineStore } from "./index";

async function freshStore(): Promise<{
  store: Awaited<ReturnType<typeof createWorthlineStore>>;
  dbPath: string;
}> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-exposure-")), "w.sqlite");
  const store = await createWorthlineStore({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  return { store, dbPath };
}

async function seedProfiles(dbPath: string, profiles: ExposureProfile[]): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    for (const profile of profiles) {
      await client.execute({
        sql: `INSERT INTO exposure_profiles (
          key, source, declared_at, tracked_index, ter, hedged, breakdowns_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          profile.key,
          profile.source,
          profile.declaredAt,
          profile.trackedIndex ?? null,
          profile.ter ?? null,
          profile.hedged ? 1 : 0,
          JSON.stringify(profile.breakdowns ?? {}),
        ],
      });
    }
  } finally {
    client.close();
  }
}

const vwrl: ExposureProfile = {
  key: "IE00B3RBWM25",
  source: "user",
  declaredAt: null,
  trackedIndex: "FTSE All-World",
  ter: "0.0022",
  hedged: false,
  breakdowns: {
    geography: { us: "0.6", europe_developed: "0.15", emerging: "0.1" },
    assetClass: { equity: "1" },
  },
};

describe("exposure profile reads", () => {
  it("reads a profile seeded directly in the legacy table", async () => {
    const { store, dbPath } = await freshStore();
    await seedProfiles(dbPath, [vwrl]);

    const profile = await store.exposureProfiles.readExposureProfile("IE00B3RBWM25");
    expect(profile).toEqual(vwrl);
  });

  it("lists all profiles ordered by key", async () => {
    const { store, dbPath } = await freshStore();
    await seedProfiles(dbPath, [
      vwrl,
      {
        key: "FINECT-PLAN-1",
        source: "user",
        declaredAt: null,
        hedged: false,
        breakdowns: { assetClass: { equity: "1" } },
      },
    ]);

    const profiles = await store.exposureProfiles.readExposureProfiles();
    expect(profiles.map((p) => p.key)).toEqual(["FINECT-PLAN-1", "IE00B3RBWM25"]);
  });

  it("returns null for an unknown key", async () => {
    const { store } = await freshStore();
    expect(await store.exposureProfiles.readExposureProfile("nope")).toBeNull();
  });
});

describe("exposure profiles and v3 workspace backups (#942)", () => {
  it("v3 export omits exposureProfiles even when the legacy table has rows", async () => {
    const { store, dbPath } = await freshStore();
    await seedProfiles(dbPath, [vwrl]);

    const doc = await store.workspace.exportWorkspace();
    expect("exposureProfiles" in doc).toBe(false);
  });

  it("import does not persist profiles from a tampered v3 file", async () => {
    const { store } = await freshStore();
    const doc = await store.workspace.exportWorkspace();
    const tampered = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    tampered.exposureProfiles = [
      { key: "IE00B3RBWM25", breakdowns: { geography: { us: "0.6", emerging: "0.7" } } },
    ];

    const parsed = parseWorkspaceExport(tampered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[0]).toMatch(/exposureProfiles/);
    }

    const { store: target } = await freshStore();
    await expect(target.workspace.importWorkspace(doc)).resolves.toBeDefined();
    expect(await target.exposureProfiles.readExposureProfiles()).toEqual([]);
  });
});
