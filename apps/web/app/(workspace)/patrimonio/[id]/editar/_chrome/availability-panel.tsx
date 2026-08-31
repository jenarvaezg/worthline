/**
 * El panel de disponibilidad — la superficie que va con el ESCALÓN y no con la
 * familia (#1528, ADR 0100).
 *
 * «Desde cuándo puedo tocarlo» no es una pregunta sobre cómo se valora un holding:
 * un plan de pensiones, un depósito a plazo y un fondo con ventana de rescate se
 * valoran de tres formas distintas y comparten esta pregunta entera. Así que no
 * pertenece a ninguna familia de la ficha (ADR 0095) — pertenece al peldaño
 * `term-locked`, el único que ADR 0013 define con un plazo.
 *
 * De ahí que sea chrome y no una sección de familia, y de ahí que la decisión de
 * mostrarlo viva AQUÍ: el panel devuelve `null` para cualquier otro escalón, y la
 * página se limita a colocar lo que reciba. Un booleano más en el page es
 * exactamente lo que #1607 vino a quitar.
 */

import type { FichaContext } from "@web/patrimonio/[id]/editar/_families/family-contract";
import { AvailabilitySection } from "@web/patrimonio/[id]/editar/_surfaces/availability-section";
import type { ManualAsset } from "@worthline/domain";
import type { ReactNode } from "react";

export async function loadAvailabilityPanel(
  ficha: FichaContext,
  asset: ManualAsset | null,
): Promise<ReactNode> {
  // Una deuda no se «toca» y un activo de otro escalón no declara plazo. La fecha de
  // un holding que cambió de peldaño queda inerte, igual que en el motor: se deja de
  // leer, no se borra, para que volver al escalón la recupere tal cual la declaró.
  if (asset === null || asset.liquidityTier !== "term-locked") {
    return null;
  }

  const { currentUrl, formError, id, store, today } = ficha;
  const availableFrom = await store.assets.readAvailableFrom(id);

  return (
    <AvailabilitySection
      assetId={asset.id}
      availableFrom={availableFrom}
      currentUrl={currentUrl}
      formError={formError}
      today={today}
    />
  );
}
