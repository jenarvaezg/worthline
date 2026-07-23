/**
 * `/admin` page wiring tests (#697, ADR 0030; PRD #1160 S4, #1164). Mocks
 * `guardAdmin` and the page's queries (each unit-tested on its own) to prove the
 * PAGE composes them: an admin session renders the workspace list with plan
 * state and the premium palanca, a bad date flag surfaces an aviso, and a
 * rejected guard (the real `notFound()`) propagates unchanged.
 */
import type { AdminEntitlementRow } from "@web/admin/list-admin-entitlements";
import { notFound } from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@web/admin/guard-admin", () => ({
  guardAdmin: vi.fn(),
}));

vi.mock("@web/admin/list-admin-entitlements", () => ({
  listAdminEntitlements: vi.fn(),
}));

vi.mock("@web/admin/list-maintainer-alerts", () => ({
  countAdminOpenMaintainerAlerts: vi.fn(),
}));

vi.mock("@web/admin/list-ai-token-usage", () => ({
  listAdminAiTokenUsage: vi.fn(),
}));

import { guardAdmin } from "@web/admin/guard-admin";
import { listAdminEntitlements } from "@web/admin/list-admin-entitlements";
import { listAdminAiTokenUsage } from "@web/admin/list-ai-token-usage";
import { countAdminOpenMaintainerAlerts } from "@web/admin/list-maintainer-alerts";

import AdminPage from "./page";

function row(
  partial: Partial<AdminEntitlementRow> & { workspaceId: string },
): AdminEntitlementRow {
  return {
    ownerEmail: `${partial.workspaceId}@example.com`,
    createdAt: "2026-05-01T00:00:00.000Z",
    effectivePlan: "free",
    declaredPlan: null,
    trialEndsAt: null,
    premiumUntil: null,
    isIndefinitePremium: false,
    billingProvider: null,
    subscriptionStatus: null,
    tokensToday: 0,
    ...partial,
  };
}

const noSearchParams = Promise.resolve({});

describe("AdminPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(countAdminOpenMaintainerAlerts).mockResolvedValue(0);
    vi.mocked(listAdminAiTokenUsage).mockResolvedValue([]);
    vi.mocked(listAdminEntitlements).mockResolvedValue([]);
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
  });

  test("renders the workspace list with plan, palanca, and the alerts link + badge", async () => {
    vi.mocked(countAdminOpenMaintainerAlerts).mockResolvedValue(3);
    vi.mocked(listAdminEntitlements).mockResolvedValue([
      row({
        workspaceId: "ws-ana",
        ownerEmail: "ana@example.com",
        effectivePlan: "premium",
        declaredPlan: "premium",
        isIndefinitePremium: true,
        tokensToday: 1234,
      }),
    ]);

    const html = renderToStaticMarkup(await AdminPage({ searchParams: noSearchParams }));

    expect(html).toContain("ana@example.com");
    expect(html).toContain("ws-ana");
    expect(html).toContain("Impersonar");
    expect(html).toContain("Conceder premium");
    expect(html).toContain("Revocar"); // shown because effective plan is premium
    expect(html).toContain("Premium");
    expect(html).toContain("indefinido");
    expect(html).toContain('name="premiumUntil"');
    expect(html).toContain('value="ws-ana"');
    expect(html).toContain('href="/admin/alertas"');
    expect(html).toContain(">3<");
  });

  test("hides Revocar for a non-premium workspace and shows the trial window", async () => {
    vi.mocked(listAdminEntitlements).mockResolvedValue([
      row({
        workspaceId: "ws-free",
        effectivePlan: "trial",
        declaredPlan: "trial",
        trialEndsAt: "2026-07-25T00:00:00.000Z",
      }),
    ]);

    const html = renderToStaticMarkup(await AdminPage({ searchParams: noSearchParams }));
    expect(html).toContain("Trial");
    expect(html).toContain("Conceder premium");
    expect(html).not.toContain("Revocar");
  });

  test("surfaces an aviso when the grant date was invalid", async () => {
    const html = renderToStaticMarkup(
      await AdminPage({ searchParams: Promise.resolve({ entError: "fecha" }) }),
    );
    expect(html).toContain("Fecha de premium no válida");
  });

  test("renders the global AI spend series as tokens per day", async () => {
    vi.mocked(listAdminAiTokenUsage).mockResolvedValue([
      { dayKey: "2026-07-22", tokens: 1234567 },
      { dayKey: "2026-07-21", tokens: 42 },
    ]);

    const html = renderToStaticMarkup(await AdminPage({ searchParams: noSearchParams }));

    expect(html).toContain("Gasto de IA");
    expect(html).toContain("2026-07-22");
    expect(html).toContain(new Intl.NumberFormat("es-ES").format(1234567));
  });

  test("shows an empty-state line when no AI spend is recorded yet", async () => {
    const html = renderToStaticMarkup(await AdminPage({ searchParams: noSearchParams }));
    expect(html).toContain("Aún no hay consumo de IA registrado");
  });

  test("shows an em-dash for a dangling workspace with no owner", async () => {
    vi.mocked(listAdminEntitlements).mockResolvedValue([
      row({ workspaceId: "ws-orphan", ownerEmail: null }),
    ]);

    const html = renderToStaticMarkup(await AdminPage({ searchParams: noSearchParams }));
    expect(html).toContain("—");
  });

  test("propagates guardAdmin's notFound() unchanged for a non-admin request", async () => {
    vi.mocked(guardAdmin).mockImplementation(async () => notFound());

    await expect(AdminPage({ searchParams: noSearchParams })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(listAdminEntitlements).not.toHaveBeenCalled();
  });
});
