import { withStore } from "@worthline/db";
import { redirect } from "next/navigation";

import { parseWorkspaceInit } from "../intake";

export const dynamic = "force-dynamic";

/**
 * Thin first-run route: creates the workspace, then lands back on `/`.
 * Issue #55 will rework this page properly; this is a minimal shell for
 * the no-workspace redirect from `page.tsx` (issue #53).
 */
export default function EmpezarPage() {
  // If a workspace already exists, send the user back to the dashboard.
  const workspace = withStore((store) => store.readWorkspace());

  if (workspace) {
    redirect("/");
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1>worthline</h1>
            <p>Patrimonio neto local</p>
          </div>
        </div>
      </header>

      <section className="setupPanel" aria-label="Crear workspace">
        <div className="panelHeader">
          <h2>Crear workspace local</h2>
          <span>EUR por defecto</span>
        </div>
        <p className="onboardingHint">
          Todo se guarda solo en este dispositivo (SQLite local): sin nube, sin cuenta.
          «Hogar» habilita varios miembros con porcentajes de propiedad compartidos.
        </p>
        <form action={initializeWorkspaceAction} className="stackForm">
          <label>
            Modo
            <select name="mode" defaultValue="individual">
              <option value="individual">Individual</option>
              <option value="household">Hogar</option>
            </select>
          </label>
          <label>
            Miembros (un nombre por línea)
            <textarea name="memberNames" defaultValue="Yo" rows={4} spellCheck={false} />
          </label>
          <button type="submit">Crear workspace</button>
        </form>
      </section>
    </main>
  );
}

async function initializeWorkspaceAction(formData: FormData): Promise<never> {
  "use server";

  const command = parseWorkspaceInit(formData);

  withStore((store) => store.initializeWorkspace(command));
  redirect("/");
}
