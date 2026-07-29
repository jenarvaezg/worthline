/**
 * Loading skeleton for the /ajustes body (#1229). Prefetched as the route shell
 * under Partial Prefetching so soft tab navigations paint chrome + this frame
 * immediately. No session data — stable dimensions match the real bands.
 *
 * Root is a `status` region so the name reaches assistive tech at all — ARIA
 * maps no author name onto `generic`, a bare div's implicit role (#1275).
 */
export default function AjustesSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando ajustes" className="section" role="status">
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
