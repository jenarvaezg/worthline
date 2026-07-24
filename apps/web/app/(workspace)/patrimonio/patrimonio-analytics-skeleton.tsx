/**
 * Loading skeleton for the /patrimonio analytics sub-sections — Exposición and
 * Rentabilidad por clase — while the exposure-profile catalog read and its
 * derivation stream in (#1195). Rendered as the Suspense fallback around
 * `PatrimonioAnalytics`, so the CRUD board (synchronous) paints immediately and
 * this shell fills the space below it without layout shift. Reuses the real
 * `exposureSection section` / `returnsByClassSection section` containers and
 * `panelHeader` so the loaded sections replace it in place.
 *
 * No session data lives here — it is the stable per-route shell Instant
 * Navigations will prefetch (#1229).
 */
export default function PatrimonioAnalyticsSkeleton() {
  return (
    <section aria-busy="true" aria-label="Cargando exposición y rentabilidad por clase">
      <div className="exposureSection section">
        <div className="panelHeader">
          <h2>Exposición</h2>
          <span className="skeletonText skeletonShort" />
        </div>
        <div className="skeletonDonut" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
      </div>

      <div className="returnsByClassSection section">
        <div className="panelHeader">
          <h2>Rentabilidad por clase</h2>
          <span className="skeletonText skeletonShort" />
        </div>
        <div className="skeletonChart" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
      </div>
    </section>
  );
}
