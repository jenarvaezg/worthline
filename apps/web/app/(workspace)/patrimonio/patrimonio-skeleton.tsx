/**
 * Full-body loading skeleton for /patrimonio (#1229). Soft navigations must
 * paint chrome + this shell immediately; the CRUD board and analytics stream
 * in together so Instant Insights stays clean. No session data here.
 *
 * Root is a `status` region so the name reaches assistive tech at all — ARIA
 * maps no author name onto `generic`, a bare div's implicit role (#1275).
 */
export default function PatrimonioSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando patrimonio" role="status">
      <section className="patrimonioHeader" aria-hidden="true">
        <div className="panelHeader">
          <h2>Patrimonio</h2>
          <span className="skeletonText skeletonShort" />
        </div>
        <div className="patrimonioActions">
          <span className="skeletonChip" />
          <span className="skeletonChip" />
        </div>
      </section>

      <section className="section">
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
      </section>

      <section className="section">
        <div className="panelHeader">
          <h2>Exposición</h2>
        </div>
        <div className="skeletonDonut" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
      </section>
    </div>
  );
}
