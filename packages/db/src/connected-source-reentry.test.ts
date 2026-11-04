/**
 * «Volver a entrar» on a MyInvestor connection that already exists (#1876): the
 * credentials with the device MyInvestor trusts now, and the stop lifted, in ONE
 * transaction — a device verified but still marked as asking for the SMS would make
 * the next «Volver a entrar» send another SMS for nothing.
 */
import { openLibsqlClient } from "@worthline/db";
import { createStoreFromSqlite } from "@worthline/db/testing";
import { beforeEach, describe, expect, test } from "vitest";

type Store = Awaited<ReturnType<typeof createStoreFromSqlite>>;

let store: Store;
let sourceId: string;

beforeEach(async () => {
  store = await createStoreFromSqlite(openLibsqlClient(":memory:"));
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Titular" }],
    mode: "individual",
  });
  const connected = await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: JSON.stringify({ deviceId: "device-1" }),
    label: "MyInvestor",
  });
  sourceId = connected!.sourceId;
  await store.connectedSources.updateSyncState(sourceId, {
    lastOutcomeJson: JSON.stringify({
      at: "2026-11-04T07:10:00.000Z",
      kind: "sms_required",
    }),
    stoppedReason: "sms_required",
  });
});

describe("recordReentry", () => {
  test("keeps the new credentials and lifts the stop together", async () => {
    await store.connectedSources.recordReentry({
      clearLastOutcome: true,
      credentialsJson: JSON.stringify({ deviceId: "device-2" }),
      sourceId,
    });

    const source = await store.connectedSources.readSource(sourceId);
    expect(JSON.parse(source!.credentialsJson)).toEqual({ deviceId: "device-2" });
    const state = await store.connectedSources.readSyncState(sourceId);
    expect(state).toMatchObject({ lastOutcomeJson: null, stoppedReason: null });
  });

  test("a good last pass is kept: only a failed one stops saying how it stands", async () => {
    await store.connectedSources.recordReentry({
      clearLastOutcome: false,
      credentialsJson: JSON.stringify({ deviceId: "device-2" }),
      sourceId,
    });

    const state = await store.connectedSources.readSyncState(sourceId);
    expect(state?.stoppedReason).toBeNull();
    expect(state?.lastOutcomeJson).not.toBeNull();
  });

  test("a connection that is not there writes nothing", async () => {
    await expect(
      store.connectedSources.recordReentry({
        clearLastOutcome: true,
        credentialsJson: JSON.stringify({ deviceId: "device-2" }),
        sourceId: "missing",
      }),
    ).rejects.toThrow();
    const state = await store.connectedSources.readSyncState(sourceId);
    expect(state?.stoppedReason).toBe("sms_required");
  });
});
