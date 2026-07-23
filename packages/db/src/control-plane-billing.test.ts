import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createInMemoryControlPlaneStore,
  type EntitlementDirectory,
  type TenancyDirectory,
} from "./control-plane";
import {
  CP_SCHEMA_VERSION,
  migrateControlPlane,
  readControlPlaneSchemaVersion,
  writeControlPlaneSchemaVersion,
} from "./control-plane-migrate";
import { deriveEffectivePlan } from "./entitlements";
import { openLibsqlClient } from "./libsql-client";

type BillingStore = EntitlementDirectory & TenancyDirectory & { close(): void };

const NOW = "2026-07-23T12:00:00.000Z";
const PERIOD_END = "2026-08-23T12:00:00.000Z";

async function seedWorkspace(store: BillingStore): Promise<string> {
  const workspace = await store.createWorkspace({
    dbName: "wl-billing-test",
    dbUrl: "file:wl-billing-test.sqlite",
  });
  return workspace.id;
}

describe("control plane billing writes (PRD #1160 S5, #1165)", () => {
  it("updateWorkspaceBilling crea la fila premium con las referencias del MoR", async () => {
    const store: BillingStore = await createInMemoryControlPlaneStore();
    const workspaceId = await seedWorkspace(store);

    const row = await store.updateWorkspaceBilling({
      workspaceId,
      premiumUntil: PERIOD_END,
      billingProvider: "fake",
      billingCustomerId: "cus-1",
      subscriptionId: "sub-1",
      subscriptionStatus: "active",
    });

    expect(row.plan).toBe("premium");
    expect(row.premiumUntil).toBe(PERIOD_END);
    expect(row.billingProvider).toBe("fake");
    expect(row.billingCustomerId).toBe("cus-1");
    expect(row.subscriptionId).toBe("sub-1");
    expect(row.subscriptionStatus).toBe("active");
    expect(deriveEffectivePlan(row, NOW)).toBe("premium");
    expect(await store.readWorkspaceEntitlement(workspaceId)).toEqual(row);

    store.close();
  });

  it("updateWorkspaceBilling preserva el trial consumido y los timestamps de activación", async () => {
    const store: BillingStore = await createInMemoryControlPlaneStore();
    const user = await store.findOrCreateUser("ana@example.com");
    const workspaceId = await seedWorkspace(store);
    const trial = await store.startTrialIfUnused({
      now: NOW,
      userId: user.id,
      workspaceId,
    });
    await store.markWorkspaceOnboarded(workspaceId, NOW);

    const row = await store.updateWorkspaceBilling({
      workspaceId,
      premiumUntil: null,
      billingProvider: "fake",
      billingCustomerId: "cus-1",
      subscriptionId: null,
      subscriptionStatus: null,
    });

    expect(row.plan).toBe("premium");
    expect(row.premiumUntil).toBeNull();
    expect(row.trialEndsAt).toBe(trial!.trialEndsAt);
    expect(row.onboardedAt).toBe(NOW);

    store.close();
  });

  it("recordBillingWebhookEvent: el primer registro gana, la redelivery se detecta", async () => {
    const store: BillingStore = await createInMemoryControlPlaneStore();

    expect(await store.recordBillingWebhookEvent("fake", "evt-1")).toBe(true);
    expect(await store.recordBillingWebhookEvent("fake", "evt-1")).toBe(false);
    // La clave es por proveedor: otro proveedor puede reutilizar el mismo id.
    expect(await store.recordBillingWebhookEvent("paddle", "evt-1")).toBe(true);

    store.close();
  });
});

describe("control-plane billing migration", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  });

  it("un control plane v4 gana la tabla billing_webhook_events y sube de versión", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-cp-billing-"));
    tempDirs.push(dir);
    const client = openLibsqlClient({ url: `file:${join(dir, "cp.sqlite")}` });
    await writeControlPlaneSchemaVersion(client, 4);

    await migrateControlPlane(client);

    expect(await readControlPlaneSchemaVersion(client)).toBe(CP_SCHEMA_VERSION);
    expect(CP_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'billing_webhook_events'",
    );
    expect(tables.rows.length).toBe(1);
    client.close();
  });
});
