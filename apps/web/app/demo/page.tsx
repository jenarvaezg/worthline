import { isPersonaId, PERSONA_IDS, PERSONA_META } from "@web/demo/persona";
import { readStoreTarget } from "@web/read-store-target";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The /demo landing (PRD #297, ADR 0030): the public entry into the read-only
 * demo. It pitches the three personas and lets a logged-out visitor choose one.
 * Selecting a persona (or following a `/demo?persona=…` deep-link) routes
 * through `/demo/persona`, which sets the cookie, clears `wl_scope`, and lands
 * in the app. Zero client JS (ADR 0009): plain links.
 *
 * A signed-in user has their own workspace, so the persona picker is meaningless
 * for them — they are redirected home.
 */
export default async function DemoLanding({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((await readStoreTarget()).kind === "authenticated") {
    redirect("/app");
  }

  const resolved = await searchParams;
  const raw = Array.isArray(resolved?.persona) ? resolved?.persona[0] : resolved?.persona;
  if (isPersonaId(raw)) {
    // Deep-link: hand off to the cookie route, which sets it and enters the app.
    redirect(`/demo/persona?persona=${raw}`);
  }

  return (
    <main className="demoLanding">
      <header className="demoLandingHead">
        <p className="demoKicker">worthline · demo</p>
        <h1>Patrimonio neto, con datos de mentira</h1>
        <p className="demoLede">
          Esto es una demostración pública de solo lectura. Elige un perfil para explorar
          la app con una cartera ficticia pero coherente — nada de lo que ves es real y no
          puedes cambiar nada.
        </p>
      </header>

      <ul className="demoPersonaGrid">
        {PERSONA_IDS.map((id) => {
          const meta = PERSONA_META[id];
          return (
            <li key={id}>
              {/* POST to the persona route (mirrors /scope): sets the cookie,
                  clears wl_scope, redirects into the app. The route also serves a
                  GET deep-link (/demo/persona?persona=…) for shareable links. */}
              <form action="/demo/persona" className="demoPersonaCard" method="post">
                <input name="persona" type="hidden" value={id} />
                <h2>{meta.label}</h2>
                <p>{meta.pitch}</p>
                <button className="demoPersonaCta" type="submit">
                  Explorar como {meta.label} →
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
