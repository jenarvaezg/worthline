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

vi.mock("@web/admin/list-maintainer-alerts", () => ({
  countAdminOpenMaintainerAlerts: vi.fn(),
}));

vi.mock("@web/admin/list-ai-token-usage", () => ({
  listAdminAiTokenUsage: vi.fn(),
}));

import { guardAdmin } from "@web/admin/guard-admin";
import { listAdminAiTokenUsage } from "@web/admin/list-ai-token-usage";
import { countAdminOpenMaintainerAlerts } from "@web/admin/list-maintainer-alerts";
import { listAdminWorkspaces } from "@web/admin/list-workspaces";

import AdminPage from "./page";

describe("AdminPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(countAdminOpenMaintainerAlerts).mockResolvedValue(0);
    vi.mocked(listAdminAiTokenUsage).mockResolvedValue([]);
  });

  test("renders the workspace list for the admin, with a maintainer-alerts link + badge", async () => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
    vi.mocked(countAdminOpenMaintainerAlerts).mockResolvedValue(3);
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
    expect(html).toContain('href="/admin/alertas"');
    expect(html).toContain("Alertas de mantenedor");
    expect(html).toContain(">3<");
  });

  test("renders the global AI spend series as tokens per day", async () => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
    vi.mocked(listAdminWorkspaces).mockResolvedValue([]);
    vi.mocked(listAdminAiTokenUsage).mockResolvedValue([
      { dayKey: "2026-07-22", tokens: 1234567 },
      { dayKey: "2026-07-21", tokens: 42 },
    ]);

    const html = renderToStaticMarkup(await AdminPage());

    expect(html).toContain("Gasto de IA");
    expect(html).toContain("2026-07-22");
    // Grouped with the es-ES separator (computed the same way the page does, so
    // the assertion holds regardless of the runtime's ICU build).
    expect(html).toContain(new Intl.NumberFormat("es-ES").format(1234567));
  });

  test("shows an empty-state line when no AI spend is recorded yet", async () => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
    vi.mocked(listAdminWorkspaces).mockResolvedValue([]);
    vi.mocked(listAdminAiTokenUsage).mockResolvedValue([]);

    const html = renderToStaticMarkup(await AdminPage());
    expect(html).toContain("Aún no hay consumo de IA registrado");
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
