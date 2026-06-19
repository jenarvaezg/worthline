import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";
import Database from "better-sqlite3";

import { createWorthlineStore } from "@worthline/db";
import { GET } from "../apps/web/app/api/v1/agent-view/scopes/route";
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

function request(path = "/api/v1/agent-view/scopes"): NextRequest {
  return new NextRequest(`http://127.0.0.1${path}`, {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

describe("GET /api/v1/agent-view/scopes", () => {
  test("returns household, active member, and member group scopes in the shared envelope", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      groups: [
        {
          id: "scope_adults",
          memberIds: ["member_ana", "member_jose"],
          name: "Adultos",
        },
      ],
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
        { id: "member_noa", name: "Noa" },
      ],
      mode: "household",
    });
    store.workspace.disableMember("member_noa", "2026-06-01T00:00:00.000Z");
    store.close();

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      data: [
        {
          id: expect.stringMatching(/^wl_scp_/),
          isDefault: true,
          label: "Hogar",
          members: [
            expect.objectContaining({
              id: expect.stringMatching(/^wl_mbr_/),
              label: "Ana",
            }),
            expect.objectContaining({
              id: expect.stringMatching(/^wl_mbr_/),
              label: "Jose",
            }),
          ],
          object: "scope",
          type: "household",
        },
        {
          id: expect.stringMatching(/^wl_scp_/),
          isDefault: false,
          label: "Ana",
          members: [
            expect.objectContaining({
              id: expect.stringMatching(/^wl_mbr_/),
              label: "Ana",
            }),
          ],
          object: "scope",
          type: "member",
        },
        {
          id: expect.stringMatching(/^wl_scp_/),
          isDefault: false,
          label: "Jose",
          members: [
            expect.objectContaining({
              id: expect.stringMatching(/^wl_mbr_/),
              label: "Jose",
            }),
          ],
          object: "scope",
          type: "member",
        },
        {
          id: expect.stringMatching(/^wl_scp_/),
          isDefault: false,
          label: "Adultos",
          members: [
            expect.objectContaining({
              id: expect.stringMatching(/^wl_mbr_/),
              label: "Ana",
            }),
            expect.objectContaining({
              id: expect.stringMatching(/^wl_mbr_/),
              label: "Jose",
            }),
          ],
          object: "scope",
          type: "group",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("Noa");
  });

  test("keeps public scope and member IDs stable across workspace export and import", async () => {
    const sourcePath = tempDatabasePath("worthline-agent-view-source-");
    const targetPath = tempDatabasePath("worthline-agent-view-target-");
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const source = createWorthlineStore({ databasePath: sourcePath });
    source.workspace.initializeWorkspace({
      groups: [{ id: "scope_family", memberIds: ["member_ana"], name: "Familia" }],
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "household",
    });
    const exported = source.workspace.exportWorkspace();
    source.close();

    process.env.WORTHLINE_DB_PATH = sourcePath;
    const before = await (await GET(request())).json();

    const target = createWorthlineStore({ databasePath: targetPath });
    target.workspace.importWorkspace(exported);
    target.close();

    process.env.WORTHLINE_DB_PATH = targetPath;
    const after = await (await GET(request())).json();

    expect(after).toEqual(before);
  });

  test("backfills public IDs when importing a pre-#334 export without publicIds", async () => {
    const sourcePath = tempDatabasePath("worthline-agent-view-legacy-source-");
    const targetPath = tempDatabasePath("worthline-agent-view-legacy-target-");
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const source = createWorthlineStore({ databasePath: sourcePath });
    source.workspace.initializeWorkspace({
      groups: [{ id: "scope_family", memberIds: ["member_ana"], name: "Familia" }],
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "household",
    });
    const exported = source.workspace.exportWorkspace();
    source.close();

    // Pre-#334 exports carry no public IDs; import must backfill them so the
    // read path never 500s on a freshly restored legacy workspace.
    const legacy = { ...exported, publicIds: [] };

    const target = createWorthlineStore({ databasePath: targetPath });
    target.workspace.importWorkspace(legacy);
    target.close();

    process.env.WORTHLINE_DB_PATH = targetPath;
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(3);
    for (const scope of body.data) {
      expect(scope.id).toMatch(/^wl_scp_/);
      for (const member of scope.members) {
        expect(member.id).toMatch(/^wl_mbr_/);
      }
    }
  });

  test("rejects unknown query parameters", async () => {
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const response = await GET(request("/api/v1/agent-view/scopes?foo=bar"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        details: { unknownParams: ["foo"] },
        message: "Unknown query parameter.",
      },
    });
  });

  test("rejects requests without the local capability token", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-auth-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const response = await GET(
      new NextRequest("http://127.0.0.1/api/v1/agent-view/scopes", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Missing or invalid agent view capability token.",
      },
    });
  });

  test("rejects malformed bearer token headers", async () => {
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const response = await GET(
      new NextRequest("http://127.0.0.1/api/v1/agent-view/scopes", {
        headers: { authorization: "Bearer local-agent-token extra" },
        method: "GET",
      }),
    );

    expect(response.status).toBe(401);
  });

  test("rejects non-loopback requests in local mode", async () => {
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const response = await GET(
      new NextRequest("http://192.168.1.50/api/v1/agent-view/scopes", {
        headers: { authorization: "Bearer local-agent-token" },
        method: "GET",
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden",
        message: "Agent view is only available from loopback addresses in local mode.",
      },
    });
  });

  test("rejects forwarded non-loopback client addresses", async () => {
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const response = await GET(
      new NextRequest("http://127.0.0.1/api/v1/agent-view/scopes", {
        headers: {
          authorization: "Bearer local-agent-token",
          "x-forwarded-for": "203.0.113.10",
        },
        method: "GET",
      }),
    );

    expect(response.status).toBe(403);
  });

  test("does not create missing public IDs during an agent-view read", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-readonly-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "household",
    });
    store.close();

    const sqlite = new Database(databasePath);
    sqlite
      .prepare(
        "DELETE FROM agent_view_public_ids WHERE entity_type = 'scope' AND entity_id = 'household'",
      )
      .run();
    sqlite.close();

    const response = await GET(request());

    expect(response.status).toBe(500);
    const reopened = createWorthlineStore({ databasePath });
    expect(
      reopened.agentView
        .readPublicIds()
        .some((row) => row.entityType === "scope" && row.entityId === "household"),
    ).toBe(false);
    reopened.close();
  });

  test("does not export public IDs for hard-deleted members", () => {
    const databasePath = tempDatabasePath("worthline-agent-view-stale-public-id-");
    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "household",
    });
    store.workspace.createMember({ id: "member_old", name: "Old" });
    store.workspace.disableMember("member_old", "2026-06-01T00:00:00.000Z");
    expect(store.workspace.hardDeleteMember("member_old")).toBe(1);

    const doc = store.workspace.exportWorkspace();

    expect(doc.publicIds.some((row) => row.entityId === "member_old")).toBe(false);
    store.close();
  });
});
