import { viewsSharedWorkspace } from "@web/demo/write-guard";
import { readStoreTarget } from "@web/read-store-target";

/**
 * The viewer's session band (#1844, S4 of #1718, ADR 0112), rendered on every
 * page while the session views a workspace someone shared with it — from the
 * root layout, under `Suspense` like the demo and impersonation bands.
 *
 * The neutral tone of the demo band, not impersonation's gold: viewing a shared
 * workspace is a legitimate state the owner granted, nothing to be warned about.
 * It names WHOSE workspace it is — the marker's value, which is why this module
 * is on the `read-only-classifier-guardian` allowlist; it decides nothing about
 * writing.
 *
 * «Volver a mi espacio» POSTs to `/viewing/exit`, which clears the cookie and
 * lands on the session's own `/app`. POST + route handler, never a GET link
 * (ADR 0009): a prefetch must not leave the workspace for the person.
 */
export default async function ViewingBanner() {
  const target = await readStoreTarget();
  // The classifier decides WHETHER; the marker only says whose.
  const ownerEmail =
    viewsSharedWorkspace(target) && target.kind === "authenticated"
      ? target.sharedByEmail
      : undefined;
  if (!ownerEmail) return null;

  return (
    <div aria-label="Espacio compartido" className="sessionBand" role="note">
      <span>
        Estás viendo el espacio de <strong>{ownerEmail}</strong> · Solo lectura
      </span>
      <form action="/viewing/exit" method="post">
        <button type="submit">Volver a mi espacio →</button>
      </form>
    </div>
  );
}
