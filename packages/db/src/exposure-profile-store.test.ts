/**
 * Exposure-profile CRUD round-trip (PRD #539 / ADR 0039): hand-entered profiles
 * persist through save / read / delete against a real SQLite database migrated
 * to the current schema version. Save is an upsert by key — the profile is a
 * shared canonical row, so editing it twice overwrites the one row.
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
  trackedIndex: "FTSE All-World",
  ter: "0.0022",
  hedged: false,
  breakdowns: {
    geography: { us: "0.6", europe_developed: "0.15", emerging: "0.1" },
    assetClass: { equity: "1" },
  },
};

describe("exposure profile CRUD", () => {
  it("saves a hand-entered profile and reads it back verbatim", async () => {
    const store = await freshStore();
    await store.exposureProfiles.saveExposureProfile(vwrl);

    const profile = await store.exposureProfiles.readExposureProfile("IE00B3RBWM25");
    expect(profile).toEqual(vwrl);
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

  it("upserts by key — a second save overwrites the one canonical row", async () => {
    const store = await freshStore();
    await store.exposureProfiles.saveExposureProfile(vwrl);
    await store.exposureProfiles.saveExposureProfile({
      ...vwrl,
      hedged: true,
      trackedIndex: "MSCI World",
      breakdowns: { geography: { us: "0.7" }, assetClass: { equity: "1" } },
    });

    const all = await store.exposureProfiles.readExposureProfiles();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      key: "IE00B3RBWM25",
      hedged: true,
      trackedIndex: "MSCI World",
    });
    expect(all[0]!.breakdowns.geography).toEqual({ us: "0.7" });
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

    const target = await freshStore();
    await target.workspace.importWorkspace(doc);

    expect(await target.exposureProfiles.readExposureProfiles()).toEqual([
      {
        key: "FINECT-PLAN-1",
        trackedIndex: null,
        ter: null,
        hedged: true,
        breakdowns: { assetClass: { equity: "1" } },
      },
      vwrl,
    ]);
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
