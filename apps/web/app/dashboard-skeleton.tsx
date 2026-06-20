/**
 * Loading skeleton for the dashboard body while the heavy data streams in.
 * Matches the grid structure of the real dashboard so the shell does not
 * reflow when content arrives.
 */
export default function DashboardSkeleton() {
  return (
    <div className="dashGrid" aria-busy="true" aria-label="Cargando panel de resumen">
      <section className="summaryBand heroPanel">
        <div className="resumenHeader">
          <div className="framingTabs">
            <span className="skeletonTab" />
            <span className="skeletonTab" />
          </div>
        </div>
        <div className="headline">
          <span className="skeletonText skeletonShort" />
          <strong className="skeletonFigure" />
        </div>
        <div className="deltaChips">
          <span className="skeletonChip" />
          <span className="skeletonChip" />
        </div>
        <div className="heroStats">
          <span className="skeletonStat" />
          <span className="skeletonStat" />
          <span className="skeletonStat" />
          <span className="skeletonStat" />
        </div>
      </section>

      <section className="liquidityPanel">
        <div className="panelHeader">
          <h2>Liquidez</h2>
        </div>
        <div className="skeletonDonut" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
        <div className="skeletonTier" />
      </section>

      <section className="historyPanel" id="composicion">
        <div className="panelHeader">
          <h2>Evolución</h2>
        </div>
        <div className="skeletonChart" />
      </section>

      <section className="firePanel">
        <div className="panelHeader">
          <h2>FIRE</h2>
        </div>
        <div className="skeletonFire" />
      </section>
    </div>
  );
}
