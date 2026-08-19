/**
 * Loading skeleton for the /objetivos body (#1229). Prefetched as the route
 * shell under Partial Prefetching so soft tab navigations paint chrome + this
 * frame immediately. No session data — stable dimensions match the real bands.
 *
 * Root is a `status` region so the name reaches assistive tech at all — ARIA
 * maps no author name onto `generic`, a bare div's implicit role (#1275).
 */
export default function ObjetivosSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando objetivos"
      className="section"
      role="status"
    >
      {/* Dos columnas como el cockpit real (#1450): un esqueleto de una sola
          columna movería las cifras de sitio al llegar los datos. */}
      <div className="objetivosCockpit">
        <section className="firePanel">
          <div className="panelHeader">
            <h3>Tus supuestos</h3>
            <span className="skeletonText skeletonShort" />
          </div>
          <div className="skeletonTier" />
          <div className="skeletonTier" />
          <div className="skeletonTier" />
        </section>

        <section className="firePanel">
          <div className="panelHeader">
            <h3>FIRE</h3>
            <span className="skeletonText skeletonShort" />
          </div>
          <div className="skeletonFire" />
        </section>
      </div>

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
