/**
 * Generic form-route skeleton (#1229 Stream surfaces: /patrimonio/anadir,
 * /anadir/avanzado, /importar-extracto). Static form chrome is the shell; the
 * few dynamic bits (scopes, entitlement) stream in.
 */
export default function FormRouteSkeleton({ label }: { label: string }) {
  return (
    <section aria-busy="true" aria-label={label} className="section">
      <div className="panelHeader">
        <h2>
          <span className="skeletonText" />
        </h2>
        <span className="skeletonText skeletonShort" />
      </div>
      <div className="skeletonTier" />
      <div className="skeletonTier" />
      <div className="skeletonTier" />
      <div className="skeletonTier" />
    </section>
  );
}
