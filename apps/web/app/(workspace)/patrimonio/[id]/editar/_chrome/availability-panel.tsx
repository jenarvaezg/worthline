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

import { proposeLadderFromLedger, suggestedLotAvailableFrom } from "@web/intake";
import type { FichaContext } from "@web/patrimonio/[id]/editar/_families/family-contract";
import { AvailabilitySection } from "@web/patrimonio/[id]/editar/_surfaces/availability-section";
import { ContributionLotsSection } from "@web/patrimonio/[id]/editar/_surfaces/contribution-lots-section";
import type { ManualAsset } from "@worthline/domain";
import { formatMoneyMinorPrivacy, readLedgerSeniority } from "@worthline/domain";
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

  const { currentUrl, formError, id, privacyMode, store, today } = ficha;
  const availableFrom = await store.assets.readAvailableFrom(id);
  const lots = await store.assets.readContributionLots(id);

  // La antigüedad heredada que #1518 declaró, si la hay: de ella sale la fecha que la
  // ficha SUGIERE para un lote nuevo. Con varias movilizaciones se toma la más
  // RECIENTE, que es la que libera más tarde: una sugerencia se confirma de un vistazo,
  // así que equivocarse tiene que caer del lado que no promete liquidez antes de
  // tiempo. Es la misma dirección conservadora que ADR 0100 fija para el reparto.
  //
  // Nunca de `executed_at`: esa es la fecha del trámite, y leerla como antigüedad
  // diría «bloqueado hasta 2035» sobre dinero rescatable hoy (#1490, #1518).
  const operations = await store.operations.readOperations(id);
  // La escalera que el libro sabe proponer (#1687). Null cuando no tiene ni un tramo
  // que ofrecer ni un hueco que nombrar: un botón que no puede cumplir es peor que no
  // estar, y una frase sobre capital sin fechar que no viene a cuento es ruido.
  const proposal = proposeLadderFromLedger(readLedgerSeniority(operations));
  const proposed =
    proposal.lots.length === 0 && proposal.gaps.length === 0 ? null : proposal;
  const seniorityAt = operations
    .map((operation) => operation.transferSeniorityAt)
    .filter((date): date is string => typeof date === "string")
    .sort()
    .at(-1);

  return (
    <>
      <AvailabilitySection
        assetId={asset.id}
        availableFrom={availableFrom}
        currentUrl={currentUrl}
        formError={formError}
        supersededByLots={lots.length > 0}
        today={today}
      />
      <ContributionLotsSection
        assetId={asset.id}
        currentUrl={currentUrl}
        formatMoney={(amountMinor) =>
          formatMoneyMinorPrivacy(
            { amountMinor, currency: asset.currentValue.currency },
            privacyMode,
          )
        }
        formError={formError}
        holdingMinor={asset.currentValue.amountMinor}
        lots={lots}
        proposed={proposed}
        suggestedAvailableFrom={suggestedLotAvailableFrom(seniorityAt ?? null)}
        today={today}
      />
    </>
  );
}
