/**
 * «Poner al día», the server action (#1884): the guards before anything else, and
 * the pass's result as state for the panel (interaction-patterns §4.1). The client
 * is the real one over the fixtures (#1887); nothing reaches a network.
 */
import type { StoreTarget } from "@web/store-resolver";
import { createInMemoryStore, type PersistenceTestStore } from "@worthline/db/testing";
import { fixedClock } from "@worthline/domain";
import { createMyInvestorClient } from "@worthline/pricing";
import { fixtureTransport } from "@worthline/pricing/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";

let mockTarget: StoreTarget = { kind: "local" };

vi.mock("@web/read-store-target", () => ({
  readSessionEmail: async () => "titular@example.com",
  readStoreTarget: async () => mockTarget,
}));
vi.mock("@web/entitlements/ingestion-guard", () => ({
  ingestionBlockedMessage: vi.fn(async () => null),
}));

import { VIEWER_READONLY_MESSAGE } from "@web/demo/write-guard";
import { ingestionBlockedMessage } from "@web/entitlements/ingestion-guard";
import { PAYWALL_SOURCES_PAUSED_MESSAGE } from "@web/entitlements/paywall-copy";
import { ponerAlDiaMyInvestorAction } from "./myinvestor-sync-actions";

const VIEWER: StoreTarget = {
  dbUrl: "libsql://wl-titular.turso.io",
  kind: "authenticated",
  sharedByEmail: "titular@example.com",
  token: "read-only",
  workspaceId: "ws-titular",
};

const clock = fixedClock("2026-11-04T09:00:00.000Z");
const URL = "/patrimonio/wl_hld_x";
const IDLE = { ok: true as const, blockedLine: null, text: "", tone: "ok" as const };

const SAVED = {
  acceptance: { acceptedAt: "2026-11-04T08:00:00.000Z", acceptedBy: null },
  customerId: "00000000A",
  deviceId: "device-sintetico",
  password: "sintetica",
};

let store: PersistenceTestStore;
let logins = 0;

const fixtureClients = {
  myInvestorClientFor: (deviceId: string) => {
    const real = createMyInvestorClient({
      deviceId,
      sleep: async () => {},
      transport: fixtureTransport(),
    });
    return {
      ...real,
      loginWithKnownDevice: (credentials: { customerId: string; password: string }) => {
        logins += 1;
        return real.loginWithKnownDevice(credentials);
      },
    };
  },
};

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

async function connect(credentials: Record<string, unknown>): Promise<string> {
  const connected = await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: JSON.stringify(credentials),
    label: "MyInvestor",
  });
  return connected!.sourceId;
}

async function redirected(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const signal = error as { digest?: string; message?: string };
    if (signal.message === "NEXT_REDIRECT" && typeof signal.digest === "string") {
      return decodeURIComponent(signal.digest.replaceAll("+", " "));
    }
    throw error;
  }
  throw new Error("the action did not redirect");
}

beforeEach(async () => {
  logins = 0;
  mockTarget = { kind: "local" };
  vi.mocked(ingestionBlockedMessage).mockResolvedValue(null);
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
});

describe("«Poner al día», the action", () => {
  test("with the saved password, a pass runs and its result comes back as state", async () => {
    const sourceId = await connect(SAVED);

    const state = await ponerAlDiaMyInvestorAction(
      IDLE,
      form({ currentUrl: URL, sourceId }),
      store,
      clock,
      fixtureClients,
    );

    expect(state).toMatchObject({ ok: true, tone: "ok" });
    expect(logins).toBe(1);
    expect(await store.connectedSources.readDiscovery(sourceId)).not.toBeNull();
  });

  test("with no password saved nor typed, it asks and MyInvestor is not called", async () => {
    const sourceId = await connect({ deviceId: "device-sintetico" });

    const state = await ponerAlDiaMyInvestorAction(
      IDLE,
      form({ currentUrl: URL, sourceId }),
      store,
      clock,
      fixtureClients,
    );

    expect(state).toMatchObject({ ok: false });
    expect(logins).toBe(0);
  });

  test("the password typed is used once and never kept", async () => {
    const sourceId = await connect({ deviceId: "device-sintetico" });

    const state = await ponerAlDiaMyInvestorAction(
      IDLE,
      form({ currentUrl: URL, customerId: "00000000A", password: "tecleada", sourceId }),
      store,
      clock,
      fixtureClients,
    );

    expect(state).toMatchObject({ ok: true });
    const source = await store.connectedSources.readSource(sourceId);
    expect(source!.credentialsJson).not.toContain("tecleada");
  });

  test("a lapsed plan and a viewer are refused before MyInvestor is asked", async () => {
    const sourceId = await connect(SAVED);
    vi.mocked(ingestionBlockedMessage).mockResolvedValue(PAYWALL_SOURCES_PAUSED_MESSAGE);

    expect(
      await ponerAlDiaMyInvestorAction(
        IDLE,
        form({ currentUrl: URL, sourceId }),
        store,
        clock,
        fixtureClients,
      ),
    ).toEqual({ error: PAYWALL_SOURCES_PAUSED_MESSAGE, ok: false });

    mockTarget = VIEWER;
    expect(
      await redirected(
        ponerAlDiaMyInvestorAction(
          IDLE,
          form({ currentUrl: URL, sourceId }),
          store,
          clock,
          fixtureClients,
        ),
      ),
    ).toContain(VIEWER_READONLY_MESSAGE);
    expect(logins).toBe(0);
  });
});
