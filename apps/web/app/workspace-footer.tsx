/**
 * WorkspaceFooter (#1190) — the persistence footer ("franja de remate en
 * cubierta", #909), lifted out of the per-page `Shell` into the shared
 * `(workspace)` layout. Reads persistence status, so the layout renders it
 * inside its own `<Suspense>` while the chrome frame stays synchronous.
 */

import { resolveWorkspaceContext } from "@web/page-shell";

export default async function WorkspaceFooter() {
  const { persistence } = await resolveWorkspaceContext();
  const savedAt = new Date(persistence.checkedAt).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <footer className="persistenceBar coverSurface">
      <span>{persistence.displayPath}</span>
      <span>guardado · {savedAt}</span>
    </footer>
  );
}
