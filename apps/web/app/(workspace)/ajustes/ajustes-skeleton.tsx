/**
 * Loading skeleton for the /ajustes body (#1229). Prefetched as the route shell
 * under Partial Prefetching so soft tab navigations paint chrome + this frame
 * immediately. No session data — stable dimensions match the real bands.
 */
export default function AjustesSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando ajustes" className="section">
      <section className="section">
        <div className="panelHeader">
          <h2>Ajustes</h2>
          <span className="skeletonText skeletonShort" />
        </div>
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
      </section>
    </div>
  );
}
