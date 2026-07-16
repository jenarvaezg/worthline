import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getSourceFreshness } from "@web/api/v1/agent-view/connected-sources/[sourceId]/freshness/route";
import { GET as listSources } from "@web/api/v1/agent-view/connected-sources/route";
import type { SourcePositionInput } from "@worthline/db";
import { createWorthlineStoreUnsafe } from "@worthline/db";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

const ORIGINAL_DB_PATH = process.env.WORTHLINE_DB_PATH;
const ORIGINAL_TOKEN = process.env.WORTHLINE_AGENT_VIEW_TOKEN;

// Secrets seeded into the sources' encrypted credentials — none may ever surface.
const NUMISTA_SECRET = "numista-secret-key-zzz";
const BINANCE_KEY = "binance-key-aaa";
const BINANCE_SECRET = "binance-secret-bbb";

afterEach(() => {
  if (ORIGINAL_DB_PATH === undefined) {
    delete process.env.WORTHLINE_DB_PATH;
  } else {
    process.env.WORTHLINE_DB_PATH = ORIGINAL_DB_PATH;
  }

  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.WORTHLINE_AGENT_VIEW_TOKEN;
  } else {
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = ORIGINAL_TOKEN;
  }

  cleanupTempDirs();
});

function authedRequest(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1${path}`, {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

interface SourceEntry {
  id: string;
  object: string;
  adapter: string;
  label: string;
  lastSyncAt: string | null;
  holdings: string[];
}

async function connectedSources(): Promise<{
  body: { data: SourceEntry[] };
  response: Response;
}> {
  const response = await listSources(
    authedRequest("/api/v1/agent-view/connected-sources"),
  );
  return { body: await response.json(), response };
}

async function sourceFreshness(sourceId: string) {
  const response = await getSourceFreshness(
    authedRequest(`/api/v1/agent-view/connected-sources/${sourceId}/freshness`),
    { params: Promise.resolve({ sourceId }) },
  );
  return { body: await response.json(), response };
}

const coin = (
  overrides: Partial<Extract<SourcePositionInput, { kind: "coin" }>> = {},
): SourcePositionInput => ({
  catalogueId: "n1",
  currency: "EUR",
  externalId: "coin-1",
  finenessMillis: null,
  grade: "VF",
  issueId: null,
  kind: "coin",
  liquidityTier: "illiquid",
  metal: "silver",
  metalValueMinor: 1_000,
  name: "8 reales",
  numismaticFetchedAt: null,
  numismaticValueMinor: 4_000,
  obverseThumbUrl: null,
  purchaseDate: "2024-01-01",
  purchasePriceMinor: null,
  quantity: 1,
  weightGrams: null,
  year: null,
  ...overrides,
});

const token = (
  overrides: Partial<Extract<SourcePositionInput, { kind: "token" }>> = {},
): SourcePositionInput => ({
  balance: "0.5",
  currency: "EUR",
  externalId: "BTC:spot",
  kind: "token",
  liquidityTier: "market",
  name: "BTC",
  symbol: "BTC",
  unitPrice: "50000",
  wallet: "spot",
  ...overrides,
});

/**
 * Seed a household with a Numista source that is synced AND revalued (so it
 * carries a stale freshness row) and a Binance source that is synced but never
 * revalued (so its freshness reads as null). Both connect with secret
 * credentials, which must never leak through the agent view.
 */
async function seedSources(): Promise<void> {
  const databasePath = tempDatabasePath("worthline-agent-view-sources-");
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStoreUnsafe({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

  const numista = await store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: NUMISTA_SECRET }),
    label: "Colección Numista",
    ownership: owner,
  });
  await store.connectedSources.syncPositions(
    numista.sourceId,
    [coin({ externalId: "coin-eagle", name: "Águila de oro" })],
    "2026-06-15T12:00:00.000Z",
  );
  const coins = await store.connectedSources.readPositions(numista.sourceId);
  await store.connectedSources.revaluePositions(
    numista.sourceId,
    coins.map((position) => ({
      id: position.id,
      metalValueMinor: position.kind === "coin" ? position.metalValueMinor : null,
      numismaticFetchedAt: "2026-06-16T09:00:00.000Z",
      numismaticValueMinor:
        position.kind === "coin" ? position.numismaticValueMinor : null,
    })),
    {
      fetchedAt: "2026-06-16T09:00:00.000Z",
      freshnessState: "stale",
      staleReason: "Precio caducado",
    },
  );

  const binance = await store.connectedSources.connect({
    adapter: "binance",
    credentialsJson: JSON.stringify({ apiKey: BINANCE_KEY, apiSecret: BINANCE_SECRET }),
    label: "Binance",
    ownership: owner,
  });
  await store.connectedSources.syncPositions(
    binance.sourceId,
    [token({ externalId: "BTC:spot", symbol: "BTC", unitPrice: "50000" })],
    "2026-06-16T10:00:00.000Z",
  );
  store.close();
}

// Route the MCP client to the real handlers so MCP output is proven against the
// HTTP contract rather than a hand-written double.
const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = authedRequest(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/agent-view/connected-sources") {
      return (await (await listSources(req)).json()) as T;
    }

    const freshnessMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/connected-sources\/([^/]+)\/freshness$/,
    );
    if (freshnessMatch) {
      const sourceId = decodeURIComponent(freshnessMatch[1]!);
      const response = await getSourceFreshness(req, {
        params: Promise.resolve({ sourceId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

async function sourceIdByAdapter(adapter: string): Promise<string> {
  const { body } = await connectedSources();
  return body.data.find((source) => source.adapter === adapter)!.id;
}

describe("GET /api/v1/agent-view/connected-sources", () => {
  test("lists every source with its public id, adapter, label, last sync, and holdings", async () => {
    await seedSources();
    const { body, response } = await connectedSources();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const sources = body.data;
    expect(sources).toHaveLength(2);

    for (const source of sources) {
      expect(source.id).toMatch(/^wl_src_/);
      expect(source.object).toBe("connected_source");
      expect(source.lastSyncAt).not.toBeNull();
      expect(source.holdings.length).toBeGreaterThan(0);
      for (const holdingId of source.holdings) {
        expect(holdingId).toMatch(/^wl_hld_/);
      }
    }

    const numista = sources.find((source) => source.adapter === "numista")!;
    expect(numista.label).toBe("Colección Numista");
    const binance = sources.find((source) => source.adapter === "binance")!;
    expect(binance.label).toBe("Binance");
  });

  test("never leaks credentials, tokens, or raw provider payloads", async () => {
    await seedSources();
    const list = JSON.stringify((await connectedSources()).body);
    const numistaId = await sourceIdByAdapter("numista");
    const binanceId = await sourceIdByAdapter("binance");
    const freshness =
      JSON.stringify((await sourceFreshness(numistaId)).body) +
      JSON.stringify((await sourceFreshness(binanceId)).body);
    const serialized = list + freshness;

    for (const secret of [NUMISTA_SECRET, BINANCE_KEY, BINANCE_SECRET]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of ["credentials", "credentialsJson", "apiKey", "apiSecret"]) {
      expect(serialized).not.toContain(field);
    }
  });
});

describe("GET /api/v1/agent-view/connected-sources/{sourceId}/freshness", () => {
  test("resolves a revalued source to its stale freshness with fetch time and reason", async () => {
    await seedSources();
    const numistaId = await sourceIdByAdapter("numista");

    const { body, response } = await sourceFreshness(numistaId);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      object: "source_freshness",
      source: numistaId,
      freshness: {
        freshnessState: "stale",
        fetchedAt: "2026-06-16T09:00:00.000Z",
        staleReason: "Precio caducado",
      },
    });
  });

  test("returns freshness:null for a source that has never been valued", async () => {
    await seedSources();
    const binanceId = await sourceIdByAdapter("binance");

    const { body, response } = await sourceFreshness(binanceId);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      object: "source_freshness",
      source: binanceId,
      freshness: null,
    });
  });

  test("unknown source id → 404 not_found", async () => {
    await seedSources();
    const { body, response } = await sourceFreshness("wl_src_doesnotexist");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("rejects unknown query parameters", async () => {
    await seedSources();
    const numistaId = await sourceIdByAdapter("numista");

    const response = await getSourceFreshness(
      authedRequest(`/api/v1/agent-view/connected-sources/${numistaId}/freshness?nope=1`),
      { params: Promise.resolve({ sourceId: numistaId }) },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
  });

  test("requires the local capability token", async () => {
    await seedSources();
    const numistaId = await sourceIdByAdapter("numista");

    const response = await getSourceFreshness(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/connected-sources/${numistaId}/freshness`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ sourceId: numistaId }) },
    );

    expect(response.status).toBe(401);
  });

  test("MCP list_connected_sources and get_source_freshness mirror the HTTP shape", async () => {
    await seedSources();
    const httpList = (await connectedSources()).body;
    const numistaId = await sourceIdByAdapter("numista");
    const httpFreshness = (await sourceFreshness(numistaId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    expect(await catalog.list_connected_sources.invoke({})).toEqual(httpList);
    expect(await catalog.get_source_freshness.invoke({ sourceId: numistaId })).toEqual(
      httpFreshness,
    );
  });
});
