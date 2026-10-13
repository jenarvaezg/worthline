import FeedbackMount from "@web/feedback/feedback-mount";
import NavStrip from "@web/nav-strip";
import SectionNav from "@web/section-nav";
import SectionNavFallback from "@web/section-nav-fallback";
import SignOutButton from "@web/sign-out-button";
import WorkspaceFooter from "@web/workspace-footer";
import WorkspaceLegalFooter from "@web/workspace-legal-footer";
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
 * The pieces that DO read the request — the scope bar, the feedback button, the
 * sign-out control, and the footer's persistence values — each live in their own
 * `<Suspense>` so they stream in without blocking the frame.
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
        {/* The scrolling strip fades the edge that hides something (#1723). */}
        <NavStrip>
          {/* usePathname() in SectionNav would otherwise blank the whole topnav
              until hydrate. Fallback paints the same five links without the
              active-tab marker (#1229). */}
          <Suspense fallback={<SectionNavFallback />}>
            <SectionNav />
          </Suspense>
          <Suspense fallback={null}>
            <SignOutButton />
          </Suspense>
        </NavStrip>
        {/* «Enviar feedback» (#1174): its own grid cell, outside the scrolling
            strip, so on a phone it shares the brand's row instead of hiding at
            the strip's end. It reads the session to decide whether to show, so
            it streams in like the sign-out control. */}
        <Suspense fallback={null}>
          <FeedbackMount />
        </Suspense>
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

      {/* ── Franja legal (#1172): fuera del Suspense, porque la LSSI la quiere
             permanente y no puede esperar a una lectura de persistencia. ── */}
      <WorkspaceLegalFooter />
    </main>
  );
}
