/**
 * Exposure-profile CRUD round-trip (PRD #539 / ADR 0039): hand-entered profiles
 * persist through save / read / delete against a real SQLite database migrated
 * to the current schema version. Save is an upsert by key — the profile is a
 * shared canonical row, so editing it twice merges onto the one row.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExposureProfile } from "@worthline/domain";
import { parseWorkspaceExport } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createWorthlineStore } from "./index";

async function freshStore(): Promise<Awaited<ReturnType<typeof createWorthlineStore>>> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-exposure-")), "w.sqlite");
  const store = await createWorthlineStore({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  return store;
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

describe("exposure profile CRUD", () => {
  it("saves a hand-entered profile with row provenance", async () => {
    const store = await freshStore();
    await store.exposureProfiles.saveExposureProfile(vwrl);

    const profile = await store.exposureProfiles.readExposureProfile("IE00B3RBWM25");
    expect(profile).toEqual({
      ...vwrl,
      declaredAt: expect.any(String),
      source: "user",
    });
  });

  it("lists all profiles ordered by key", async () => {
    const store = await freshStore();
    await store.exposureProfiles.saveExposureProfile(vwrl);
    await store.exposureProfiles.saveExposureProfile({
      key: "FINECT-PLAN-1",
      hedged: false,
      breakdowns: { assetClass: { equity: "1" } },
    });

    const profiles = await store.exposureProfiles.readExposureProfiles();
    expect(profiles.map((p) => p.key)).toEqual(["FINECT-PLAN-1", "IE00B3RBWM25"]);
  });

  it("upserts by key — a second save merges onto the one canonical row", async () => {
    const store = await freshStore();
    await store.exposureProfiles.saveExposureProfile(vwrl);
    await store.exposureProfiles.saveExposureProfile({
      key: vwrl.key,
      hedged: true,
      breakdowns: { geography: { us: "0.7" } },
    });

    const all = await store.exposureProfiles.readExposureProfiles();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      key: "IE00B3RBWM25",
      hedged: true,
      source: "user",
      ter: "0.0022",
      trackedIndex: "FTSE All-World",
    });
    expect(all[0]!.breakdowns.geography).toEqual({ us: "0.7" });
    expect(all[0]!.breakdowns.assetClass).toEqual({ equity: "1" });
  });

  it("flips row provenance to the writer and preserves untouched fields", async () => {
    const store = await freshStore();
    await store.exposureProfiles.saveExposureProfile({
      ...vwrl,
      declaredAt: "2026-01-01T00:00:00.000Z",
    });

    await store.exposureProfiles.saveExposureProfile({
      key: vwrl.key,
      source: "agent",
      declaredAt: "2026-02-01T00:00:00.000Z",
      breakdowns: { geography: { us: "0.7" } },
    });

    expect(await store.exposureProfiles.readExposureProfile(vwrl.key)).toMatchObject({
      declaredAt: "2026-02-01T00:00:00.000Z",
      source: "agent",
      ter: "0.0022",
      trackedIndex: "FTSE All-World",
    });

    await store.exposureProfiles.saveExposureProfile({
      key: vwrl.key,
      declaredAt: "2026-03-01T00:00:00.000Z",
      ter: "0.0018",
    });

    const profile = await store.exposureProfiles.readExposureProfile(vwrl.key);
    expect(profile).toMatchObject({
      declaredAt: "2026-03-01T00:00:00.000Z",
      source: "user",
      ter: "0.0018",
      trackedIndex: "FTSE All-World",
    });
    expect(profile!.breakdowns.geography).toEqual({ us: "0.7" });
    expect(profile!.breakdowns.assetClass).toEqual({ equity: "1" });
  });

  it("returns null for an unknown key and deletes a stored one", async () => {
    const store = await freshStore();
    expect(await store.exposureProfiles.readExposureProfile("nope")).toBeNull();

    await store.exposureProfiles.saveExposureProfile(vwrl);
    await store.exposureProfiles.deleteExposureProfile("IE00B3RBWM25");
    expect(await store.exposureProfiles.readExposureProfiles()).toEqual([]);
  });
});

describe("exposure profile export / import round-trip (PRD #539 S1)", () => {
  it("carries hand-entered profiles through export then import into a fresh workspace", async () => {
    const store = await freshStore();
    await store.exposureProfiles.saveExposureProfile(vwrl);
    await store.exposureProfiles.saveExposureProfile({
      key: "FINECT-PLAN-1",
      hedged: true,
      breakdowns: { assetClass: { equity: "1" } },
    });

    const doc = await store.workspace.exportWorkspace();
    expect(doc.exposureProfiles).toHaveLength(2);
    expect(doc.exposureProfiles[0]).toMatchObject({
      declaredAt: expect.any(String),
      source: "user",
    });

    const target = await freshStore();
    await target.workspace.importWorkspace(doc);

    expect(await target.exposureProfiles.readExposureProfiles()).toEqual(
      doc.exposureProfiles,
    );
  });

  it("parses an older export that omits the exposureProfiles section (defaults to [])", async () => {
    const store = await freshStore();
    const doc = await store.workspace.exportWorkspace();
    const legacy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    delete legacy.exposureProfiles;

    const parsed = parseWorkspaceExport(legacy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.exposureProfiles).toEqual([]);
    }
  });

  it("rejects an imported profile whose breakdown exceeds 100%", async () => {
    const store = await freshStore();
    const doc = await store.workspace.exportWorkspace();
    const tampered = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    tampered.exposureProfiles = [
      { key: "IE00B3RBWM25", breakdowns: { geography: { us: "0.6", emerging: "0.7" } } },
    ];

    const parsed = parseWorkspaceExport(tampered);
    expect(parsed.ok).toBe(false);
  });
});
