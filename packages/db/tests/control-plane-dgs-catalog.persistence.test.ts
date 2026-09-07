import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneStore } from "@db/control-plane";
import {
  createExposureProfileCatalog,
  EXPOSURE_PROFILE_SCHEMA,
} from "@db/control-plane/exposure-profile-catalog";
import {
  createMaintainerAlertLog,
  MAINTAINER_ALERT_SCHEMA,
} from "@db/control-plane/maintainer-alert-log";
import {
  CP_SCHEMA_VERSION,
  migrateControlPlane,
  readControlPlaneSchemaVersion,
} from "@db/control-plane/migrate";
import { openLibsqlClient } from "@db/libsql-client";
import { afterAll, describe, expect, test } from "vitest";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function legacyCatalog() {
  const dir = mkdtempSync(join(tmpdir(), "worthline-catalog-v8-"));
  dirs.push(dir);
  const url = `file:${join(dir, "cp.sqlite")}`;
  const client = openLibsqlClient({ url });
  await client.executeMultiple(`
    CREATE TABLE global_exposure_profiles (
      identity_key TEXT PRIMARY KEY NOT NULL, identity_kind TEXT NOT NULL,
      isin TEXT, price_provider TEXT, provider_symbol TEXT, display_name TEXT,
      breakdowns_json TEXT NOT NULL DEFAULT '{}', ter TEXT, tracked_index TEXT,
      hedged_to_currency TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confidence TEXT, as_of_date TEXT, sources TEXT
    );
    CREATE UNIQUE INDEX global_exposure_profiles_isin ON global_exposure_profiles(isin) WHERE isin IS NOT NULL;
    CREATE UNIQUE INDEX global_exposure_profiles_provider ON global_exposure_profiles(price_provider, provider_symbol)
      WHERE price_provider IS NOT NULL AND provider_symbol IS NOT NULL;
    CREATE TABLE cp_schema_meta (version INTEGER NOT NULL);
    INSERT INTO cp_schema_meta VALUES (8);
  `);
  await client.executeMultiple(MAINTAINER_ALERT_SCHEMA);
  return { client, url, catalog: createExposureProfileCatalog(client) };
}

const provider = (providerSymbol: string) => ({
  priceProvider: "finect" as const,
  providerSymbol,
});
const dgs = { securityId: { kind: "dgs" as const, value: "N5394" } };
const content = {
  displayName: "Plan pensiones",
  breakdowns: { assetClass: { equity: "0.8", bond: "0.2" }, geography: { us: "0.6" } },
  ter: "0.0035",
  trackedIndex: "Global",
  hedgedToCurrency: "EUR",
  confidence: "alta",
  asOfDate: "2026-07-31",
  sources: "Ficha gestora",
};

async function insertLegacy(
  client: ReturnType<typeof openLibsqlClient>,
  symbol: string,
  curated = true,
) {
  await client.execute({
    sql: `INSERT INTO global_exposure_profiles (
      identity_key, identity_kind, price_provider, provider_symbol, display_name,
      breakdowns_json, ter, tracked_index, hedged_to_currency,
      confidence, as_of_date, sources, created_at, updated_at
    ) VALUES (?, 'provider', 'finect', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2024-01-02 03:04:05', '2025-06-07 08:09:10')`,
    args: [
      `p:finect:${symbol}`,
      symbol,
      curated ? content.displayName : "Named stub",
      JSON.stringify(curated ? content.breakdowns : {}),
      curated ? content.ter : null,
      curated ? content.trackedIndex : null,
      curated ? content.hedgedToCurrency : null,
      curated ? content.confidence : null,
      curated ? content.asOfDate : null,
      curated ? content.sources : null,
    ],
  });
}

describe("DGS catalog migration (#1744)", () => {
  test("opening v8 rekeys a Finect plan in place with all content and timestamps intact; rerunning is a no-op", async () => {
    const { client, catalog, url } = await legacyCatalog();
    await insertLegacy(client, "N5394-Plan");
    const before = await catalog.readGlobalExposureProfile(provider("N5394-Plan"));
    const cp = await createControlPlaneStore({ url });
    try {
      const expected = { ...before, identity: { kind: "dgs", code: "N5394" } };
      expect(await cp.readGlobalExposureProfile(dgs)).toEqual(expected);
      expect(await cp.readGlobalExposureProfile(provider("N5394-Plan"))).toBeNull();
      await migrateControlPlane(client);
      expect(await cp.readGlobalExposureProfiles()).toEqual([expected]);
      expect(await readControlPlaneSchemaVersion(client)).toBe(CP_SCHEMA_VERSION);
    } finally {
      cp.close();
      client.close();
    }
  });
  test.each([
    true,
    false,
  ])("curated content wins over a named stub regardless of insertion order (curated first: %s)", async (curatedFirst) => {
    const { client, catalog } = await legacyCatalog();
    try {
      for (const curated of [curatedFirst, !curatedFirst]) {
        await insertLegacy(client, curated ? "N5394-Curated" : "N5394-Stub", curated);
      }
      const before = await catalog.readGlobalExposureProfile(provider("N5394-Curated"));
      const stub = await catalog.readGlobalExposureProfile(provider("N5394-Stub"));
      await migrateControlPlane(client);
      expect(await catalog.readGlobalExposureProfile(dgs)).toEqual({
        ...before,
        identity: { kind: "dgs", code: "N5394" },
      });
      expect(await catalog.readGlobalExposureProfile(provider("N5394-Stub"))).toEqual(
        stub,
      );
      expect(await catalog.readGlobalExposureProfiles()).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  test("two curated rows retain both profiles and emit one inspectable collision alert", async () => {
    const { client, catalog } = await legacyCatalog();
    try {
      await insertLegacy(client, "N5394-First");
      await insertLegacy(client, "N5394-Second");
      const first = await catalog.readGlobalExposureProfile(provider("N5394-First"));
      const second = await catalog.readGlobalExposureProfile(provider("N5394-Second"));
      await migrateControlPlane(client);
      await migrateControlPlane(client);
      expect(await catalog.readGlobalExposureProfile(dgs)).toEqual({
        ...first,
        identity: { kind: "dgs", code: "N5394" },
      });
      expect(await catalog.readGlobalExposureProfile(provider("N5394-Second"))).toEqual(
        second,
      );
      expect(await catalog.readGlobalExposureProfiles()).toHaveLength(2);
      const log = createMaintainerAlertLog(client, () => "unused");
      const alerts = await log.listMaintainerAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        category: "catalog_identity_collision",
        workspaceId: "catalog",
        holdingId: "dgs:N5394",
        occurrenceCount: 1,
        status: "open",
      });
      const detail = await log.getMaintainerAlert(alerts[0]!.id);
      expect(detail?.occurrences).toHaveLength(1);
      expect(detail?.occurrences[0]?.payload).toMatchObject({
        category: "catalog_identity_collision",
        dgsCode: "N5394",
        canonicalIdentityKey: "dgs:N5394",
        retainedProviderIdentityKey: "p:finect:N5394-Second",
      });
    } finally {
      client.close();
    }
  });

  test("fresh and migrated catalogs have identical column layouts and DGS uniqueness", async () => {
    const { client } = await legacyCatalog();
    const fresh = openLibsqlClient({ url: "file::memory:" });
    try {
      await migrateControlPlane(client);
      await fresh.executeMultiple(EXPOSURE_PROFILE_SCHEMA);
      const migratedColumns = await client.execute(
        "PRAGMA table_info(global_exposure_profiles)",
      );
      const freshColumns = await fresh.execute(
        "PRAGMA table_info(global_exposure_profiles)",
      );
      expect(migratedColumns.rows).toEqual(freshColumns.rows);
      for (const target of [client, fresh]) {
        await target.execute(`INSERT INTO global_exposure_profiles (identity_key, identity_kind, dgs_code)
          VALUES ('dgs:N5394', 'dgs', 'N5394')`);
        await expect(
          target.execute(`INSERT INTO global_exposure_profiles (identity_key, identity_kind, dgs_code)
          VALUES ('another-key', 'dgs', 'N5394')`),
        ).rejects.toThrow(/UNIQUE constraint failed.*dgs_code/);
      }
    } finally {
      client.close();
      fresh.close();
    }
  });

  test("only Finect symbols with an exact N plus four digit prefix are rekeyed", async () => {
    const { client, catalog } = await legacyCatalog();
    const untouched = [
      "n5394-plan",
      "N539-plan",
      "N53940-plan",
      " N5394-plan",
      "N5394x-plan",
      "plan-N5394",
      "N5394 -plan",
    ];
    try {
      for (const symbol of ["N5394", "N1234-plan-extra", ...untouched]) {
        await insertLegacy(client, symbol, false);
      }
      await client.execute(`INSERT INTO global_exposure_profiles (identity_key, identity_kind, price_provider, provider_symbol)
        VALUES ('p:yahoo:N4321-plan', 'provider', 'yahoo', 'N4321-plan')`);
      await migrateControlPlane(client);
      expect(await catalog.readGlobalExposureProfile(dgs)).not.toBeNull();
      expect(
        await catalog.readGlobalExposureProfile({
          securityId: { kind: "dgs", value: "N1234" },
        }),
      ).not.toBeNull();
      const profiles = await catalog.readGlobalExposureProfiles();
      expect(
        profiles
          .filter((profile) => profile.identity.kind === "provider")
          .map((profile) => profile.identity),
      ).toEqual(
        expect.arrayContaining([
          ...untouched.map((symbol) => ({ kind: "provider", ...provider(symbol) })),
          { kind: "provider", priceProvider: "yahoo", providerSymbol: "N4321-plan" },
        ]),
      );
      expect(profiles).toHaveLength(10);
    } finally {
      client.close();
    }
  });

  test("manual DGS creation, rekey, collision rejection and rekey away preserve content", async () => {
    const { client, catalog } = await legacyCatalog();
    try {
      await migrateControlPlane(client);
      const created = await catalog.createGlobalExposureProfile({
        identity: dgs,
        ...content,
      });
      expect(await catalog.readGlobalExposureProfile(dgs)).toEqual(created);
      await expect(
        catalog.createGlobalExposureProfile({ identity: dgs, ...content }),
      ).rejects.toThrow(/already exists/);
      const nextDgs = { securityId: { kind: "dgs" as const, value: "N1234" } };
      const rekeyed = await catalog.rekeyGlobalExposureProfile(dgs, nextDgs);
      expect(rekeyed).toMatchObject({
        ...content,
        identity: { kind: "dgs", code: "N1234" },
        createdAt: created.createdAt,
      });
      expect(await catalog.readGlobalExposureProfile(dgs)).toBeNull();
      const away = await catalog.rekeyGlobalExposureProfile(nextDgs, provider("Plan"));
      expect(away.identity).toEqual({ kind: "provider", ...provider("Plan") });
      const raw = await client.execute(
        "SELECT dgs_code FROM global_exposure_profiles WHERE identity_key = 'p:finect:Plan'",
      );
      expect(raw.rows[0]?.dgs_code).toBeNull();
      await catalog.createGlobalExposureProfile({ identity: dgs, ...content });
      await expect(
        catalog.rekeyGlobalExposureProfile(provider("Plan"), dgs),
      ).rejects.toThrow(/already exists/);
    } finally {
      client.close();
    }
  });

  test("a failed collision alert rolls back the rekeys and schema version together", async () => {
    const { client, catalog } = await legacyCatalog();
    try {
      await insertLegacy(client, "N5394-First");
      await insertLegacy(client, "N5394-Second");
      const before = await catalog.readGlobalExposureProfiles();
      await client.execute(`CREATE TRIGGER fail_collision_alert BEFORE INSERT ON maintainer_alert_occurrences
        BEGIN SELECT RAISE(ABORT, 'simulated alert storage failure'); END`);
      await expect(migrateControlPlane(client)).rejects.toThrow(
        /simulated alert storage failure/,
      );
      expect(await readControlPlaneSchemaVersion(client)).toBe(8);
      expect(await catalog.readGlobalExposureProfiles()).toEqual(before);
      expect(
        await createMaintainerAlertLog(client, () => "unused").listMaintainerAlerts(),
      ).toEqual([]);
      await client.execute("DROP TRIGGER fail_collision_alert");
      await migrateControlPlane(client);
      expect(await readControlPlaneSchemaVersion(client)).toBe(CP_SCHEMA_VERSION);
      expect(await catalog.readGlobalExposureProfile(dgs)).not.toBeNull();
    } finally {
      client.close();
    }
  });

  test("legacy unreadable breakdowns survive migration and are never mistaken for a stub", async () => {
    const { client } = await legacyCatalog();
    try {
      await insertLegacy(client, "N5394-Stub", false);
      await insertLegacy(client, "N5394-Legacy", false);
      await insertLegacy(client, "Unrelated", false);
      await client.execute(`UPDATE global_exposure_profiles SET breakdowns_json = 'legacy unreadable payload'
        WHERE provider_symbol IN ('N5394-Legacy', 'Unrelated')`);
      await migrateControlPlane(client);
      const canonical = await client.execute(
        "SELECT breakdowns_json FROM global_exposure_profiles WHERE identity_key = 'dgs:N5394'",
      );
      expect(canonical.rows[0]?.breakdowns_json).toBe("legacy unreadable payload");
      const retained = await client.execute(
        "SELECT identity_key, breakdowns_json FROM global_exposure_profiles WHERE identity_kind = 'provider' ORDER BY identity_key",
      );
      expect(retained.rows).toEqual([
        { identity_key: "p:finect:N5394-Stub", breakdowns_json: "{}" },
        {
          identity_key: "p:finect:Unrelated",
          breakdowns_json: "legacy unreadable payload",
        },
      ]);
    } finally {
      client.close();
    }
  });
});
