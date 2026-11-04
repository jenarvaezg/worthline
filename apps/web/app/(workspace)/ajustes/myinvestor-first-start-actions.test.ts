/**
 * The server actions of MyInvestor's first start (#1880): reading the products and
 * including them. The client is the real one over the fixtures (#1887); the symbol
 * lookup is a fake handed in through the test seam, so nothing reaches a network.
 *
 * - A viewer cannot read nor include (ADR del viewer (#1843)); a lapsed plan cannot
 *   either (#1162).
 * - Without a remembered password, reading asks for it, and the one typed is not
 *   kept.
 * - Including redirects with what ONE batch created.
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
import { resolveOkMessage } from "@web/intake";
import {
  includeMyInvestorProductsAction,
  readMyInvestorProductsAction,
} from "./myinvestor-actions";
import { MYINVESTOR_PASSWORD_NEEDED } from "./myinvestor-first-start-flow";

const VIEWER: StoreTarget = {
  dbUrl: "libsql://wl-jorge.turso.io",
  kind: "authenticated",
  sharedByEmail: "jorge@example.com",
  token: "read-only-jorge",
  workspaceId: "ws-jorge",
};

/** The fixtures' capture day: their manifest answers reads up to it. */
const clock = fixedClock("2026-11-04T09:00:00.000Z");
const URL = "/ajustes/conexiones";

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
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

const fixtureClients = {
  myInvestorClientFor: (deviceId: string) =>
    createMyInvestorClient({
      deviceId,
      sleep: async () => {},
      transport: fixtureTransport(),
    }),
};
const noSymbols = { myInvestorResolveSymbol: async () => null };

let store: PersistenceTestStore;

async function connect(credentials: Record<string, unknown>): Promise<string> {
  const connected = await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: JSON.stringify(credentials),
    label: "MyInvestor",
  });
  return connected!.sourceId;
}

const SAVED = {
  acceptance: { acceptedAt: "2026-11-04T08:00:00.000Z", acceptedBy: null },
  customerId: "00000000A",
  deviceId: "device-sintetico",
  password: "sintetica",
};

beforeEach(async () => {
  mockTarget = { kind: "local" };
  vi.mocked(ingestionBlockedMessage).mockResolvedValue(null);
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
});

describe("reading the products", () => {
  test("with the password remembered, it reads without asking", async () => {
    const sourceId = await connect(SAVED);

    const target = await redirected(
      readMyInvestorProductsAction(
        form({ currentUrl: URL, sourceId }),
        store,
        clock,
        fixtureClients,
      ),
    );

    expect(target).toContain("ok=myinvestor_products_read");
    expect(await store.connectedSources.readDiscovery(sourceId)).not.toBeNull();
  });

  test("without it, it asks; the one typed reads and is never kept", async () => {
    const sourceId = await connect({ deviceId: "device-sintetico" });

    const asked = await redirected(
      readMyInvestorProductsAction(
        form({ currentUrl: URL, sourceId }),
        store,
        clock,
        fixtureClients,
      ),
    );
    expect(asked).toContain(MYINVESTOR_PASSWORD_NEEDED);
    expect(await store.connectedSources.readDiscovery(sourceId)).toBeNull();

    await redirected(
      readMyInvestorProductsAction(
        form({
          currentUrl: URL,
          customerId: "00000000A",
          password: "tecleada",
          sourceId,
        }),
        store,
        clock,
        fixtureClients,
      ),
    );
    expect(await store.connectedSources.readDiscovery(sourceId)).not.toBeNull();
    const source = await store.connectedSources.readSource(sourceId);
    expect(source!.credentialsJson).not.toContain("tecleada");
  });

  test("a lapsed plan cannot read, and MyInvestor is never asked", async () => {
    vi.mocked(ingestionBlockedMessage).mockResolvedValue(PAYWALL_SOURCES_PAUSED_MESSAGE);
    const sourceId = await connect(SAVED);
    const transport = fixtureTransport();

    const target = await redirected(
      readMyInvestorProductsAction(form({ currentUrl: URL, sourceId }), store, clock, {
        myInvestorClientFor: (deviceId: string) =>
          createMyInvestorClient({ deviceId, transport }),
      }),
    );

    expect(target).toContain(PAYWALL_SOURCES_PAUSED_MESSAGE);
    expect(transport.requests).toEqual([]);
  });

  test("a viewer can neither read nor include", async () => {
    const sourceId = await connect(SAVED);
    mockTarget = VIEWER;

    expect(
      await redirected(
        readMyInvestorProductsAction(form({ currentUrl: URL, sourceId }), store, clock),
      ),
    ).toContain(VIEWER_READONLY_MESSAGE);
    expect(
      await redirected(
        includeMyInvestorProductsAction(
          form({ currentUrl: URL, productKey: "cash:1", sourceId }),
          store,
          clock,
        ),
      ),
    ).toContain(VIEWER_READONLY_MESSAGE);
    expect(await store.assets.readAssets()).toEqual([]);
  });
});

describe("including", () => {
  test("what is ticked lands in one batch and the band says so", async () => {
    const sourceId = await connect(SAVED);
    await redirected(
      readMyInvestorProductsAction(
        form({ currentUrl: URL, sourceId }),
        store,
        clock,
        fixtureClients,
      ),
    );
    const row = await store.connectedSources.readDiscovery(sourceId);
    const discovery = JSON.parse(row!.payloadJson) as {
      products: {
        key: string;
        kind: string;
        otherHolder: boolean;
        portfolioKey: string | null;
      }[];
    };
    const cash = discovery.products.find(
      (product) =>
        product.kind === "cash" && !product.otherHolder && !product.portfolioKey,
    )!;
    const plan = discovery.products.find((product) => product.kind === "plan")!;

    const target = await redirected(
      includeMyInvestorProductsAction(
        form({ currentUrl: URL, productKey: [cash.key, plan.key], sourceId }),
        store,
        clock,
        noSymbols,
      ),
    );

    expect(target).toContain("ok=myinvestor_included");
    expect(target).toContain("created=2");
    expect(await store.connectedSources.readLinks(sourceId)).toHaveLength(2);
  });

  test("a twin set to «Enlazar» links its holding, and the band names it (#1881)", async () => {
    const sourceId = await connect(SAVED);
    await redirected(
      readMyInvestorProductsAction(
        form({ currentUrl: URL, sourceId }),
        store,
        clock,
        fixtureClients,
      ),
    );
    const row = await store.connectedSources.readDiscovery(sourceId);
    const discovery = JSON.parse(row!.payloadJson) as {
      products: {
        key: string;
        kind: string;
        otherHolder: boolean;
        instrument: { code: string } | null;
      }[];
    };
    const fund = discovery.products.find(
      (product) => product.kind === "fund" && !product.otherHolder,
    )!;
    const workspace = await store.workspace.readWorkspace();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "hand",
      instrument: "fund",
      liquidityTier: "market",
      name: "Fondo a mano",
      ownership: [{ memberId: workspace!.members[0]!.id, shareBps: 10_000 }],
      securityId: { kind: "isin", value: fund.instrument!.code },
    });

    const target = await redirected(
      includeMyInvestorProductsAction(
        form({ currentUrl: URL, sourceId, [`twin:${fund.key}`]: "link:hand" }),
        store,
        clock,
        noSymbols,
      ),
    );

    expect(target).toContain("ok=myinvestor_included");
    expect(await store.connectedSources.readLinks(sourceId)).toEqual([
      { assetId: "hand", productKey: fund.key },
    ]);
    const params = Object.fromEntries(new URLSearchParams(target.split("?")[1]));
    expect(resolveOkMessage(params)).toContain(
      "«Fondo a mano» ya está enlazado con MyInvestor: de solo lectura, salvo el coste heredado.",
    );
  });

  test("including with nothing read says what to do first", async () => {
    const sourceId = await connect(SAVED);

    const target = await redirected(
      includeMyInvestorProductsAction(
        form({ currentUrl: URL, productKey: "cash:1", sourceId }),
        store,
        clock,
        noSymbols,
      ),
    );

    expect(target).toContain("Aún no hemos leído tus productos de MyInvestor");
    expect(target).toContain("form=myinvestor-include");
  });

  test("from the fold's island a refusal comes back as state, not as a redirect", async () => {
    const sourceId = await connect(SAVED);

    const state = await includeMyInvestorProductsAction(
      form({ currentUrl: URL, inlineError: "1", productKey: "cash:1", sourceId }),
      store,
      clock,
      noSymbols,
    );

    expect(state).toMatchObject({ ok: false });
    expect(state.ok ? null : state.error).toContain("Aún no hemos leído");
  });
});
