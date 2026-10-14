import type { WorkspaceSharedWithUser } from "@worthline/db";

/**
 * «Compartidos contigo» (#1844, S4 of #1718, ADR 0112): the workspaces other
 * people own and shared with this identity, each with the way in. On /ajustes,
 * and where someone who was only invited lands after their first sign-in:
 * /empezar (their own workspace is still empty) and /bienvenida.
 *
 * «Ver su espacio» is a real form POSTing the workspace id to `/viewing`, which
 * checks the grant of THIS session before setting the cookie. POST, never a GET
 * link (ADR 0009): a prefetch must not switch workspaces for the person. Zero JS.
 *
 * Renders nothing when the list is empty: an absent section is not news.
 */
export default function SharedWithYou({
  className = "section",
  workspaces,
}: {
  className?: string;
  workspaces: readonly WorkspaceSharedWithUser[];
}) {
  if (workspaces.length === 0) return null;

  return (
    <section aria-label="Compartidos contigo" className={className}>
      <div className="panelHeader">
        <h2>Compartidos contigo</h2>
        <span>Solo lectura</span>
      </div>
      <p className="muted">
        Estas personas te dejan ver su espacio: sus cifras y fichas, sin poder cambiar
        nada.
      </p>
      <ul className="sharingList">
        {workspaces.map((workspace) => (
          <li className="sharingRow" key={workspace.workspaceId}>
            <span className="sharingEmail">{workspace.ownerEmail}</span>
            <form action="/viewing" method="post">
              <input name="workspaceId" type="hidden" value={workspace.workspaceId} />
              <button className="btnSmall" type="submit">
                Ver su espacio
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
