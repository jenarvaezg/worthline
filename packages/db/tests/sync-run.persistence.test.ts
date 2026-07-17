/**
 * Observable sync-run persistence (#885 / PRD #999 S1, #1061).
 *
 * A connected-source sync is an OBSERVABLE entity: each attempt opens one
 * immutable `sync_run` row that walks `pending → running → ok | error`. These
 * assert the external behaviour — the run's lifecycle, its structured error, the
 * single-flight guard, last-N retention, and the derived `last_sync_at` — against
 * a real store sharing a raw client, so the runs can be read directly (there is
 * no product read surface yet; the connector-health panel #654 adds one later).
 */

import {
  createStoreFromSqlite,
  openLibsqlClient,
  type SourcePositionInput,
  SYNC_RUN_RETENTION_LIMIT,
  type WorthlineStore,
} from "@db/index";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";

const MEMBER_ID = "mJ";

interface SyncRunRow {
  id: string;
  source_id: string;
  trigger: string;
  status: string;
  error_json: string | null;
  started_at: string | null;
  finished_at: string | null;
}

async function setup(): Promise<{
  client: Client;
  store: WorthlineStore;
  sourceId: string;
}> {
  const client = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  const { sourceId } = await store.connectedSources.connect({
    adapter: "binance",
    label: "Binance",
    credentialsJson: JSON.stringify({ apiKey: "KEY", apiSecret: "SECRET" }),
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  return { client, store, sourceId };
}

function token(
  overrides: Partial<Extract<SourcePositionInput, { kind: "token" }>> = {},
): SourcePositionInput {
  return {
    balance: "0.5",
    currency: "EUR",
    externalId: "BTC:spot",
    imageUrl: null,
    kind: "token",
    liquidityTier: "market",
    name: "BTC",
    symbol: "BTC",
    unitPrice: "50000",
    wallet: "spot",
    ...overrides,
  };
}

async function readRuns(client: Client, sourceId: string): Promise<SyncRunRow[]> {
  return (
    await client.execute({
      args: [sourceId],
      sql: "SELECT * FROM sync_run WHERE source_id = ? ORDER BY created_at, id",
    })
  ).rows as unknown as SyncRunRow[];
}

async function readLastSyncAt(client: Client, sourceId: string): Promise<string | null> {
  const row = (
    await client.execute({
      args: [sourceId],
      sql: "SELECT last_sync_at FROM connected_sources WHERE id = ?",
    })
  ).rows[0] as unknown as { last_sync_at: string | null } | undefined;
  return row?.last_sync_at ?? null;
}

const clients: Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function freshSetup() {
  const created = await setup();
  clients.push(created.client);
  return created;
}

describe("sync-run lifecycle", () => {
  test("a happy-path sync ends `ok`, records its trigger, and stamps start/finish", async () => {
    const { client, store, sourceId } = await freshSetup();

    await store.command.syncConnectedSource({
      positions: [token()],
      sourceId,
      syncedAt: "2026-07-01T09:00:00.000Z",
      trigger: "manual",
    });

    const runs = await readRuns(client, sourceId);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.status).toBe("ok");
    expect(run!.trigger).toBe("manual");
    expect(run!.error_json).toBeNull();
    expect(run!.started_at).toBe("2026-07-01T09:00:00.000Z");
    expect(run!.finished_at).toBe("2026-07-01T09:00:00.000Z");
  });

  test("`last_sync_at` derives from the latest `ok` run", async () => {
    const { client, store, sourceId } = await freshSetup();

    await store.command.syncConnectedSource({
      positions: [token()],
      sourceId,
      syncedAt: "2026-07-01T09:00:00.000Z",
      trigger: "connect",
    });
    await store.command.syncConnectedSource({
      positions: [token({ balance: "0.7" })],
      sourceId,
      syncedAt: "2026-07-02T09:00:00.000Z",
      trigger: "cron",
    });

    expect(await readLastSyncAt(client, sourceId)).toBe("2026-07-02T09:00:00.000Z");
    const runs = await readRuns(client, sourceId);
    expect(runs.map((r) => r.trigger)).toEqual(["connect", "cron"]);
    expect(runs.every((r) => r.status === "ok")).toBe(true);
  });

  test("a persist failure ends the run `error` with a structured payload — never left `running`", async () => {
    const { client, store, sourceId } = await freshSetup();

    // Force a deterministic failure DURING the persist half (after the run is open):
    // drop the `positions` table so the wholesale mirror throws a real SQL error.
    // `sync_run` is untouched, so the seam's catch can still finalize the run.
    await client.execute("DROP TABLE positions");

    await expect(
      store.command.syncConnectedSource({
        positions: [token()],
        sourceId,
        syncedAt: "2026-07-01T09:00:00.000Z",
        trigger: "manual",
      }),
    ).rejects.toThrow();

    const runs = await readRuns(client, sourceId);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.status).toBe("error");
    expect(run!.finished_at).toBe("2026-07-01T09:00:00.000Z");
    expect(run!.started_at).toBe("2026-07-01T09:00:00.000Z");
    const error = JSON.parse(run!.error_json!) as {
      code: string;
      message: string;
      retriable: boolean;
    };
    expect(error.code).toBe("sync_persist_failed");
    expect(error.retriable).toBe(true);
    expect(error.message).toMatch(/positions/i);

    // A failed fetch is not a successful sync: `last_sync_at` stays null (connect
    // never synced any positions in this fixture).
    expect(await readLastSyncAt(client, sourceId)).toBeNull();
  });

  test("single-flight: a sync whose source already has an in-flight run is skipped", async () => {
    const { client, store, sourceId } = await freshSetup();

    // A run already `running` for this source (e.g. a concurrent trigger mid-flight).
    await client.execute({
      args: [sourceId],
      sql: `INSERT INTO sync_run (id, source_id, trigger, status, started_at)
            VALUES ('run_inflight', ?, 'cron', 'running', '2026-07-01T08:00:00.000Z')`,
    });

    await store.command.syncConnectedSource({
      positions: [token()],
      sourceId,
      syncedAt: "2026-07-01T09:00:00.000Z",
      trigger: "manual",
    });

    // No overlapping run was opened, and the persist was skipped (no positions
    // mirrored) — the in-flight run is the only row and stays `running`.
    const runs = await readRuns(client, sourceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("run_inflight");
    expect(runs[0]!.status).toBe("running");
    expect(await store.connectedSources.readPositions(sourceId)).toHaveLength(0);
  });

  test("retention: only the newest N runs per source are kept", async () => {
    const { client, store, sourceId } = await freshSetup();

    const total = SYNC_RUN_RETENTION_LIMIT + 5;
    for (let i = 0; i < total; i += 1) {
      const day = String(i + 1).padStart(2, "0");
      await store.command.syncConnectedSource({
        positions: [token({ balance: `${i + 1}` })],
        sourceId,
        syncedAt: `2026-07-${day}T09:00:00.000Z`,
        trigger: "cron",
      });
    }

    const runs = await readRuns(client, sourceId);
    expect(runs).toHaveLength(SYNC_RUN_RETENTION_LIMIT);
    // The retained window is the newest N: the oldest surviving run is #6 (the
    // first five were pruned), and the last-sync stamp reflects the final sync.
    expect(runs[0]!.finished_at).toBe("2026-07-06T09:00:00.000Z");
    expect(await readLastSyncAt(client, sourceId)).toBe(
      `2026-07-${String(total).padStart(2, "0")}T09:00:00.000Z`,
    );
  });
});
