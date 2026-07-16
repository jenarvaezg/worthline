import { guardAdmin } from "@web/admin/guard-admin";
import { readExposureCatalogFromControlPlane } from "@web/read-exposure-catalog";

import { parseCatalogParams } from "./catalog-triage";
import CatalogWorkbench from "./catalog-workbench";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/**
 * The /admin catalog surface (PRD #711 S4, decision #941, ADR 0058): the global
 * exposure-profile catalog, curated manually by the admin, read-only for every
 * workspace. Paper surface behind `guardAdmin` — a non-admin request 404s before
 * the read runs, byte-identical to an unknown URL.
 *
 * The reference catalog degrades with a typed 3-state availability (#943): when
 * it is unavailable the CRUD fails explicitly here (never a blank table posing
 * as an empty catalog), while the rest of /admin keeps working on its own reads.
 */
export default async function AdminCatalogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await guardAdmin();
  const params = await searchParams;
  const availability = await readExposureCatalogFromControlPlane();

  const initialState = parseCatalogParams({
    filtro: first(params.filtro),
    q: first(params.q),
    perfil: first(params.perfil),
  });

  return (
    <main className="demoLanding catalogAdmin">
      <header className="demoLandingHead">
        <p className="demoKicker">worthline · admin · catálogo</p>
        <h1>Catálogo de exposición</h1>
        <p className="demoLede">
          Perfiles canónicos de identidad (geografía, divisa, clase de activo, TER e
          índice), compartidos por todos los workspaces y curados aquí a mano.{" "}
          <a href="/admin">← Usuarios</a>
        </p>
      </header>

      {availability.status === "unavailable" ? (
        <section className="section catalogUnavailable">
          <h2>Catálogo no disponible</h2>
          {availability.reason === "not_configured" ? (
            <p className="catalogUnavailableMsg">
              Este entorno no tiene control plane configurado (
              <code>WORTHLINE_CONTROL_PLANE_DB_URL</code>). No es un catálogo vacío: no
              hay dónde curar perfiles aquí. Para editarlos, apunta a un control plane con
              sesión de administrador.
            </p>
          ) : (
            <p className="catalogUnavailableMsg">
              No se pudo leer el catálogo del control plane. Vuelve a intentarlo; el resto
              de <a href="/admin">/admin</a> no se ve afectado.
            </p>
          )}
        </section>
      ) : (
        <CatalogWorkbench
          initialProfiles={[...availability.profiles]}
          initialState={initialState}
        />
      )}
    </main>
  );
}
