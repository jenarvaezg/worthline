import { guardAdmin } from "@web/admin/guard-admin";
import { listAdminMaintainerAlerts } from "@web/admin/list-maintainer-alerts";
import { maintainerAlertSubject } from "@web/admin/missed-capture-alert";
import { maintainerAlertCategoryLabel } from "@web/asistente/maintainer-alert";
import type { MaintainerAlertStatus } from "@worthline/db";

/**
 * Block (#1229): this route opts out of Instant Navigations validation.
 * Soft-click shell prefetching is not the goal here — see the route table on
 * issue #1229 for the why.
 */
export const instant = false;

function statusLabel(status: MaintainerAlertStatus): string {
  switch (status) {
    case "open":
      return "Abierta";
    case "resolved":
      return "Resuelta";
    case "dismissed":
      return "Descartada";
  }
}

function formatSeenAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("es-ES", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

/**
 * The /admin «Alertas» surface (#1050, decision #1038, ADR 0064): the global
 * maintainer-alert index by recency, control-plane-only. Paper surface behind
 * `guardAdmin` — a non-admin request 404s before the query runs, byte-identical
 * to an unknown URL.
 */
export default async function AdminAlertsPage() {
  await guardAdmin();
  const { alerts, openCount } = await listAdminMaintainerAlerts();

  return (
    <main className="demoLanding maintainerAlerts">
      <header className="demoLandingHead">
        <p className="demoKicker">worthline · admin · alertas</p>
        <h1>
          Alertas de mantenedor{" "}
          {openCount > 0 ? (
            <span className="alertBadge">{openCount} abiertas</span>
          ) : null}
        </h1>
        <p className="demoLede">
          Sospechas de bug del asistente, solo-mantenedor. La reparación nunca espera a la
          alerta. <a href="/admin">← Usuarios</a>
        </p>
      </header>

      <section className="adminList section">
        {alerts.length === 0 ? (
          <p className="alertMeta">Sin alertas.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Categoría</th>
                {/* «Ámbito»/«Sujeto», not workspace/holding: a fleet alert (a missed
                    cron capture, #1339) has neither — see `maintainerAlertSubject`. */}
                <th>Ámbito</th>
                <th>Sujeto</th>
                <th>Estado</th>
                <th>Ocurr.</th>
                <th>Última señal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => {
                // A fleet alert (a missed cron pass, #1339) has no tenant and no
                // holding: the same two cells name the fleet and the lost pass.
                const subject = maintainerAlertSubject(alert);
                return (
                  <tr
                    key={alert.id}
                    className={alert.status === "open" ? "alertOpenRow" : undefined}
                  >
                    <td>{maintainerAlertCategoryLabel(alert.category)}</td>
                    <td>{subject.workspace}</td>
                    <td>{subject.subject}</td>
                    <td>{statusLabel(alert.status)}</td>
                    <td>{alert.occurrenceCount}</td>
                    <td>{formatSeenAt(alert.lastSeenAt)}</td>
                    <td className="rowActions">
                      <a className="btnSmall" href={`/admin/alertas/${alert.id}`}>
                        Ver
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
