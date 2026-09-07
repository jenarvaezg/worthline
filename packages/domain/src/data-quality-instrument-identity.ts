/**
 * The orphan investment: priced, valued, on screen — and unidentifiable (#1489),
 * plus the identifier that IS there and names nothing (#1745).
 */

import { instrumentOfAsset } from "./classification";
import {
  type DataQualityCollector,
  type DataQualitySignal,
  signalLabelWithOverride,
  signalNaturalKey,
} from "./data-quality-collector";
import type { DecimalString } from "./decimal";
import { INVESTMENT_PROFILE_INSTRUMENTS } from "./exposure-identity";
import { valuationMethodOfAsset } from "./holding-method";
import {
  SECURITY_ID_KIND_LABEL_INLINE,
  securityIdFieldForInstrument,
} from "./security-id";
import { isClosedPosition } from "./warnings";
import type { ManualAsset } from "./workspace-types";

/**
 * Machine code for an investment priced by a provider symbol that carries NO
 * security id (#1489) — the orphan state, detectable in one query.
 *
 * The system's instrument identity is the typed pair (ISIN or DGS code, #1667), so a
 * symbol-only holding is not merely missing a label: a broker statement routing by
 * identifier (ADR 0055) cannot land on it, the exposure catalog cannot hand it its
 * profile, and nothing in the product can decide that `IE00B52MJY50` and `SXR1.DE`
 * are the same ETF — which is how the assistant came to tell a real user his
 * statement held a DIFFERENT product from his own position.
 *
 * The code still SAYS "ISIN" while the signal asks each instrument for the
 * identifier it can actually have (#1745). It is kept verbatim on purpose: the code
 * is the persisted key of a user's «marcado como intencional» override
 * (`{code, entityId}`, ADR 0004), so renaming it would silently un-acknowledge every
 * holding somebody already settled. What the user READS is the per-instrument copy
 * below; what the store keys by never moves.
 */
export const MISSING_INVESTMENT_ISIN_CODE = "MISSING_INVESTMENT_ISIN";

/**
 * Machine code for a holding whose stored identifier no classifier could name
 * (#1745): the `kind: null` half of the pair (#1743).
 *
 * Such a row can only be born in the workspace-document import (#1416), which
 * preserves verbatim and never derives — every interactive write validates by kind.
 * The value is therefore real data somebody typed once, and the repair is a reading,
 * not a deletion: what the look-through needs is a kind, so until one is declared
 * the holding keys by its provider symbol and inherits no catalog profile.
 *
 * The repair surface is the ficha, and typing the right ISIN there works today.
 * What does NOT hold yet is saving the ficha WITHOUT touching the field: that
 * silently drops the preserved value (#1770). Until it lands, this signal can lose
 * the very pointer it is asking the user to read.
 */
export const UNCLASSIFIED_SECURITY_ID_CODE = "UNCLASSIFIED_SECURITY_ID";

export interface DataQualityInstrumentIdentityInput {
  assets: readonly ManualAsset[];
  netUnitsByAssetId: ReadonlyMap<string, DecimalString>;
}

/**
 * `low` on purpose, and the exception that proves it: nothing on screen is wrong. The
 * price arrives through the provider symbol, so today's figure is as good as any
 * other holding's. What is missing only bites LATER — the next statement that will not
 * route, the exposure profile that will not be inherited, the assistant that cannot
 * tell the same product from a different one. A `medium` here would rank a latent gap
 * above a stale price that is wrong right now.
 *
 * {@link MISSING_INVESTMENT_ISIN_CODE} is overrideable (ADR 0004): a product genuinely
 * without an identifier exists — the user marks it intentional once and the signal
 * stops nagging, without leaving the inventory. {@link UNCLASSIFIED_SECURITY_ID_CODE}
 * is NOT: it names a value that is already stored and merely unread, so there is
 * always a repair (declare its kind on the ficha, or clear it) and nothing to
 * acknowledge as permanent.
 *
 * Closed positions are silent for the reason they are silent everywhere else (#1348):
 * a sold-out position no longer receives statements.
 *
 * Both file under `missing_configuration`, not a family of their own: what is absent
 * is a field on the ficha, and the surface that repairs it is the ficha.
 */
export const collectInstrumentIdentitySignals: DataQualityCollector<
  DataQualityInstrumentIdentityInput
> = (input) => {
  const signals: DataQualitySignal[] = [];

  for (const asset of input.assets) {
    if (
      !input.ownedAssetIds.has(asset.id) ||
      !isInstrumentIdentityCandidate(asset) ||
      isClosedPosition(asset, input.netUnitsByAssetId)
    ) {
      continue;
    }

    // The instrument decides WHICH identifier is asked for (decision 9 del mapa,
    // #1742): a pension plan can only ever have a DGS code, a fund/ETF/stock an
    // ISIN. Asking a plan for an ISIN was the impossible task of #1489.
    // Totalidad, no rama viva: la puerta de arriba ya dejó pasar solo la familia
    // que TIENE identificador, y es la misma que este mapa cubre. Si las dos listas
    // se separaran alguna vez, aquí se calla en vez de inventar una etiqueta.
    const field = securityIdFieldForInstrument(instrumentOfAsset(asset));
    if (!field) {
      continue;
    }
    const identifier = SECURITY_ID_KIND_LABEL_INLINE[field.kind];

    // Tres estados, y el tercero es silencio: sin par no hay identificador; un par
    // con la clase a null es un identificador que nadie supo leer; un par tipado es
    // identidad y no dice nada.
    //
    // Queda un cuarto estado sin señal a propósito: la clase declarada que NO le
    // corresponde al instrumento (un plan con `kind:"isin"`). El alta y la ficha ya
    // no lo producen —el campo es por instrumento y valida por su clase (#1746)— y
    // la ficha del plan enseña el valor guardado que no le sirve en una línea que se
    // puede seguir, que es donde se arregla. La puerta que todavía lo produce es el
    // destino nuevo de un traspaso, que pide ISIN sea cual sea el instrumento
    // heredado (#1772); cuando se cierre, este estado solo podrá venir de filas
    // antiguas.
    if (!asset.securityId) {
      signals.push(
        identitySignal({
          asset,
          baseLabel:
            `"${asset.name}" no tiene ${identifier}: sin él un extracto no puede casar ` +
            "esta posición ni hereda su ficha de exposición. Añádelo en su ficha o " +
            "márcalo como intencional.",
          code: MISSING_INVESTMENT_ISIN_CODE,
          overrideable: true,
          overriddenKeys: input.overriddenKeys,
        }),
      );
      continue;
    }

    if (asset.securityId.kind === null) {
      signals.push(
        identitySignal({
          asset,
          baseLabel:
            `El identificador de "${asset.name}" ("${asset.securityId.value}") no es ` +
            `un ${identifier} válido, así que no identifica nada: ni un extracto casa ` +
            "por él ni hereda su ficha de exposición. Corrígelo en su ficha.",
          code: UNCLASSIFIED_SECURITY_ID_CODE,
          overrideable: false,
          overriddenKeys: input.overriddenKeys,
        }),
      );
    }
  }

  return signals;
};

function identitySignal(input: {
  asset: ManualAsset;
  baseLabel: string;
  code: typeof MISSING_INVESTMENT_ISIN_CODE | typeof UNCLASSIFIED_SECURITY_ID_CODE;
  overrideable: boolean;
  overriddenKeys: ReadonlySet<string>;
}): DataQualitySignal {
  return {
    affected: { id: input.asset.id, label: input.asset.name, object: "holding" },
    category: "missing_configuration",
    code: input.code,
    fixable: true,
    label: signalLabelWithOverride(
      input.baseLabel,
      input.code,
      input.asset.id,
      input.overriddenKeys,
      input.overrideable,
    ),
    naturalKey: signalNaturalKey("missing_configuration", input.code, input.asset.id),
    severity: "low",
  };
}

/**
 * Whether a holding is in scope for the identity signals at all — the same gate for
 * both, because they are two readings of ONE field and a holding outside the gate has
 * no identity to lack or to misread.
 *
 * Four exclusions, each one a state where the identifier is not a pending task:
 *  - a `stored`/`appreciating`/debt holding has no instrument identity to key;
 *  - a holding with NO provider symbol is already saying something worse, and
 *    `MISSING_PROVIDER_SYMBOL` says it — two signals over one hole would just teach
 *    the user to ignore both;
 *  - a connected-source rung is identified by its source (a Binance token has no
 *    ISIN and never will), exactly as it is exempt from the symbol warning (#685);
 *  - `crypto` (and anything else outside {@link INVESTMENT_PROFILE_INSTRUMENTS}) has
 *    no identifier to be missing — the same set that decides who gets a look-through
 *    profile, read here so the two can never disagree about who HAS an identity.
 */
function isInstrumentIdentityCandidate(asset: ManualAsset): boolean {
  return (
    valuationMethodOfAsset(asset) === "derived" &&
    Boolean(asset.providerSymbol) &&
    !asset.connectedSourceId &&
    INVESTMENT_PROFILE_INSTRUMENTS.has(instrumentOfAsset(asset))
  );
}
