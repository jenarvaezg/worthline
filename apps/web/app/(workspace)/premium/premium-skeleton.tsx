/**
 * Loading skeleton for the /premium body (#1229). Static copy is the shell; the
 * entitlement/checkout state streams in. No session data in the fallback.
 */
export default function PremiumSkeleton() {
  return (
    <section aria-busy="true" aria-label="Cargando premium" className="section">
      <div className="panelHeader">
        <h2>Premium</h2>
        <span className="skeletonText skeletonShort" />
      </div>
      <div className="skeletonTier" />
      <div className="skeletonTier" />
      <div className="skeletonTier" />
    </section>
  );
}
