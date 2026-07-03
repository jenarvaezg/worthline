import { stopImpersonationAction } from "@web/admin/actions";
import { readStoreTarget } from "@web/read-store-target";

/**
 * The persistent "Viendo como <email> (solo lectura)" strip (#697, ADR 0030),
 * rendered on every page while an admin is impersonating a workspace (from the
 * root layout, gated by `isImpersonating()`). Mirrors `DemoBanner`'s shape —
 * same `.demoBanner` classes, a status strip rather than a card.
 *
 * "Salir" POSTs to `stopImpersonationAction`, which re-verifies `guardAdmin`,
 * clears the cookie, and redirects to /admin.
 */
export default async function ImpersonationBanner() {
  const target = await readStoreTarget();
  if (target.kind !== "authenticated" || target.impersonatedEmail === undefined) {
    return null;
  }

  return (
    <div className="demoBanner" role="note" aria-label="Impersonación de administrador">
      <span>
        Viendo como <strong>{target.impersonatedEmail}</strong> (solo lectura)
      </span>
      <form action={stopImpersonationAction}>
        <button type="submit">Salir →</button>
      </form>
    </div>
  );
}
