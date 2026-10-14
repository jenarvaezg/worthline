import { viewsSharedWorkspace } from "@web/demo/write-guard";
import FeedbackMount from "@web/feedback/feedback-mount";
import ImportWorkspaceForm from "@web/import-workspace-form";
import { parseFormError } from "@web/intake";
import LegalLinks from "@web/legal/legal-links";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";
import { readWorkspacesSharedWithSession } from "@web/viewing/shared-with-session";
import SharedWithYou from "@web/viewing/shared-with-you";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { initHogarAction, initSoloAction } from "./actions";

/**
 * Block (#1229): this route opts out of Instant Navigations validation.
 * Soft-click shell prefetching is not the goal here — see the route table on
 * issue #1229 for the why.
 */
export const instant = false;

interface EmpezarSearchParams {
  path?: string;
  error?: string;
  form?: string;
  v_name?: string;
  v_memberNames?: string;
}

interface EmpezarPageProps {
  searchParams: Promise<EmpezarSearchParams>;
}

/**
 * /empezar — workspace creation route.
 *
 * Three explicit paths:
 *   «Empezar solo»  — single name field (individual mode)
 *   «Crear hogar»   — one-name-per-line textarea (household mode)
 *   «Importar»      — restore a backup or externally-prepared file (#105),
 *                     reusing the shared import flow. No data-loss warning
 *                     here: there is no workspace yet, nothing to lose.
 *
 * Replaces the conditional panel swap on / from the prior placeholder.
 * Uses the intake v2 pattern: formId + v_* params to preserve typed values
 * on validation error so nothing the user typed is silently lost.
 */
export default async function EmpezarPage({ searchParams }: EmpezarPageProps) {
  // Esta ruta abre el store SIN pasar por `resolvePageShell`, que es donde el resto
  // de la app declara su lectura como dato de petición (`bootstrapHealthcheck`,
  // `store.ts`). Y abrirlo puede disparar las re-ondas post-migración, que leen el
  // reloj: bajo Cache Components (#1229) un `new Date()` en prerender es un error
  // (`blocking-prerender-current-time`) que llega a la consola del navegador y
  // tumba las jornadas 18 y 19. `connection()` dice lo que ya es cierto — si hay
  // workspace o no es exactamente lo que cambia entre una petición y la siguiente.
  //
  // Va AQUÍ y no en la costura del store (`requirePrincipal`), aunque el comentario
  // de `bootstrapHealthcheck` invite a ello: declararlo en toda apertura de store
  // saca también a las rutas de workspace del shell prerenderizado. Probado — les
  // costó su presupuesto de streaming a las jornadas 37 y 54, que pasaron a fallar.
  await connection();
  const workspace = await withStore((store) => store.workspace.readWorkspace());

  if (workspace) {
    redirect("/app");
  }

  // A viewer whose shared workspace is still empty lands here from `/app`
  // (#1843, ADR 0112). Creating it is the owner's, so a static notice and the way
  // back replace the form — sending it back to `/app` would loop.
  if (viewsSharedWorkspace(await readStoreTarget())) {
    return <EmptySharedWorkspace />;
  }

  // Someone who was only invited lands here too: their own workspace is
  // provisioned empty on the first sign-in, so `/app` sends them to create it.
  // The way into what was shared with them is offered beside that (#1844).
  const sharedWithMe = await readWorkspacesSharedWithSession();

  const params = await searchParams;
  const activePath = params.path === "hogar" ? "hogar" : "solo";
  const errorCtx = parseFormError(params as Record<string, string | undefined>);

  const soloError = errorCtx?.formId === "solo" ? errorCtx.message : null;
  const hogarError = errorCtx?.formId === "hogar" ? errorCtx.message : null;
  const importError = errorCtx?.formId === "import" ? errorCtx.message : null;
  const preservedName = errorCtx?.values?.["name"] ?? "";
  const preservedMemberNames = errorCtx?.values?.["memberNames"] ?? "";

  return (
    <main className="workspace empezarPage">
      {/* Masthead híbrido (#829/#909): banda de cubierta sobre cuerpo de
          papel — el login es la cubierta; /empezar, la primera página. */}
      <header className="coverSurface coverMasthead empezarMasthead coverActionBar">
        <div>
          <p className="empezarEyebrow">Patrimonio neto local</p>
          <h1>worthline</h1>
        </div>
        <Suspense fallback={null}>
          <FeedbackMount />
        </Suspense>
      </header>

      <SharedWithYou className="empezarSection" workspaces={sharedWithMe} />

      <section className="empezarSection" aria-label="Crear workspace">
        <div className="empezarHeader">
          <h2>Empezar</h2>
          <p className="empezarTrust">
            Todo se guarda en este dispositivo (SQLite), sin nube ni cuenta.
          </p>
        </div>

        <div className="empezarPaths">
          {/* ── Solo path ──────────────────────────────────────────── */}
          <div
            className={`empezarCard${activePath === "solo" ? " active" : ""}`}
            id="solo"
          >
            <h3>Empezar solo</h3>
            <p className="empezarCardDesc">
              Un único miembro. Seguimiento individual de patrimonio.
            </p>

            {soloError ? (
              <p className="formError" role="alert">
                {soloError}
              </p>
            ) : null}

            <form action={initSoloAction} className="stackForm">
              <label>
                Tu nombre
                <input
                  name="name"
                  type="text"
                  defaultValue={preservedName}
                  placeholder="p. ej. Ana"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
              <button type="submit">Empezar solo</button>
            </form>
          </div>

          {/* ── Hogar path ─────────────────────────────────────────── */}
          <div
            className={`empezarCard${activePath === "hogar" ? " active" : ""}`}
            id="hogar"
          >
            <h3>Crear hogar</h3>
            <p className="empezarCardDesc">
              Varios miembros con porcentajes de propiedad compartidos.
            </p>

            {hogarError ? (
              <p className="formError" role="alert">
                {hogarError}
              </p>
            ) : null}

            <form action={initHogarAction} className="stackForm">
              <label>
                Miembros (un nombre por línea)
                <textarea
                  name="memberNames"
                  defaultValue={preservedMemberNames || "Ana\nJose"}
                  rows={4}
                  spellCheck={false}
                />
              </label>
              <button type="submit">Crear hogar</button>
            </form>
          </div>
        </div>
      </section>

      {/* ── Import path (#105) ─────────────────────────────────────── */}
      <section className="empezarSection" aria-label="Importar una copia">
        <div className="empezarHeader">
          <h2>¿Ya tienes una copia de worthline?</h2>
          <p className="empezarTrust">
            Restaura una copia exportada desde la app o un archivo preparado externamente:
            su contenido se convierte en tu workspace.
          </p>
        </div>

        {importError ? (
          <p className="formError" role="alert">
            {importError}
          </p>
        ) : null}

        <ImportWorkspaceForm currentUrl="/empezar" showDataLossWarning={false} />
      </section>

      {/* El onboarding tiene shell propia: sin esto se quedaría sin pie legal (#1172). */}
      <div className="legalBar coverSurface">
        <LegalLinks />
      </div>
    </main>
  );
}

/** What a viewer sees of a shared workspace nobody has created yet (#1843). */
function EmptySharedWorkspace() {
  return (
    <main className="workspace empezarPage">
      <header className="coverSurface coverMasthead empezarMasthead">
        <div>
          <p className="empezarEyebrow">Acceso de solo lectura</p>
          <h1>worthline</h1>
        </div>
      </header>

      <section className="empezarSection" aria-label="Espacio compartido vacío">
        <div className="empezarHeader">
          <h2>Este espacio todavía está vacío</h2>
          <p className="empezarTrust">
            Quien te lo ha compartido aún no ha empezado a usarlo. Cuando lo haga, verás
            aquí sus cifras.
          </p>
        </div>
        <form action="/viewing/exit" method="post">
          <button type="submit">Volver a mi espacio</button>
        </form>
      </section>

      <div className="legalBar coverSurface">
        <LegalLinks />
      </div>
    </main>
  );
}
