import SectionNav from "@web/section-nav";
import SignOutButton from "@web/sign-out-button";
import WorkspaceFooter from "@web/workspace-footer";
import WorkspaceScopeBar from "@web/workspace-scope-bar";
import { Suspense } from "react";

/**
 * Workspace chrome (#1190) — the topnav, scope bar, and persistence footer that
 * every workspace page renders through. Lifted out of each page's `Shell` into
 * this shared route-group layout so the chrome stays mounted across tab
 * navigation (Resumen/Patrimonio/Histórico/Objetivos/Ajustes): only the body
 * below re-renders, scroll/focus state survives, and the active tab is derived
 * from the URL by `SectionNav` instead of a per-page prop.
 *
 * The frame (masthead, structure, footer shell) resolves synchronously and does
 * NOT read session/workspace data — that keeps this shell reusable per route
 * (the prerequisite for per-tab streaming #1195 and Instant Navigations #1229).
 * The pieces that DO read the request — the scope bar, the sign-out control, and
 * the footer's persistence values — each live in their own `<Suspense>` so they
 * stream in without blocking the frame.
 */
export default function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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
        <div className="topbarEnd">
          <SectionNav />
          <Suspense fallback={null}>
            <SignOutButton />
          </Suspense>
        </div>
      </header>

      {/* ── Scope bar (hidden for single-member workspaces) ─────────── */}
      <Suspense fallback={null}>
        <WorkspaceScopeBar />
      </Suspense>

      {/* ── Page content ────────────────────────────────────────────── */}
      {children}

      {/* ── Persistence footer — franja de remate en cubierta (#909) ── */}
      <Suspense fallback={null}>
        <WorkspaceFooter />
      </Suspense>
    </main>
  );
}
