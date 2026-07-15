/**
 * Resolve/dismiss action tests (#1050): `guardAdmin` runs first; a `javascript:`
 * link is stripped before persistence; an unknown alert falls back to the list
 * instead of surfacing a raw 500; a valid close redirects to the detail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@web/admin/guard-admin", () => ({ guardAdmin: vi.fn() }));
vi.mock("@web/admin/admin-control-plane", () => ({ withControlPlaneStore: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import { guardAdmin } from "@web/admin/guard-admin";

import { resolveMaintainerAlertAction } from "./resolve-maintainer-alert-action";

const updateMaintainerAlertStatus = vi.fn();

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("resolveMaintainerAlertAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
    updateMaintainerAlertStatus.mockResolvedValue(undefined);
    vi.mocked(withControlPlaneStore).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test double for the store seam
      (run: any) => run({ updateMaintainerAlertStatus }),
    );
  });

  it("persists a resolve with an http(s) link and redirects to the detail", async () => {
    await expect(
      resolveMaintainerAlertAction(
        form({
          alertId: "alert-1",
          status: "resolved",
          note: "arreglado",
          link: "https://github.com/jenarvaezg/worthline/issues/1042",
        }),
      ),
    ).rejects.toThrow("REDIRECT:/admin/alertas/alert-1");

    expect(updateMaintainerAlertStatus).toHaveBeenCalledWith("alert-1", {
      status: "resolved",
      note: "arreglado",
      link: "https://github.com/jenarvaezg/worthline/issues/1042",
    });
  });

  it("strips a javascript: link before persisting", async () => {
    await expect(
      resolveMaintainerAlertAction(
        form({ alertId: "alert-1", status: "dismissed", link: "javascript:alert(1)" }),
      ),
    ).rejects.toThrow("REDIRECT:/admin/alertas/alert-1");

    const call = updateMaintainerAlertStatus.mock.calls[0]![1];
    expect(call).not.toHaveProperty("link");
    expect(call.status).toBe("dismissed");
  });

  it("falls back to the list when the alert is unknown", async () => {
    updateMaintainerAlertStatus.mockRejectedValueOnce(
      new Error("Maintainer alert not found."),
    );

    await expect(
      resolveMaintainerAlertAction(form({ alertId: "ghost", status: "resolved" })),
    ).rejects.toThrow("REDIRECT:/admin/alertas");
  });

  it("rejects an invalid status without touching the store", async () => {
    await expect(
      resolveMaintainerAlertAction(form({ alertId: "alert-1", status: "open" })),
    ).rejects.toThrow("REDIRECT:/admin/alertas");
    expect(updateMaintainerAlertStatus).not.toHaveBeenCalled();
  });
});
