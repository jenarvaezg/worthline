/**
 * Loading skeleton for the /historico body while the snapshot + breakdown reads
 * stream in (#1195). Rendered as the page's Suspense fallback so the shared
 * chrome (#1190) + this skeleton paint immediately on navigation, instead of the
 * tab freezing on the previous view. Reuses the real `historicoPanel section`
 * container (same max-width + centering) and band heights so the loaded table
 * replaces it without layout shift (CLS ~0).
 *
 * No session data lives here — it is the stable per-route shell Instant
 * Navigations will prefetch (#1229).
 *
 * `status`, like the other four workspace-tab skeletons (#1275): a named
 * <section> is a `region` landmark, which is the wrong shape for a frame that
 * exists for a few hundred milliseconds. Its name did reach assistive tech
 * (unlike the roleless ones), so this half is consistency, not a bug fix. The
 * sub-route skeletons (premium, the form routes, patrimonio analytics) keep
 * `region` — they are page sections, not whole-tab shells.
 */
export default function HistoricoSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Cargando histórico"
      className="historicoPanel section"
      role="status"
    >
      <div className="panelHeader">
        <h2>Histórico</h2>
        <span className="skeletonText skeletonShort" />
      </div>

      <div className="skeletonChart" />

      <div className="skeletonTier" />
      <div className="skeletonTier" />
      <div className="skeletonTier" />
      <div className="skeletonTier" />
      <div className="skeletonTier" />
    </section>
  );
}
