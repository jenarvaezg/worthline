/**
 * `/admin/alertas` list page wiring + surface guardian (#1050). Mocks the guard
 * and the control-plane read seam to prove the page composes them and renders on
 * the canonical PAPER primitives (`.demoLanding` + `.section`, canon §2/§7) with
 * the open-count badge, and that a rejected guard propagates unchanged.
 */
import { notFound } from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@web/admin/guard-admin", () => ({ guardAdmin: vi.fn() }));
vi.mock("@web/admin/list-maintainer-alerts", () => ({
  listAdminMaintainerAlerts: vi.fn(),
}));

import { guardAdmin } from "@web/admin/guard-admin";
import { listAdminMaintainerAlerts } from "@web/admin/list-maintainer-alerts";

import AdminAlertsPage from "./page";

const OPEN_ALERT = {
  id: "alert-1",
  workspaceId: "ws-ana",
  holdingId: "wl_hld_loan",
  category: "infidelity" as const,
  status: "open" as const,
  occurrenceCount: 2,
  firstSeenAt: "2026-07-15T10:00:00.000Z",
  lastSeenAt: "2026-07-15T12:00:00.000Z",
  resolutionNote: null,
  resolutionLink: null,
  resolvedAt: null,
  supersedesAlertId: null,
  createdAt: "2026-07-15T10:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

describe("AdminAlertsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
  });

  test("renders the alert list on the canonical paper primitives with a badge", async () => {
    vi.mocked(listAdminMaintainerAlerts).mockResolvedValue({
      alerts: [OPEN_ALERT],
      openCount: 1,
    });

    const html = renderToStaticMarkup(await AdminAlertsPage());

    // Canon §2/§7: an interior tool on paper — .demoLanding shell + .section.
    expect(html).toContain('class="demoLanding maintainerAlerts"');
    expect(html).toContain("adminList section");
    expect(html).toContain("Infidelidad");
    expect(html).toContain("ws-ana");
    expect(html).toContain("wl_hld_loan");
    expect(html).toContain('href="/admin/alertas/alert-1"');
    expect(html).toContain("1 abiertas");
  });

  test("shows an empty state and no badge when there are no alerts", async () => {
    vi.mocked(listAdminMaintainerAlerts).mockResolvedValue({ alerts: [], openCount: 0 });

    const html = renderToStaticMarkup(await AdminAlertsPage());
    expect(html).toContain("Sin alertas.");
    expect(html).not.toContain("abiertas");
  });

  test("propagates guardAdmin's notFound() unchanged for a non-admin request", async () => {
    vi.mocked(guardAdmin).mockImplementation(async () => notFound());
    vi.mocked(listAdminMaintainerAlerts).mockResolvedValue({ alerts: [], openCount: 0 });

    await expect(AdminAlertsPage()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(listAdminMaintainerAlerts).not.toHaveBeenCalled();
  });
});
