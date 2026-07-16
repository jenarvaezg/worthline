import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlPlaneStore,
  createInMemoryControlPlaneStore,
} from "@db/control-plane";
import {
  CP_SCHEMA_VERSION,
  migrateControlPlane,
  readControlPlaneSchemaVersion,
} from "@db/control-plane-migrate";
import { openLibsqlClient } from "@db/libsql-client";
import { afterAll, describe, expect, test } from "vitest";

const VWRL_ISIN = "IE00B3RBWM25";
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

async function seedPreCatalogControlPlane(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "worthline-cp-pre-catalog-"));
  tempDirs.push(dir);
  const url = `file:${join(dir, "control-plane.sqlite")}`;
  const raw = openLibsqlClient({ url });
  await raw.executeMultiple(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      db_name TEXT NOT NULL UNIQUE,
      db_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE grants (
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, workspace_id)
    );
    CREATE TABLE benchmark_prices (
      series_id TEXT NOT NULL,
      date TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (series_id, date)
    );
  `);
  raw.close();
  return url;
}

describe("control-plane global exposure profile migration (#1010)", () => {
  test("forward-only migration creates the catalog table on an existing control plane", async () => {
    const url = await seedPreCatalogControlPlane();
    const cp = await createControlPlaneStore({ url });
    try {
      const columns = (
        await openLibsqlClient({ url }).execute(
          "PRAGMA table_info(global_exposure_profiles)",
        )
      ).rows as unknown as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "identity_key",
        "identity_kind",
        "isin",
        "price_provider",
        "provider_symbol",
        "display_name",
        "breakdowns_json",
        "ter",
        "tracked_index",
        "hedged_to_currency",
        "created_at",
        "updated_at",
      ]);
      expect(await readControlPlaneSchemaVersion(openLibsqlClient({ url }))).toBe(
        CP_SCHEMA_VERSION,
      );
    } finally {
      cp.close();
    }
  });

  test("re-opening an already-migrated control plane is a no-op", async () => {
    const url = await seedPreCatalogControlPlane();
    const client = openLibsqlClient({ url });
    await migrateControlPlane(client);
    await migrateControlPlane(client);
    expect(await readControlPlaneSchemaVersion(client)).toBe(CP_SCHEMA_VERSION);
    client.close();
  });

  test("forward migration creates the maintainer-alert tables (#1050)", async () => {
    const url = await seedPreCatalogControlPlane();
    const cp = await createControlPlaneStore({ url });
    try {
      const client = openLibsqlClient({ url });
      const tables = (
        await client.execute(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'maintainer_alert%'",
        )
      ).rows.map((row) => String(row["name"]));
      expect(tables).toContain("maintainer_alerts");
      expect(tables).toContain("maintainer_alert_occurrences");
      client.close();
    } finally {
      cp.close();
    }
  });
});

describe("control-plane global exposure profile store (#1010)", () => {
  test("create fails on duplicate identity and read returns the stored profile", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const created = await cp.createGlobalExposureProfile({
        identity: { isin: VWRL_ISIN },
        trackedIndex: "FTSE All-World",
        ter: "0.0022",
        breakdowns: {
          geography: { us: "0.6", europe_developed: "0.15" },
          assetClass: { equity: "1" },
        },
      });
      expect(created.identity).toEqual({ kind: "isin", isin: VWRL_ISIN });
      expect(created.trackedIndex).toBe("FTSE All-World");
      expect(created.createdAt).toBeTruthy();
      expect(created.updatedAt).toBeTruthy();

      await expect(
        cp.createGlobalExposureProfile({
          identity: { isin: VWRL_ISIN },
          breakdowns: { assetClass: { equity: "1" } },
        }),
      ).rejects.toThrow(/already exists/);

      expect(await cp.readGlobalExposureProfile({ isin: VWRL_ISIN })).toEqual(created);
    } finally {
      cp.close();
    }
  });

  test("update replaces editable content atomically", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const created = await cp.createGlobalExposureProfile({
        identity: { isin: VWRL_ISIN },
        displayName: "VWRL",
        breakdowns: { assetClass: { equity: "1" } },
        ter: "0.0022",
      });

      const updated = await cp.updateGlobalExposureProfile(
        { isin: VWRL_ISIN },
        {
          displayName: "Vanguard FTSE All-World",
          breakdowns: {
            geography: { us: "0.55" },
            assetClass: { equity: "0.9", bond: "0.1" },
          },
          ter: "0.002",
          hedgedToCurrency: "EUR",
        },
      );

      expect(updated).toMatchObject({
        displayName: "Vanguard FTSE All-World",
        ter: "0.002",
        hedgedToCurrency: "EUR",
        createdAt: created.createdAt,
      });
      expect(updated.breakdowns).toEqual({
        geography: { us: "0.55" },
        assetClass: { equity: "0.9", bond: "0.1" },
      });
    } finally {
      cp.close();
    }
  });

  test("rekey preserves createdAt and fails on collision", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const created = await cp.createGlobalExposureProfile({
        identity: { priceProvider: "yahoo", providerSymbol: "VWRL.L" },
        breakdowns: { assetClass: { equity: "1" } },
      });
      await cp.createGlobalExposureProfile({
        identity: { isin: VWRL_ISIN },
        breakdowns: { assetClass: { equity: "1" } },
      });

      const rekeyed = await cp.rekeyGlobalExposureProfile(
        { priceProvider: "yahoo", providerSymbol: "VWRL.L" },
        { isin: "IE00BK5BQT80" },
      );
      expect(rekeyed.identity).toEqual({ kind: "isin", isin: "IE00BK5BQT80" });
      expect(rekeyed.createdAt).toBe(created.createdAt);

      await expect(
        cp.rekeyGlobalExposureProfile({ isin: VWRL_ISIN }, { isin: "IE00BK5BQT80" }),
      ).rejects.toThrow(/already exists/);
    } finally {
      cp.close();
    }
  });

  test("delete removes the row physically and readAll lists remaining profiles", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await cp.createGlobalExposureProfile({
        identity: { isin: VWRL_ISIN },
        breakdowns: { assetClass: { equity: "1" } },
      });
      await cp.createGlobalExposureProfile({
        identity: { priceProvider: "finect", providerSymbol: "N5394" },
        breakdowns: { assetClass: { equity: "1" } },
      });

      await cp.deleteGlobalExposureProfile({ isin: VWRL_ISIN });
      expect(await cp.readGlobalExposureProfile({ isin: VWRL_ISIN })).toBeNull();
      expect(await cp.readGlobalExposureProfiles()).toHaveLength(1);
    } finally {
      cp.close();
    }
  });
});

describe("control-plane exposure profile stub registration (#1097)", () => {
  test("registers an empty, curatable stub for a brand-new identity", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await cp.ensureGlobalExposureProfileStub(
        { isin: VWRL_ISIN, kind: "isin" },
        "MSCI World",
      );

      const stub = await cp.readGlobalExposureProfile({ isin: VWRL_ISIN });
      expect(stub).toMatchObject({
        identity: { isin: VWRL_ISIN, kind: "isin" },
        displayName: "MSCI World",
        breakdowns: {},
        ter: null,
        trackedIndex: null,
        hedgedToCurrency: null,
      });
      expect(stub?.createdAt).toBeTruthy();
      expect(stub?.updatedAt).toBeTruthy();
    } finally {
      cp.close();
    }
  });

  test("is idempotent: two calls leave exactly one row and never throw", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await cp.ensureGlobalExposureProfileStub(
        { kind: "provider", priceProvider: "yahoo", providerSymbol: "VWRL.L" },
        "Vanguard",
      );
      await cp.ensureGlobalExposureProfileStub(
        { kind: "provider", priceProvider: "yahoo", providerSymbol: "VWRL.L" },
        "Vanguard (renamed)",
      );

      const all = await cp.readGlobalExposureProfiles();
      expect(all).toHaveLength(1);
      // The first display name is preserved — a re-register never rewrites.
      expect(all[0]?.displayName).toBe("Vanguard");
    } finally {
      cp.close();
    }
  });

  test("never overwrites an already-curated profile", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const curated = await cp.createGlobalExposureProfile({
        identity: { isin: VWRL_ISIN },
        displayName: "Vanguard FTSE All-World",
        trackedIndex: "FTSE All-World",
        ter: "0.0022",
        breakdowns: { assetClass: { equity: "1" }, geography: { us: "0.6" } },
      });

      await cp.ensureGlobalExposureProfileStub(
        { isin: VWRL_ISIN, kind: "isin" },
        "MSCI World",
      );

      expect(await cp.readGlobalExposureProfile({ isin: VWRL_ISIN })).toEqual(curated);
    } finally {
      cp.close();
    }
  });

  test("a null display name registers an unnamed stub", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await cp.ensureGlobalExposureProfileStub({ isin: "IE00BK5BQT80", kind: "isin" });
      const stub = await cp.readGlobalExposureProfile({ isin: "IE00BK5BQT80" });
      expect(stub?.displayName).toBeNull();
      expect(stub?.breakdowns).toEqual({});
    } finally {
      cp.close();
    }
  });
});
