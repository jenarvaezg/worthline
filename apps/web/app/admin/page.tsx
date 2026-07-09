import { impersonateWorkspaceAction } from "@web/admin/actions";
import { guardAdmin } from "@web/admin/guard-admin";
import { listAdminWorkspaces } from "@web/admin/list-workspaces";

export const dynamic = "force-dynamic";

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * The /admin surface (#697, ADR 0030): a user/workspace list from the control
 * plane, with a per-row "Impersonar" action. `guardAdmin()` runs first — any
 * non-admin request never reaches the query below and gets the app's generic
 * 404, byte-identical to an unknown URL.
 */
export default async function AdminPage() {
  await guardAdmin();
  const workspaces = await listAdminWorkspaces();

  return (
    <main className="demoLanding">
      <header className="demoLandingHead">
        <p className="demoKicker">worthline · admin</p>
        <h1>Usuarios</h1>
        <p className="demoLede">Workspaces dados de alta en el control plane.</p>
      </header>

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
    </main>
  );
}
