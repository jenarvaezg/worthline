import type { ScopeOption } from "@worthline/domain";
import Link from "next/link";

import { setScopeAction } from "./actions/scope";

/**
 * App shell — the topnav, scope bar, warnings rail, and persistence footer
 * that every page renders through. Each page instantiates this directly
 * (not via a layout) so it can pass the active section as a prop.
 *
 * Zero client JS: scope switching is a POST that sets a cookie via server
 * action, then redirects back; active-link state is a prop, not router state.
 */

export type AppSection = "resumen" | "patrimonio" | "inversiones" | "historico" | "ajustes";

const NAV_SECTIONS: Array<{ id: AppSection; label: string; href: string }> = [
  { id: "resumen", label: "Resumen", href: "/" },
  { id: "patrimonio", label: "Activos y deudas", href: "/patrimonio" },
  { id: "inversiones", label: "Inversiones", href: "/inversiones" },
  { id: "historico", label: "Histórico", href: "/historico" },
  { id: "ajustes", label: "Ajustes", href: "/ajustes" },
];

export interface Warning {
  entityId: string;
  message: string;
  code: string;
}

export interface PersistenceInfo {
  displayPath: string;
  checkedAt: string;
}

export interface ShellProps {
  /** Which top-level section is currently active. */
  activeSection: AppSection;
  /** Available scope options — hidden entirely for single-member workspaces. */
  scopes: ScopeOption[];
  /** Currently selected scope ID — used to highlight the active scope tab. */
  selectedScopeId: string | undefined;
  /** Warnings to display in the rail. */
  warnings: Warning[];
  /** Persistence info shown in the footer. */
  persistence: PersistenceInfo;
  /** The URL of the current page, forwarded to the scope POST action. */
  currentPageUrl: string;
  /** Content rendered inside the shell layout. */
  children: React.ReactNode;
}

export default function Shell({
  activeSection,
  scopes,
  selectedScopeId,
  warnings,
  persistence,
  currentPageUrl,
  children,
}: ShellProps) {
  const savedAt = new Date(persistence.checkedAt).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <main className="workspace">
      {/* ── Topnav ─────────────────────────────────────────────────── */}
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
        <nav className="topNav" aria-label="Secciones principales">
          {NAV_SECTIONS.map((section) => (
            <Link
              className={section.id === activeSection ? "active" : undefined}
              href={section.href}
              key={section.id}
            >
              {section.label}
            </Link>
          ))}
        </nav>
      </header>

      {/* ── Scope bar (hidden for single-member workspaces) ─────────── */}
      {scopes.length > 1 ? (
        <div className="tabsBar" aria-label="Selector de scope">
          <nav className="scopeTabs">
            {scopes.map((scope) => (
              <form action={setScopeAction} key={scope.id}>
                <input name="returnTo" type="hidden" value={currentPageUrl} />
                <input name="scopeId" type="hidden" value={scope.id} />
                <button
                  className={`scopeTabBtn${scope.id === selectedScopeId ? " active" : ""}`}
                  type="submit"
                >
                  {scope.label}
                </button>
              </form>
            ))}
          </nav>
        </div>
      ) : null}

      {/* ── Warnings rail ───────────────────────────────────────────── */}
      {warnings.length > 0 ? (
        <div className="warningBand" role="alert" aria-label="Avisos">
          <span className="warningCount">
            {warnings.length} {warnings.length === 1 ? "aviso" : "avisos"}
          </span>
          {warnings.map((w) => (
            <div className="warningItem" key={`${w.entityId}-${w.code}`}>
              <span>⚠ {w.message}</span>
              <a href={`/patrimonio#${w.entityId}`} className="warningLink">
                Ver holding
              </a>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── Page content ────────────────────────────────────────────── */}
      {children}

      {/* ── Persistence footer ──────────────────────────────────────── */}
      <footer className="persistenceBar">
        <span>{persistence.displayPath}</span>
        <span>guardado · {savedAt}</span>
      </footer>
    </main>
  );
}
