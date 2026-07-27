/**
 * Loading skeleton for the /objetivos body (#1229). Prefetched as the route
 * shell under Partial Prefetching so soft tab navigations paint chrome + this
 * frame immediately. No session data — stable dimensions match the real bands.
 */
export default function ObjetivosSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando objetivos" className="section">
      <section className="firePanel">
        <div className="panelHeader">
          <h2>FIRE</h2>
          <span className="skeletonText skeletonShort" />
        </div>
        <div className="skeletonFire" />
      </section>

      <section className="objetivosGoalsPanel section">
        <div className="panelHeader">
          <h2>Objetivos</h2>
          <span className="skeletonText skeletonShort" />
        </div>
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
      </section>
    </div>
  );
}
