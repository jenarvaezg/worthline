import { withStore } from "@worthline/db";
import { redirect } from "next/navigation";

import ImportWorkspaceForm from "../import-workspace-form";
import { parseFormError } from "../intake";
import { initHogarAction, initSoloAction } from "./actions";

export const dynamic = "force-dynamic";

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
  const workspace = withStore((store) => store.readWorkspace());

  if (workspace) {
    redirect("/");
  }

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
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1 className="brandName">worthline</h1>
            <p>Patrimonio neto local</p>
          </div>
        </div>
      </header>

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
            <p className="empezarCardDesc">Un único miembro. Seguimiento individual de patrimonio.</p>

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
            Restaura una copia exportada desde la app o un archivo preparado
            externamente: su contenido se convierte en tu workspace.
          </p>
        </div>

        {importError ? (
          <p className="formError" role="alert">
            {importError}
          </p>
        ) : null}

        <ImportWorkspaceForm currentUrl="/empezar" showDataLossWarning={false} />
      </section>
    </main>
  );
}
