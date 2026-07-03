/**
 * `/admin` page wiring tests (#697, ADR 0030). Mocks `guardAdmin` and
 * `listAdminWorkspaces` (each already unit-tested on its own) to prove the
 * PAGE composes them correctly: an admin session renders the workspace list,
 * and a rejected guard (the real `notFound()`, not a stand-in) propagates
 * as-is — the page never catches or downgrades it.
 */
import { notFound } from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@web/admin/guard-admin", () => ({
  guardAdmin: vi.fn(),
}));

vi.mock("@web/admin/list-workspaces", () => ({
  listAdminWorkspaces: vi.fn(),
}));

import { guardAdmin } from "@web/admin/guard-admin";
import { listAdminWorkspaces } from "@web/admin/list-workspaces";

import AdminPage from "./page";

describe("AdminPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders the workspace list for the admin", async () => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
    vi.mocked(listAdminWorkspaces).mockResolvedValue([
      {
        id: "ws-ana",
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
        createdAt: "2026-05-01T00:00:00.000Z",
        ownerEmail: "ana@example.com",
      },
    ]);

    const html = renderToStaticMarkup(await AdminPage());

    expect(html).toContain("ana@example.com");
    expect(html).toContain("ws-ana");
    expect(html).toContain("Impersonar");
    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('value="ws-ana"');
  });

  test("shows an em-dash for a dangling workspace with no owner", async () => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
    vi.mocked(listAdminWorkspaces).mockResolvedValue([
      {
        id: "ws-orphan",
        dbName: "wl-orphan",
        dbUrl: "libsql://wl-orphan.turso.io",
        createdAt: "2026-05-01T00:00:00.000Z",
        ownerEmail: null,
      },
    ]);

    const html = renderToStaticMarkup(await AdminPage());
    expect(html).toContain("—");
  });

  test("propagates guardAdmin's notFound() unchanged for a non-admin request", async () => {
    vi.mocked(guardAdmin).mockImplementation(async () => notFound());
    vi.mocked(listAdminWorkspaces).mockResolvedValue([]);

    await expect(AdminPage()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(listAdminWorkspaces).not.toHaveBeenCalled();
  });
});
