import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getWarningOverrides } from "@web/api/v1/agent-view/warning-overrides/route";
import { GET as getWorkspace } from "@web/api/v1/agent-view/workspace/route";
import { createWorthlineStoreUnsafe } from "@worthline/db";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

const ORIGINAL_DB_PATH = process.env.WORTHLINE_DB_PATH;
const ORIGINAL_TOKEN = process.env.WORTHLINE_AGENT_VIEW_TOKEN;

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

async function workspace() {
  const response = await getWorkspace(authedRequest("/api/v1/agent-view/workspace"));
  return { body: await response.json(), response };
}

async function warningOverrides() {
  const response = await getWarningOverrides(
    authedRequest("/api/v1/agent-view/warning-overrides"),
  );
  return { body: await response.json(), response };
}

/**
 * Seed a HOUSEHOLD workspace with a zero-value stored asset (which trips the
 * overrideable ZERO_VALUE_ASSET warning) and acknowledge that warning, so the
 * tools have a non-default mode and one override to surface. Returns the public
 * holding id the override should resolve to.
 */
async function seedWorkspace(): Promise<string> {
  const databasePath = tempDatabasePath("worthline-agent-view-workspace-");
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStoreUnsafe({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [
      { id: "member_jose", name: "Jose" },
      { id: "member_ana", name: "Ana" },
    ],
    mode: "household",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 0,
    id: "asset_zero",
    liquidityTier: "illiquid",
    name: "Cuadro sin tasar",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "manual",
  });
  await store.acknowledgeWarning("ZERO_VALUE_ASSET", "asset_zero");

  const publicId = (await store.agentView.readPublicIds()).find(
    (row) => row.entityType === "holding" && row.entityId === "asset_zero",
  )!.publicId;
  store.close();
  return publicId;
}

const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const req = authedRequest(path);
    if (path === "/api/v1/agent-view/workspace") {
      return (await (await getWorkspace(req)).json()) as T;
    }
    if (path === "/api/v1/agent-view/warning-overrides") {
      return (await (await getWarningOverrides(req)).json()) as T;
    }
    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

describe("GET /api/v1/agent-view/workspace", () => {
  test("returns the workspace mode and base currency", async () => {
    await seedWorkspace();
    const { body, response } = await workspace();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data).toEqual({
      object: "workspace",
      mode: "household",
      baseCurrency: "EUR",
    });
  });

  test("requires the local capability token", async () => {
    await seedWorkspace();
    const response = await getWorkspace(
      new NextRequest("http://127.0.0.1/api/v1/agent-view/workspace", { method: "GET" }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects unknown query parameters", async () => {
    await seedWorkspace();
    const response = await getWorkspace(
      authedRequest("/api/v1/agent-view/workspace?nope=1"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
  });
});

describe("GET /api/v1/agent-view/warning-overrides", () => {
  test("returns each acknowledged warning with its code and public holding id", async () => {
    const expectedHoldingId = await seedWorkspace();
    const { body, response } = await warningOverrides();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      {
        object: "warning_override",
        code: "ZERO_VALUE_ASSET",
        holding: expectedHoldingId,
      },
    ]);
    expect(expectedHoldingId).toMatch(/^wl_hld_/);
  });

  test("surfacing overrides does not mutate persisted state", async () => {
    await seedWorkspace();
    const databasePath = process.env.WORTHLINE_DB_PATH as string;

    const before = await fingerprint(databasePath);
    await warningOverrides();
    await workspace();
    const after = await fingerprint(databasePath);

    expect(after).toBe(before);
  });

  test("requires the local capability token", async () => {
    await seedWorkspace();
    const response = await getWarningOverrides(
      new NextRequest("http://127.0.0.1/api/v1/agent-view/warning-overrides", {
        method: "GET",
      }),
    );
    expect(response.status).toBe(401);
  });

  test("MCP get_workspace and get_warning_overrides mirror the HTTP shape", async () => {
    await seedWorkspace();
    const httpWorkspace = (await workspace()).body;
    const httpOverrides = (await warningOverrides()).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    expect(await catalog.get_workspace.invoke({})).toEqual(httpWorkspace);
    expect(await catalog.get_warning_overrides.invoke({})).toEqual(httpOverrides);
  });
});

// A fingerprint of the override + public-id state, to prove a read writes nothing.
async function fingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStoreUnsafe({ databasePath });
  const snapshot = JSON.stringify({
    overrides: await store.readWarningOverrides(),
    publicIds: await store.agentView.readPublicIds(),
  });
  store.close();
  return snapshot;
}
