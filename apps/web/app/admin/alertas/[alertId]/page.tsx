import { getAdminMaintainerAlert } from "@web/admin/get-maintainer-alert";
import { guardAdmin } from "@web/admin/guard-admin";
import { MaintainerAlertDetail } from "@web/admin/maintainer-alert-detail";
import { notFound } from "next/navigation";

/**
 * Block (#1229): this route opts out of Instant Navigations validation.
 * Soft-click shell prefetching is not the goal here — see the route table on
 * issue #1229 for the why.
 */
export const instant = false;

/**
 * The forensic detail of one maintainer alert (#1050, ADR 0064). Guarded like
 * the rest of /admin; an unknown alert id 404s the same as any other missing
 * resource, never leaking that the route exists.
 */
export default async function AdminAlertDetailPage({
  params,
}: {
  params: Promise<{ alertId: string }>;
}) {
  await guardAdmin();
  const { alertId } = await params;
  const alert = await getAdminMaintainerAlert(alertId);
  if (!alert) {
    notFound();
  }
  return <MaintainerAlertDetail alert={alert} />;
}
