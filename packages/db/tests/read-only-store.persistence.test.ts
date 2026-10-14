/**
 * A viewer principal opens the owner's workspace read-only (#1842, PRD #1718).
 *
 * The base is seeded through an ordinary store, closed, and reopened with
 * `readOnly: true`. Reads must see exactly what the owner sees; every write the
 * store offers must be refused by the client underneath — before it reaches
 * libSQL — so the row counts of every table stay put. Opening itself must not
 * write either: no migration ladder, no post-migrate re-ripples, no FIRE seed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isReadOnlyWorkspaceError,
  openLibsqlClient,
  SCHEMA_VERSION,
  WorkspaceSchemaBehindError,
  type WorthlineStore,
} from "@db/index";
import { readSchemaVersion, writeSchemaVersion } from "@db/migrate";
import { createWorthlineStoreUnsafe } from "@db/unsafe-store";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const TODAY = "2026-08-05";

let dir: string;
let databasePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worthline-readonly-"));
  databasePath = join(dir, "workspace.sqlite");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

async function seedOwnerBook(): Promise<void> {
  const store = await createWorthlineStoreUnsafe({ databasePath });
  try {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jorge" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.command.createInvestmentHolding({
      asset: {
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        name: "Fondo",
        ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      },
      today: TODAY,
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-01-10",
        feesMinor: 0,
        id: "op_buy",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
    await store.saveFireConfig("household", {
      monthlySpendingMinor: 2_000_00,
      safeWithdrawalRate: 0.04,
    });
  } finally {
    store.close();
  }
}

/** Every table's row count, read straight off the file with a raw client. */
async function rowCounts(): Promise<Record<string, number>> {
  const client = openLibsqlClient(databasePath);
  try {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const counts: Record<string, number> = {};
    for (const row of tables.rows) {
      const name = String(row["name"]);
      const result = await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`);
      counts[name] = Number(result.rows[0]?.["n"]);
    }
    return counts;
  } finally {
    client.close();
  }
}

async function withRawClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = openLibsqlClient(databasePath);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

async function reads(store: WorthlineStore) {
  return {
    assets: await store.assets.readAssets(),
    fireConfig: await store.readFireConfig(TODAY),
    operations: await store.operations.readOperations("fund"),
    snapshots: await store.snapshots.readSnapshots("household"),
    trash: await store.readTrash(),
    workspace: await store.workspace.readWorkspace(),
  };
}

describe("readOnly store · reads see the owner's book", () => {
  test("every read returns what a normal store returns", async () => {
    await seedOwnerBook();

    const owner = await createWorthlineStoreUnsafe({ databasePath });
    const expected = await reads(owner);
    owner.close();

    const viewer = await createWorthlineStoreUnsafe({ databasePath, readOnly: true });
    try {
      const seen = await reads(viewer);
      expect(seen).toEqual(expected);
      expect(seen.assets.map((asset) => asset.id).sort()).toEqual(["cash", "fund"]);
      expect(seen.operations).toHaveLength(1);
    } finally {
      viewer.close();
    }
  });
});

describe("readOnly store · every write is refused and nothing changes", () => {
  test.each<[string, (store: WorthlineStore) => Promise<unknown>]>([
    [
      "crear un activo",
      (store) =>
        store.command.createInvestmentHolding({
          asset: {
            currency: "EUR",
            id: "intruso",
            liquidityTier: "market",
            name: "Intruso",
            ownership: [{ memberId: "mJ", shareBps: 10_000 }],
          },
          today: TODAY,
        }),
    ],
    [
      "registrar una operación",
      (store) =>
        store.command.recordInvestmentOperation(
          {
            assetId: "fund",
            currency: "EUR",
            executedAt: "2026-02-10",
            feesMinor: 0,
            id: "op_intrusa",
            kind: "buy",
            pricePerUnit: "100",
            units: "1",
          },
          { today: TODAY },
        ),
    ],
    [
      "guardar una propuesta del asistente",
      (store) => store.assistantProposals.create({ kind: "correction" }),
    ],
    [
      "actualizar el espacio",
      (store) => store.workspace.updateMember({ id: "mJ", name: "Otro" }),
    ],
    ["una ctx.transaction (vaciar la papelera)", (store) => store.emptyTrash()],
    [
      "el batchTrash",
      (store) =>
        store.batchSoftDeleteHoldings([{ holdingId: "cash", kind: "asset" }], TODAY),
    ],
    [
      "guardar la configuración FIRE",
      (store) =>
        store.saveFireConfig("household", {
          monthlySpendingMinor: 1,
          safeWithdrawalRate: 0.04,
        }),
    ],
    ["reconocer un aviso", (store) => store.acknowledgeWarning("CODE", "cash")],
    ["reiniciar el espacio", (store) => store.workspace.resetWorkspace()],
  ])("%s → ReadOnlyWorkspaceError", async (_label, write) => {
    await seedOwnerBook();
    const before = await rowCounts();

    const viewer = await createWorthlineStoreUnsafe({ databasePath, readOnly: true });
    try {
      const outcome = await write(viewer).then(
        () => "wrote",
        (error: unknown) => error,
      );
      expect(isReadOnlyWorkspaceError(outcome), String(outcome)).toBe(true);
    } finally {
      viewer.close();
    }

    expect(await rowCounts()).toEqual(before);
  });
});

describe("readOnly store · opening never writes", () => {
  test("a pending FIRE seed is left for the owner's next open", async () => {
    await seedOwnerBook();
    await withRawClient((client) =>
      client.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('fire.capacity_seed.v56', 'pending', '2026-08-01')",
      ),
    );
    const before = await rowCounts();

    const viewer = await createWorthlineStoreUnsafe({ databasePath, readOnly: true });
    viewer.close();

    expect(await rowCounts()).toEqual(before);
    const marker = await withRawClient((client) =>
      client.execute(
        "SELECT value FROM app_settings WHERE key = 'fire.capacity_seed.v56'",
      ),
    );
    expect(marker.rows[0]?.["value"]).toBe("pending");
  });

  test("a base one schema version behind refuses with WorkspaceSchemaBehindError and stays intact", async () => {
    await seedOwnerBook();
    await withRawClient((client) => writeSchemaVersion(client, SCHEMA_VERSION - 1));
    const before = await rowCounts();

    await expect(
      createWorthlineStoreUnsafe({ databasePath, readOnly: true }),
    ).rejects.toBeInstanceOf(WorkspaceSchemaBehindError);

    expect(await rowCounts()).toEqual(before);
    expect(await withRawClient((client) => readSchemaVersion(client))).toBe(
      SCHEMA_VERSION - 1,
    );
  });

  test("a brand-new base (version 0) is behind too, and is not created", async () => {
    await expect(
      createWorthlineStoreUnsafe({ databasePath, readOnly: true }),
    ).rejects.toBeInstanceOf(WorkspaceSchemaBehindError);

    expect(await rowCounts()).toEqual({});
  });
});
