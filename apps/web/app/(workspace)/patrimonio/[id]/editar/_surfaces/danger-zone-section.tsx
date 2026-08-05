/**
 * Danger zone — the two-step baja of a holding (#1365).
 *
 * The trash is a soft delete, and for a holding with nothing inside the copy that
 * has always been here is the whole truth: it moves to the Papelera and can be
 * recovered. For a holding whose position still holds units it is not — the value
 * leaves the patrimonio at the next capture and the histórico records no sale, no
 * traspaso, and no deposit into any account. That case gets the number it is about
 * to withdraw and the correct exit (record the sale first); the clean case is left
 * exactly as it was, same words, same number of steps. Friction goes only where
 * there is money inside.
 *
 * Extracted from the editar page while adding that branch: the zone is now a
 * decision, not a paragraph.
 */

import { deleteAssetAction, deleteLiabilityAction } from "@web/patrimonio/actions";
import type { HoldingTrashImpact } from "@worthline/domain";
import { formatMoneyMinorPrivacy, formatUnits } from "@worthline/domain";

import { RevealSectionLink } from "./reveal-section-link";

interface DangerZoneCommonProps {
  /** The holding's own public `wl_hld_…` URL, where the action returns (#1318). */
  currentUrl: string;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  holdingId: string;
  privacyMode?: boolean;
}

/**
 * Only an ASSET can carry a trash impact: units live in an operations ledger, and
 * a liability has none. Discriminated rather than a shared nullable field so the
 * notice's copy ("Este activo conserva…") can never render over a debt — the
 * combination is unrepresentable instead of merely unreachable.
 */
type DangerZoneSectionProps = DangerZoneCommonProps &
  (
    | {
        kind: "asset";
        /** What the trash would take with it, or null when it takes nothing. */
        trashImpact: HoldingTrashImpact | null;
      }
    | { kind: "liability"; trashImpact?: never }
  );

export function DangerZoneSection({
  currentUrl,
  holdingId,
  kind,
  privacyMode = false,
  trashImpact,
}: DangerZoneSectionProps) {
  const isAsset = kind === "asset";

  return (
    <div className="dangerZone">
      <h3>Zona de peligro</h3>
      <form action={isAsset ? deleteAssetAction : deleteLiabilityAction}>
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={holdingId} />
        <details suppressHydrationWarning className="confirmDelete">
          <summary>{isAsset ? "Eliminar activo" : "Eliminar deuda"}</summary>
          {trashImpact ? (
            <TrashImpactNotice
              currentUrl={currentUrl}
              impact={trashImpact}
              privacyMode={privacyMode}
            />
          ) : (
            <p>
              {isAsset
                ? "El activo se moverá a la Papelera y podrás recuperarlo."
                : "La deuda se moverá a la Papelera y podrás recuperarla."}
            </p>
          )}
          <button type="submit">Confirmar eliminación</button>
        </details>
      </form>
    </div>
  );
}

/**
 * The whole truth for a holding with units inside: what leaves, that nothing
 * records where it went, and the exit that does. The sale link reveals the
 * operations surface on this same ficha with no round-trip, falling back to
 * `?abrir=operaciones` (which the server renders unfolded) with no JS — a bare
 * `#operaciones` would scroll to a collapsed `<details>` and show nothing.
 */
function TrashImpactNotice({
  currentUrl,
  impact,
  privacyMode,
}: {
  currentUrl: string;
  impact: HoldingTrashImpact;
  privacyMode: boolean;
}) {
  const value = formatMoneyMinorPrivacy(impact.value, privacyMode);

  return (
    <div className="warningBand">
      <p>
        ⚠ Este activo conserva <strong>{formatUnits(impact.netUnits)} unidades</strong>,
        valoradas {impact.basis === "cost" ? "a coste " : ""}en <strong>{value}</strong>.
        Al moverlo a la Papelera ese valor sale de tu patrimonio en la próxima captura, y
        el histórico no registra a dónde fue: no hay venta, ni traspaso, ni ingreso en
        ninguna cuenta.
      </p>
      <p>
        Si ya lo vendiste, registra primero la venta y elimínalo después: así el histórico
        refleja que ese dinero se convirtió en liquidez.
      </p>
      <RevealSectionLink
        href={`${currentUrl}?abrir=operaciones#operaciones`}
        sectionId="operaciones"
      >
        Registrar la venta →
      </RevealSectionLink>
    </div>
  );
}
