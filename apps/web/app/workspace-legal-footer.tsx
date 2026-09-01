import LegalLinks from "@web/legal/legal-links";

/**
 * La franja legal del pie del workspace (#1172).
 *
 * Vive aparte de `WorkspaceFooter` a propósito: ese pie lee el estado de
 * persistencia y por eso el layout lo monta dentro de un `<Suspense>`. Los
 * enlaces legales no pueden depender de que resuelva una lectura de datos —la
 * LSSI los quiere permanentes—, así que esta franja es síncrona, no lee nada y
 * el layout la renderiza en el marco.
 */
export default function WorkspaceLegalFooter() {
  return (
    <div className="legalBar coverSurface">
      <LegalLinks />
    </div>
  );
}
