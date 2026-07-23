/**
 * Admin premium palanca action tests (PRD #1160 S4, #1164). Like every admin
 * action, `guardAdmin` is the first line — a direct call without an admin
 * session must reject (404) before touching the control plane. The pure
 * `parsePremiumUntil` carries the date contract (indefinite vs dated vs
 * invalid); the actions wire it to the store and redirect.
 */
import type { EntitlementDirectory } from "@worthline/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@web/admin/guard-admin", () => ({
  guardAdmin: vi.fn(),
}));

const grantWorkspacePremium = vi.fn();
const revokeWorkspacePremium = vi.fn();
const readWorkspaceEntitlement = vi.fn();
const updateWorkspaceBilling = vi.fn();

vi.mock("@web/admin/admin-control-plane", () => ({
  withControlPlaneStore: vi.fn(
    async (
      run: (
        store: Pick<
          EntitlementDirectory,
          | "grantWorkspacePremium"
          | "readWorkspaceEntitlement"
          | "revokeWorkspacePremium"
          | "updateWorkspaceBilling"
        >,
      ) => unknown,
    ) =>
      run({
        grantWorkspacePremium,
        readWorkspaceEntitlement,
        revokeWorkspacePremium,
        updateWorkspaceBilling,
      }),
  ),
}));

const getBillingAdapter = vi.fn();
vi.mock("@web/billing/get-billing-adapter", () => ({
  getBillingAdapter: (...args: unknown[]) => getBillingAdapter(...args),
}));

import { guardAdmin } from "@web/admin/guard-admin";
import type { WorkspaceEntitlement } from "@worthline/db";
import { notFound } from "next/navigation";

import {
  grantWorkspacePremiumAction,
  resyncWorkspaceBillingAction,
  revokeWorkspacePremiumAction,
} from "./entitlement-actions";
import { parsePremiumUntil } from "./parse-premium-until";

const NOW = "2026-07-22T12:00:00.000Z";

/** Run an action expecting redirect(); returns the destination digest. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    throw new Error("action did not redirect");
  } catch (err) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

describe("parsePremiumUntil", () => {
  it("treats an empty date as an indefinite grant", () => {
    expect(parsePremiumUntil("", NOW)).toEqual({ ok: true, premiumUntil: null });
    expect(parsePremiumUntil("   ", NOW)).toEqual({ ok: true, premiumUntil: null });
  });

  it("accepts a future YYYY-MM-DD as premium through the end of that day (UTC)", () => {
    expect(parsePremiumUntil("2026-08-01", NOW)).toEqual({
      ok: true,
      premiumUntil: "2026-08-01T23:59:59.999Z",
    });
  });

  it("rejects a malformed date", () => {
    expect(parsePremiumUntil("2026/08/01", NOW)).toEqual({ ok: false });
    expect(parsePremiumUntil("nonsense", NOW)).toEqual({ ok: false });
    expect(parsePremiumUntil("2026-13-40", NOW)).toEqual({ ok: false });
  });

  it("rejects an unreal calendar day that Date.parse would silently roll over", () => {
    // 2026 is not a leap year; Date.parse rolls 02-30 → Mar 2 rather than failing.
    expect(parsePremiumUntil("2026-02-30", NOW)).toEqual({ ok: false });
    expect(parsePremiumUntil("2099-04-31", NOW)).toEqual({ ok: false });
  });

  it("rejects today or a past date — it would grant a no-op that derives back to free", () => {
    // End of 2026-07-22 is still after NOW (noon), so a same-day date is honored…
    expect(parsePremiumUntil("2026-07-22", NOW)).toEqual({
      ok: true,
      premiumUntil: "2026-07-22T23:59:59.999Z",
    });
    // …but a strictly past day is refused.
    expect(parsePremiumUntil("2026-07-21", NOW)).toEqual({ ok: false });
  });
});

describe("grantWorkspacePremiumAction", () => {
  beforeEach(() => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects (404) for a non-admin and never touches the control plane", async () => {
    vi.mocked(guardAdmin).mockImplementationOnce(async () => notFound());
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");

    await expect(grantWorkspacePremiumAction(fd)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(grantWorkspacePremium).not.toHaveBeenCalled();
  });

  it("grants an indefinite premium (empty date) and redirects to /admin", async () => {
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");
    fd.set("premiumUntil", "");

    const digest = await redirectOf(() => grantWorkspacePremiumAction(fd));
    expect(digest).toContain("/admin");
    expect(grantWorkspacePremium).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      premiumUntil: null,
    });
  });

  it("grants a dated premium through the end of the given day", async () => {
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");
    fd.set("premiumUntil", "2099-01-15");

    await redirectOf(() => grantWorkspacePremiumAction(fd));
    expect(grantWorkspacePremium).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      premiumUntil: "2099-01-15T23:59:59.999Z",
    });
  });

  it("bounces an invalid date back to /admin with an error flag, applying nothing", async () => {
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");
    fd.set("premiumUntil", "not-a-date");

    const digest = await redirectOf(() => grantWorkspacePremiumAction(fd));
    expect(digest).toContain("entError=fecha");
    expect(grantWorkspacePremium).not.toHaveBeenCalled();
  });

  it("redirects to /admin without applying when the workspace id is blank", async () => {
    const fd = new FormData();
    fd.set("workspaceId", "");

    const digest = await redirectOf(() => grantWorkspacePremiumAction(fd));
    expect(digest).toContain("/admin");
    expect(grantWorkspacePremium).not.toHaveBeenCalled();
  });
});

describe("revokeWorkspacePremiumAction", () => {
  beforeEach(() => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects (404) for a non-admin and never touches the control plane", async () => {
    vi.mocked(guardAdmin).mockImplementationOnce(async () => notFound());
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");

    await expect(revokeWorkspacePremiumAction(fd)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(revokeWorkspacePremium).not.toHaveBeenCalled();
  });

  it("revokes and redirects to /admin", async () => {
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");

    const digest = await redirectOf(() => revokeWorkspacePremiumAction(fd));
    expect(digest).toContain("/admin");
    expect(revokeWorkspacePremium).toHaveBeenCalledWith("ws-a");
  });
});

describe("resyncWorkspaceBillingAction (PRD #1160 S5, #1165)", () => {
  const NOW_ROW = "2026-07-23T12:00:00.000Z";
  const PERIOD_END = "2026-08-23T12:00:00.000Z";

  function subscribedRow(
    overrides: Partial<WorkspaceEntitlement> = {},
  ): WorkspaceEntitlement {
    return {
      workspaceId: "ws-a",
      plan: "premium",
      trialEndsAt: null,
      premiumUntil: NOW_ROW,
      billingProvider: "fake",
      billingCustomerId: "cus-1",
      subscriptionId: "sub-1",
      subscriptionStatus: "active",
      onboardedAt: null,
      firstHoldingAt: null,
      createdAt: NOW_ROW,
      updatedAt: NOW_ROW,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
    getBillingAdapter.mockReturnValue({
      provider: "fake",
      readSubscription: vi.fn(async () => ({
        status: "active",
        customerId: "cus-1",
        paidUntil: PERIOD_END,
      })),
    });
    readWorkspaceEntitlement.mockResolvedValue(subscribedRow());
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects (404) for a non-admin and never touches the control plane", async () => {
    vi.mocked(guardAdmin).mockImplementationOnce(async () => notFound());
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");

    await expect(resyncWorkspaceBillingAction(fd)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(updateWorkspaceBilling).not.toHaveBeenCalled();
  });

  it("consulta el estado real vía adapter y reescribe la fila con la transición del webhook", async () => {
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");

    const digest = await redirectOf(() => resyncWorkspaceBillingAction(fd));

    expect(digest).toContain("/admin");
    expect(digest).not.toContain("entError");
    expect(updateWorkspaceBilling).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-a",
        premiumUntil: PERIOD_END,
        billingProvider: "fake",
        subscriptionId: "sub-1",
        subscriptionStatus: "active",
      }),
    );
  });

  it("un workspace sin suscripción del MoR rebota con el flag de error, sin escribir", async () => {
    readWorkspaceEntitlement.mockResolvedValue(
      subscribedRow({ subscriptionId: null, billingProvider: null }),
    );
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");

    const digest = await redirectOf(() => resyncWorkspaceBillingAction(fd));

    expect(digest).toContain("entError=resync");
    expect(updateWorkspaceBilling).not.toHaveBeenCalled();
  });

  it("sin adapter, o con un adapter de otro proveedor, rebota sin escribir", async () => {
    getBillingAdapter.mockReturnValue(null);
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");
    expect(await redirectOf(() => resyncWorkspaceBillingAction(fd))).toContain(
      "entError=resync",
    );

    getBillingAdapter.mockReturnValue({ provider: "paddle", readSubscription: vi.fn() });
    expect(await redirectOf(() => resyncWorkspaceBillingAction(fd))).toContain(
      "entError=resync",
    );
    expect(updateWorkspaceBilling).not.toHaveBeenCalled();
  });

  it("una suscripción que el proveedor no conoce rebota sin escribir", async () => {
    getBillingAdapter.mockReturnValue({
      provider: "fake",
      readSubscription: vi.fn(async () => null),
    });
    const fd = new FormData();
    fd.set("workspaceId", "ws-a");

    const digest = await redirectOf(() => resyncWorkspaceBillingAction(fd));

    expect(digest).toContain("entError=resync");
    expect(updateWorkspaceBilling).not.toHaveBeenCalled();
  });
});
