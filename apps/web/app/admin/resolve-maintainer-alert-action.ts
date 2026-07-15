"use server";

import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import { guardAdmin } from "@web/admin/guard-admin";
import type { MaintainerAlertStatus } from "@worthline/db";
import { redirect } from "next/navigation";

/**
 * Close a maintainer alert (#1050, ADR 0064): `resolved` or `dismissed`, with an
 * optional note/link. `guardAdmin` runs FIRST — a direct POST without an admin
 * session 404s exactly like the page, never trusting that the page gated the
 * click. Alerts live only in the control plane, so this never touches a
 * workspace database.
 */
export async function resolveMaintainerAlertAction(formData: FormData): Promise<never> {
  await guardAdmin();

  const alertId = String(formData.get("alertId") ?? "").trim();
  const rawStatus = String(formData.get("status") ?? "").trim();
  if (!alertId || (rawStatus !== "resolved" && rawStatus !== "dismissed")) {
    redirect("/admin/alertas");
  }
  const status = rawStatus as Exclude<MaintainerAlertStatus, "open">;

  const note = String(formData.get("note") ?? "").trim();
  const link = String(formData.get("link") ?? "").trim();

  await withControlPlaneStore((store) =>
    store.updateMaintainerAlertStatus(alertId, {
      status,
      ...(note ? { note } : {}),
      ...(link ? { link } : {}),
    }),
  );

  redirect(`/admin/alertas/${alertId}`);
}
