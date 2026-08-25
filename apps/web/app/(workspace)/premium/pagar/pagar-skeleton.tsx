/**
 * El shell estático de la ruta de pago (#1221, #1229): se pinta al instante
 * mientras el servidor resuelve el plan — que puede costar una llamada al MoR
 * para abrir la transacción. Ningún dato de sesión en el fallback.
 */
export default function PagarSkeleton() {
  return (
    <section aria-busy="true" aria-label="Cargando pago" className="section">
      <div className="panelHeader">
        <h2>Pagar</h2>
      </div>
      <div className="skeletonTier" />
    </section>
  );
}
