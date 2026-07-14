/**
 * Sync engine tests (S7 #388, ADR 0030). The engine drives local↔prod sync over
 * the existing export/import machinery, exercised here with two in-memory
 * workspaces standing in for the local `file:` DB and the prod Turso DB:
 *   - pull round-trips current state AND the frozen snapshot history;
 *   - push full-replaces prod with local, after backing prod up;
 *   - push aborts when prod changed since the last pull (staleness guard);
 *   - push preserves prod's connected-source secrets across the full-replace
 *     (export omits them by design, ADR 0016), so the live connection survives.
 */
import type { NetWorthSnapshot } from "@worthline/domain";
import { afterEach, describe, expect, it } from "vitest";
import { SyncStaleError, syncPull, syncPush } from "./sync-engine";
import type { PersistenceTestStore as WorthlineStore } from "./testing";
import { createInMemoryStore } from "./testing";

const KEY = "test-secret-key";
const SECRET = JSON.stringify({ apiKey: "REAL", apiSecret: "REALSECRET" });

afterEach(() => {
  delete process.env.WORTHLINE_ENCRYPTION_KEY;
});

interface FakeDeps {
  lastPull: string | null;
  backups: Array<{ label: string; assets: number }>;
  readLastPull(): string | null;
  writeLastPull(fp: string): void;
  backup(doc: { assets: unknown[] }, label: string): void;
  now(): string;
}

function makeDeps(): FakeDeps {
  return {
    lastPull: null,
    backups: [],
    readLastPull() {
      return this.lastPull;
    },
    writeLastPull(fp: string) {
      this.lastPull = fp;
    },
    backup(doc, label) {
      this.backups.push({ label, assets: doc.assets.length });
    },
    now() {
      return "2026-06-21T00:00:00.000Z";
    },
  };
}

/** Seed a workspace touching the history + connected-source sections. */
async function seedWorkspace(
  store: WorthlineStore,
  opts: { cashMinor: number; withSource?: boolean } = { cashMinor: 500000 },
): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: opts.cashMinor,
    id: "a_cash",
    liquidityTier: "cash",
    name: "Caja",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "cash",
  });

  const snapshot: NetWorthSnapshot = {
    capturedAt: "2026-02-01T10:00:00.000Z",
    dateKey: "2026-02-01",
    debts: { amountMinor: 0, currency: "EUR" },
    grossAssets: { amountMinor: opts.cashMinor, currency: "EUR" },
    housingEquity: { amountMinor: 0, currency: "EUR" },
    id: "snap1",
    isMonthlyClose: true,
    liquidNetWorth: { amountMinor: opts.cashMinor, currency: "EUR" },
    monthKey: "2026-02",
    scopeId: "m1",
    scopeLabel: "Uno",
    totalNetWorth: { amountMinor: opts.cashMinor, currency: "EUR" },
    warnings: [],
  };
  await store.snapshots.saveSnapshot({
    holdings: [
      {
        countsAsHousing: false,
        holdingId: "a_cash",
        kind: "asset",
        label: "Caja",
        liquidityTier: "cash",
        securesHousing: false,
        valueMinor: opts.cashMinor,
      },
    ],
    snapshot,
  });

  if (opts.withSource) {
    await store.connectedSources.connect({
      adapter: "binance",
      label: "Binance",
      credentialsJson: SECRET,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
    });
  }
}

describe("sync engine", () => {
  it("pull round-trips current state and the snapshot history (prod → local)", async () => {
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    await seedWorkspace(prod, { cashMinor: 750000 });

    await syncPull(prod, local, makeDeps());

    const localWorkspace = await local.workspace.readWorkspace();
    expect(localWorkspace?.members.map((m) => m.id)).toEqual(["m1"]);
    expect((await local.assets.readAssets()).map((a) => a.id)).toContain("a_cash");
    // History round-trips: the frozen snapshot is present locally.
    expect((await local.snapshots.readSnapshots()).map((s) => s.id)).toContain("snap1");
    prod.close();
    local.close();
  });

  it("push full-replaces prod with local, carrying history, after pulling", async () => {
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    await seedWorkspace(prod, { cashMinor: 500000 });
    const deps = makeDeps();

    await syncPull(prod, local, deps);
    // Edit local, then push it back.
    await local.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 99_000,
      id: "a_new",
      liquidityTier: "cash",
      name: "Nueva",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });

    await syncPush(local, prod, deps);

    expect((await prod.assets.readAssets()).map((a) => a.id).sort()).toEqual([
      "a_cash",
      "a_new",
    ]);
    expect((await prod.snapshots.readSnapshots()).map((s) => s.id)).toContain("snap1");
    prod.close();
    local.close();
  });

  it("push backs prod up before overwriting it", async () => {
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    await seedWorkspace(prod, { cashMinor: 500000 });
    const deps = makeDeps();

    await syncPull(prod, local, deps);
    await syncPush(local, prod, deps);

    expect(deps.backups).toHaveLength(1);
    expect(deps.backups[0]?.label).toBe("2026-06-21T00:00:00.000Z");
    expect(deps.backups[0]?.assets).toBe(1); // prod's pre-push state
    prod.close();
    local.close();
  });

  it("push aborts when prod changed since the last pull (staleness guard)", async () => {
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    await seedWorkspace(prod, { cashMinor: 500000 });
    const deps = makeDeps();

    await syncPull(prod, local, deps);
    // Prod drifts after the pull (someone else wrote to it).
    await prod.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1,
      id: "a_drift",
      liquidityTier: "cash",
      name: "Drift",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "cash",
    });

    await expect(syncPush(local, prod, deps)).rejects.toBeInstanceOf(SyncStaleError);
    // Prod is untouched: no backup taken, the drift asset survives.
    expect(deps.backups).toHaveLength(0);
    expect((await prod.assets.readAssets()).map((a) => a.id)).toContain("a_drift");
    prod.close();
    local.close();
  });

  it("push preserves prod's connected-source secrets across the full-replace", async () => {
    process.env.WORTHLINE_ENCRYPTION_KEY = KEY;
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    await seedWorkspace(prod, { cashMinor: 500000, withSource: true });
    const deps = makeDeps();

    await syncPull(prod, local, deps);
    // Export omits secrets, so the pulled local source carries a placeholder.
    const localSource = (await local.connectedSources.listSources())[0];
    expect(localSource?.credentialsJson).not.toBe(SECRET);

    const result = await syncPush(local, prod, deps);

    // Prod's live secret survived the destructive full-replace, nothing missing.
    const prodSource = (await prod.connectedSources.listSources())[0];
    expect(prodSource?.credentialsJson).toBe(SECRET);
    expect(result.sourcesMissingSecret).toEqual([]);
    prod.close();
    local.close();
  });

  it("carries local's secret up for a source prod never had (first-load)", async () => {
    process.env.WORTHLINE_ENCRYPTION_KEY = KEY;
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    await seedWorkspace(prod, { cashMinor: 500000 });
    const deps = makeDeps();

    await syncPull(prod, local, deps);
    // Local connects a brand-new source prod never had a secret for — exactly
    // the first-push-into-fresh-prod shape, where prod has no key to preserve.
    await local.connectedSources.connect({
      adapter: "binance",
      label: "Binance",
      credentialsJson: SECRET,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
    });

    const result = await syncPush(local, prod, deps);

    // The export drops the secret, but the engine carries local's own key up, so
    // the connection lands live in prod and nothing needs re-entering.
    const prodSource = (await prod.connectedSources.listSources())[0];
    expect(prodSource?.credentialsJson).toBe(SECRET);
    expect(result.sourcesMissingSecret).toEqual([]);
    prod.close();
    local.close();
  });

  it("flags a source neither side holds a live key for", async () => {
    process.env.WORTHLINE_ENCRYPTION_KEY = KEY;
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    // Prod has the live source; an intermediary `local` only ever pulled it, so
    // local carries the placeholder, not a real key.
    await seedWorkspace(prod, { cashMinor: 500000, withSource: true });
    const intermediary = await createInMemoryStore();
    const deps = makeDeps();

    await syncPull(prod, intermediary, deps);
    await syncPull(intermediary, local, deps);
    // Wipe prod's own key so neither prod nor local holds a live one.
    await prod.workspace.resetWorkspace();

    const result = await syncPush(local, prod, makeDeps());

    // No live key anywhere ⇒ the imported placeholder stays, flagged for re-entry.
    expect(result.sourcesMissingSecret).toEqual(["Binance"]);
    prod.close();
    intermediary.close();
    local.close();
  });

  it("a second push with no edits never false-aborts despite prod's import gap-fill", async () => {
    const prod = await createInMemoryStore();
    const local = await createInMemoryStore();
    await seedWorkspace(prod, { cashMinor: 500000 });
    const deps = makeDeps();

    await syncPull(prod, local, deps);
    // Local gains an operation with no covering snapshot — prod's post-import
    // gap-fill will synthesize one that local's export lacks (the drift the
    // baseline must account for).
    await local.assets.createInvestmentAsset({
      currency: "EUR",
      id: "a_inv",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      unitSymbol: "F",
    });
    await local.operations.recordOperation({
      assetId: "a_inv",
      currency: "EUR",
      executedAt: "2026-03-10T00:00:00.000Z",
      feesMinor: 0,
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "5",
    });

    await syncPush(local, prod, deps);
    // Re-push with no further edits: the baseline tracks prod's real post-import
    // state, so the staleness guard must not trip.
    await expect(syncPush(local, prod, deps)).resolves.toMatchObject({
      sourcesMissingSecret: [],
    });
    prod.close();
    local.close();
  });
});
