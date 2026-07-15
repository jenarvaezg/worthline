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
  const rawLink = String(formData.get("link") ?? "").trim();
  // The `type="url"` input is only a client hint; the value is later rendered as
  // an <a href>, so accept only http(s) here — a `javascript:` URI must never be
  // persisted and clicked from /admin.
  const link = /^https?:\/\//i.test(rawLink) ? rawLink : "";

  try {
    await withControlPlaneStore((store) =>
      store.updateMaintainerAlertStatus(alertId, {
        status,
        ...(note ? { note } : {}),
        ...(link ? { link } : {}),
      }),
    );
  } catch {
    // Unknown/already-gone alert (or a transient control-plane failure): fall
    // back to the list rather than surfacing a raw 500.
    redirect("/admin/alertas");
  }

  redirect(`/admin/alertas/${alertId}`);
}
