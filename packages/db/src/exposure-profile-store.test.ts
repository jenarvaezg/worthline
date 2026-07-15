/**
 * Exposure-profile read + export/import round-trip (PRD #539 / ADR 0039).
 * Workspace store is read-only for profiles (#1014); seeding uses import.
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

async function seedProfiles(
  store: Awaited<ReturnType<typeof createWorthlineStore>>,
  profiles: ExposureProfile[],
): Promise<void> {
  const doc = await store.workspace.exportWorkspace();
  doc.exposureProfiles = [...doc.exposureProfiles, ...profiles];
  await store.workspace.importWorkspace(doc);
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
  it("reads a profile seeded via workspace import", async () => {
    const store = await freshStore();
    await seedProfiles(store, [vwrl]);

    const profile = await store.exposureProfiles.readExposureProfile("IE00B3RBWM25");
    expect(profile).toEqual(vwrl);
  });

  it("lists all profiles ordered by key", async () => {
    const store = await freshStore();
    await seedProfiles(store, [
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
    const store = await freshStore();
    expect(await store.exposureProfiles.readExposureProfile("nope")).toBeNull();
  });
});

describe("exposure profile export / import round-trip (PRD #539 S1)", () => {
  it("carries hand-entered profiles through export then import into a fresh workspace", async () => {
    const store = await freshStore();
    await seedProfiles(store, [
      vwrl,
      {
        key: "FINECT-PLAN-1",
        source: "user",
        declaredAt: null,
        hedged: true,
        breakdowns: { assetClass: { equity: "1" } },
      },
    ]);

    const doc = await store.workspace.exportWorkspace();
    expect(doc.exposureProfiles).toHaveLength(2);

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
