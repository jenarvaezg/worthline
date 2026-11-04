/**
 * The attempt log of a source that owns its holdings (#1885, ADR 0114 decision 8),
 * on `sync_run`, and what the data-health port reads of it.
 *
 * - Each attempt is one finished row: when, who triggered it, how it ended, the
 *   error's kind, the step that failed and the HTTP status. Never an amount, an
 *   ISIN nor an identifier: there is no field for one.
 * - Its rows go at 90 days, not at the last twenty: «three days in a row» and the
 *   analysis of failures need the days, and ten presses a day would eat twenty rows
 *   in two.
 */
import { openLibsqlClient } from "@db/index";
import { migrate } from "@db/migrate";
import { createStoreFromSqlite } from "@db/testing";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

async function openStore(credentials: Record<string, unknown>) {
  const client: Client = openLibsqlClient(":memory:");
  await migrate(client);
  const store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
  const { sourceId } = (await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: JSON.stringify(credentials),
    label: "MyInvestor",
  }))!;
  return { client, sourceId, store };
}

const DEVICE_ONLY = { deviceId: "device-under-test" };

describe("the attempt log", () => {
  test("a failed attempt is one finished row: kind, step, HTTP status and its two instants", async () => {
    const { sourceId, store } = await openStore(DEVICE_ONLY);

    await store.connectedSources.recordSyncAttempt({
      error: {
        code: "network_or_waf",
        httpStatus: 503,
        message: "network",
        retriable: true,
        step: "orders",
      },
      finishedAt: "2026-11-04T07:13:41.250Z",
      sourceId,
      startedAt: "2026-11-04T07:13:02.000Z",
      trigger: "cron",
    });

    expect(await store.syncRuns.readRuns(sourceId)).toEqual([
      {
        createdAt: "2026-11-04T07:13:02.000Z",
        error: {
          code: "network_or_waf",
          httpStatus: 503,
          message: "network",
          retriable: true,
          step: "orders",
        },
        finishedAt: "2026-11-04T07:13:41.250Z",
        id: expect.any(String),
        sourceId,
        startedAt: "2026-11-04T07:13:02.000Z",
        status: "error",
        trigger: "cron",
      },
    ]);
  });

  test("a good attempt is an `ok` row with no error, and does not move the last good sync", async () => {
    const { sourceId, store } = await openStore(DEVICE_ONLY);

    await store.connectedSources.recordSyncAttempt({
      error: null,
      finishedAt: "2026-11-04T07:13:41.250Z",
      sourceId,
      startedAt: "2026-11-04T07:13:02.000Z",
      trigger: "manual",
    });

    const [run] = await store.syncRuns.readRuns(sourceId);
    expect(run).toMatchObject({ error: null, status: "ok", trigger: "manual" });
    // The pass stamps it with the read it saved, never the log.
    expect((await store.connectedSources.readSource(sourceId))!.lastSyncAt).toBeNull();
  });

  test("the rows older than 90 days go when the next attempt is written; 89 stay", async () => {
    const { sourceId, store } = await openStore(DEVICE_ONLY);
    const attempt = (at: string) =>
      store.connectedSources.recordSyncAttempt({
        error: null,
        finishedAt: at,
        sourceId,
        startedAt: at,
        trigger: "cron",
      });

    await attempt("2026-08-05T07:00:00.000Z"); // 91 days before
    await attempt("2026-08-07T07:00:00.000Z"); // 89 days before
    await attempt("2026-11-04T07:00:00.000Z");

    expect((await store.syncRuns.readRuns(sourceId)).map((run) => run.startedAt)).toEqual(
      ["2026-11-04T07:00:00.000Z", "2026-08-07T07:00:00.000Z"],
    );
  });

  test("the purge on its own, for a connection that made no attempt (the cron's)", async () => {
    const { sourceId, store } = await openStore(DEVICE_ONLY);
    await store.connectedSources.recordSyncAttempt({
      error: null,
      finishedAt: "2026-08-01T07:00:00.000Z",
      sourceId,
      startedAt: "2026-08-01T07:00:00.000Z",
      trigger: "manual",
    });

    await store.connectedSources.purgeSyncAttempts({
      now: "2026-11-04T07:00:00.000Z",
      sourceId,
    });

    expect(await store.syncRuns.readRuns(sourceId)).toEqual([]);
  });

  test("more than twenty attempts in a day are all kept: the log is by days", async () => {
    const { sourceId, store } = await openStore(DEVICE_ONLY);
    for (let minute = 10; minute < 35; minute += 1) {
      const at = `2026-11-04T07:${String(minute).padStart(2, "0")}:00.000Z`;
      await store.connectedSources.recordSyncAttempt({
        error: null,
        finishedAt: at,
        sourceId,
        startedAt: at,
        trigger: "manual",
      });
    }

    expect(await store.syncRuns.readRuns(sourceId)).toHaveLength(25);
  });
});

describe("what data health reads of it", () => {
  test("each attempt with the step it failed on", async () => {
    const { sourceId, store } = await openStore(DEVICE_ONLY);
    await store.connectedSources.recordSyncAttempt({
      error: {
        code: "unexpected_response",
        httpStatus: 200,
        message: "failed",
        retriable: false,
        step: "plans",
      },
      finishedAt: "2026-11-04T07:13:41.250Z",
      sourceId,
      startedAt: "2026-11-04T07:13:02.000Z",
      trigger: "cron",
    });

    expect(await store.agentView.readSyncAttempts(sourceId)).toEqual([
      { at: "2026-11-04T07:13:41.250Z", failedStep: "plans", status: "error" },
    ]);
  });

  test("the standing: whether a password is saved, and the stop", async () => {
    const saved = await openStore({
      acceptance: { acceptedAt: "2026-11-01T10:00:00.000Z", acceptedBy: null },
      customerId: "00000000A",
      deviceId: "device-under-test",
      password: "sintetica",
    });
    expect(await saved.store.agentView.readOwningSourceStanding(saved.sourceId)).toEqual({
      savedPassword: true,
      stop: null,
    });

    await saved.store.connectedSources.updateSyncState(saved.sourceId, {
      stoppedReason: "sms_required",
    });
    expect(await saved.store.agentView.readOwningSourceStanding(saved.sourceId)).toEqual({
      savedPassword: true,
      stop: "sms_required",
    });

    const forgotten = await openStore(DEVICE_ONLY);
    await forgotten.store.connectedSources.updateSyncState(forgotten.sourceId, {
      lastOutcomeJson: JSON.stringify({
        at: "2026-11-04T07:13:00.000Z",
        forgotten: true,
        kind: "password_rejected",
      }),
    });
    expect(
      await forgotten.store.agentView.readOwningSourceStanding(forgotten.sourceId),
    ).toEqual({ savedPassword: false, stop: "password_forgotten" });
  });

  test("a mirroring source has no standing of this kind", async () => {
    const { store } = await openStore(DEVICE_ONLY);
    const { sourceId } = await store.connectedSources.connect({
      adapter: "binance",
      credentialsJson: JSON.stringify({ apiKey: "k", apiSecret: "s" }),
      label: "Binance",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    expect(await store.agentView.readOwningSourceStanding(sourceId)).toBeNull();
  });
});
