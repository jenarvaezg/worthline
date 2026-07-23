import { impersonateWorkspaceAction } from "@web/admin/actions";
import { guardAdmin } from "@web/admin/guard-admin";
import { listAdminAiTokenUsage } from "@web/admin/list-ai-token-usage";
import { countAdminOpenMaintainerAlerts } from "@web/admin/list-maintainer-alerts";
import { listAdminWorkspaces } from "@web/admin/list-workspaces";

export const dynamic = "force-dynamic";

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const tokenFormatter = new Intl.NumberFormat("es-ES");

/**
 * The /admin surface (#697, ADR 0030): a user/workspace list from the control
 * plane, with a per-row "Impersonar" action. `guardAdmin()` runs first — any
 * non-admin request never reaches the query below and gets the app's generic
 * 404, byte-identical to an unknown URL.
 */
export default async function AdminPage() {
  await guardAdmin();
  const [workspaces, openAlerts, tokenUsage] = await Promise.all([
    listAdminWorkspaces(),
    countAdminOpenMaintainerAlerts(),
    listAdminAiTokenUsage(),
  ]);

  return (
    <main className="demoLanding">
      <header className="demoLandingHead">
        <p className="demoKicker">worthline · admin</p>
        <h1>Usuarios</h1>
        <p className="demoLede">
          Workspaces dados de alta en el control plane.{" "}
          <a href="/admin/alertas">
            Alertas de mantenedor
            {openAlerts > 0 ? <span className="alertBadge">{openAlerts}</span> : null}
          </a>{" "}
          · <a href="/admin/catalogo">Catálogo de exposición</a>
        </p>
      </header>

      {/* Canon §2: /admin is an interior tool on paper — the list sits inside a
          section opened by a heavy rule, never on the cover. */}
      <section className="adminList section">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Workspace</th>
              <th>Alta</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((workspace) => (
              <tr key={workspace.id}>
                <td>{workspace.ownerEmail ?? "—"}</td>
                <td>{workspace.id}</td>
                <td>{formatCreatedAt(workspace.createdAt)}</td>
                <td className="rowActions">
                  <form action={impersonateWorkspaceAction}>
                    <input name="workspaceId" type="hidden" value={workspace.id} />
                    <button className="btnSmall" type="submit">
                      Impersonar
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* AI spend meter (PRD #1160 S3, #1163): the shared daily token totals so
          the maintainer can see the cost. Aggregate only — no workspace data. */}
      <section className="adminList section">
        <h2>Gasto de IA · tokens/día (global)</h2>
        {tokenUsage.length === 0 ? (
          <p className="demoLede">Aún no hay consumo de IA registrado.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Día</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {tokenUsage.map((day) => (
                <tr key={day.dayKey}>
                  <td>{day.dayKey}</td>
                  <td>{tokenFormatter.format(day.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
