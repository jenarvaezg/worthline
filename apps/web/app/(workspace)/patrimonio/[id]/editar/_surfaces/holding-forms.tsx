/**
 * The identity + valuation forms shared across the detail surfaces (#152).
 *
 * `AssetEditForm` / `LiabilityEditForm` edit a holding's identity (name, type,
 * ownership) and — for non-investments — its stored value/balance. An investment
 * shows no manual value field (ADR 0006: value is always derived); its
 * operations live in the `derived` surface (OperationsEditor). `OwnershipInputs`
 * is the shared ownership fieldset.
 *
 * Extracted from the monolithic editar page so each surface is a small focused
 * file the page composes. Server-rendered, no client JS (ADR 0009).
 */

import {
  editAssetAction,
  updateAssetValuationAction,
  updateLiabilityBalanceAction,
} from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import { priceSourceLabel, retiredPriceSourceLabel } from "@web/price-source-label";
import {
  priceSymbolProvenance,
  securityIdFieldCopy,
  securityIdFieldState,
} from "@web/security-id-field-copy";
import type { InvestmentAssetFull } from "@worthline/db";
import type {
  Instrument,
  Liability,
  ManualAsset,
  Member,
  ValuationMethod,
} from "@worthline/domain";
import {
  formatMoneyInput,
  formatMoneyMinorPrivacy,
  instrumentOfAsset,
  isRetiredInvestmentPriceProvider,
  keepsKnownPartialOwnership,
  SELECTABLE_INVESTMENT_PRICE_PROVIDERS,
  securityIdFieldForInstrument,
  VALUE_ONLY_ACK_LABEL,
  type ValueOnlyOpening,
  valueOnlySymbolFormNotice,
} from "@worthline/domain";
import Link from "next/link";

import { InstrumentPicker } from "./instrument-picker";

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * El campo de identidad de la ficha, entero o nada (#1746): la clase que le
 * corresponde al instrumento, las palabras de esa clase y lo que la caja enseña.
 * Se resuelve de una vez para que los tres no puedan discrepar —una copia de ISIN
 * sobre un campo de código DGS es exactamente el defecto que #1489 dejó abierto— y
 * para que el JSX no tenga que afirmar que existen tres cosas por separado.
 */
function identityBoxFor({
  currentInstrument,
  investment,
  values,
}: {
  currentInstrument: Instrument;
  investment: InvestmentAssetFull;
  values: Record<string, string>;
}): {
  field: NonNullable<ReturnType<typeof securityIdFieldForInstrument>>;
  copy: ReturnType<typeof securityIdFieldCopy>;
  state: ReturnType<typeof securityIdFieldState>;
} | null {
  const field = securityIdFieldForInstrument(currentInstrument);

  if (!field) return null;

  return {
    copy: securityIdFieldCopy(field.kind),
    field,
    state: securityIdFieldState({
      kind: field.kind,
      stored: investment.securityId,
      typed: values["securityId"],
    }),
  };
}

export function AssetEditForm({
  asset,
  boardHref,
  currentUrl,
  investment,
  isBinanceHolding = false,
  isCoinCollection = false,
  members,
  method,
  privacyMode,
  scopeMemberId,
  updateInvestmentAction,
  valueOnlyOpening = null,
  values,
}: {
  asset: ManualAsset;
  /** The board, anchored at this holding's row — the «Cancelar» destination. */
  boardHref: string;
  /** The holding's own public `wl_hld_…` URL, where every form here returns. */
  currentUrl: string;
  investment?: InvestmentAssetFull | null;
  isBinanceHolding?: boolean;
  isCoinCollection?: boolean;
  members: Member[];
  method: ValuationMethod;
  privacyMode: boolean;
  scopeMemberId: string | undefined;
  updateInvestmentAction?: FormAction;
  /**
   * Set when this investment's whole position is the 1-participación «alta por
   * valor total» and it still has no symbol (#1329) — the one state where
   * assigning one silently trades the declared value for a single share's quote.
   */
  valueOnlyOpening?: ValueOnlyOpening | null;
  values: Record<string, string>;
}) {
  const isInvestment = asset.type === "investment";
  // What the holding IS today — the picker's own value, and the list of
  // corrections it may offer (#1512).
  const currentInstrument = instrumentOfAsset(asset);

  // A connected-source holding (Numista coins / Binance crypto) is `derived`, like
  // an investment: its name/type/liquidity are fixed by the source and its value
  // is computed from its mirrored positions (ADR 0016/0021). Lock the identity
  // fields, hide the manual value form, but keep ownership editable below.
  if (isCoinCollection || isBinanceHolding) {
    return (
      <>
        <form action={editAssetAction} className="stackForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={asset.id} />
          <input name="scopeMemberId" type="hidden" value={scopeMemberId ?? ""} />
          <input name="name" type="hidden" value={asset.name} />
          <input name="type" type="hidden" value={asset.type} />
          <input name="liquidityTier" type="hidden" value={asset.liquidityTier} />

          <label>
            Nombre
            <input aria-label="Nombre del activo" defaultValue={asset.name} disabled />
          </label>

          <p className="infoNote">
            {isBinanceHolding
              ? "Es una cuenta conectada de Binance. Su valor se calcula en vivo a partir de tus tokens (ADR 0021) y se actualiza al sincronizar; aquí solo editas la propiedad."
              : "Es una colección conectada de Numista. Su valor se calcula a partir de las monedas (ADR 0016) y se actualiza al sincronizar; aquí solo editas la propiedad."}
          </p>

          <OwnershipInputs
            allowPartial={false}
            members={members}
            scopeMemberId={scopeMemberId}
            currentOwnership={asset.ownership}
            values={values}
          />

          <div className="formActions">
            <PendingSubmit pendingLabel="Guardando…">Guardar cambios</PendingSubmit>
            <Link href={boardHref}>Cancelar</Link>
          </div>
        </form>
      </>
    );
  }

  if (isInvestment && investment && updateInvestmentAction) {
    // Which identifier this holding can carry, what its box says and what it shows —
    // resolved from the instrument the ficha is showing, which is also the default of
    // the picker that may correct it. Null together: an instrument with no identifier
    // has no box, no copy and nothing to explain.
    const identity = identityBoxFor({ currentInstrument, investment, values });
    // «Identificado, sin cotizar» (invariante 6 del PRD #1741) con salida: el plan
    // tiene código y nadie le ha puesto símbolo, porque Finect no contestó en el
    // alta. Solo un plan, y solo si su código está guardado — es el dato con el que
    // se busca.
    const canSeedPlanSymbol =
      identity?.field.kind === "dgs" &&
      investment.securityId?.kind === "dgs" &&
      !investment.providerSymbol;

    return (
      <>
        <form action={updateInvestmentAction} className="stackForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="unitSymbol" type="hidden" value={investment.unitSymbol ?? ""} />

          <label>
            Nombre
            <input
              aria-label="Nombre del activo"
              defaultValue={values["name"] ?? investment.name}
              name="name"
            />
          </label>

          {/* #1512: la misma corrección que en un activo de valor declarado, con
              la lista de instrumentos que SÍ se valoran con títulos y precio. */}
          <InstrumentPicker
            currentInstrument={currentInstrument}
            liquidityTier={investment.liquidityTier}
            values={values}
          />

          <label>
            Disponibilidad
            <select
              defaultValue={values["liquidityTier"] ?? investment.liquidityTier}
              name="liquidityTier"
            >
              <option value="cash">Caja</option>
              <option value="market">Mercado</option>
              <option value="term-locked">A plazo</option>
              <option value="illiquid">Ilíquido</option>
            </select>
          </label>

          <label>
            Proveedor de precios
            <select
              defaultValue={values["priceProvider"] ?? investment.priceProvider}
              name="priceProvider"
            >
              {SELECTABLE_INVESTMENT_PRICE_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {priceSourceLabel(provider)}
                </option>
              ))}
              {/* #1354: un proveedor retirado sigue apareciendo SI la posición ya
                  lo tiene, etiquetado como tal. Ocultarlo cambiaría el proveedor
                  guardado en silencio al primer guardado del formulario. */}
              {isRetiredInvestmentPriceProvider(investment.priceProvider) ? (
                <option value={investment.priceProvider}>
                  {retiredPriceSourceLabel(investment.priceProvider)}
                </option>
              ) : null}
            </select>
          </label>

          <label>
            Símbolo del proveedor
            <input
              aria-label="Símbolo del proveedor"
              autoComplete="off"
              defaultValue={values["providerSymbol"] ?? investment.providerSymbol ?? ""}
              name="providerSymbol"
            />
            {/* #1746: dos campos donde antes había uno, y uno derivado del otro. Sin
                decir de dónde sale cada cual se leen como el mismo dato repetido. */}
            {identity ? (
              <small>
                {priceSymbolProvenance({
                  kind: identity.field.kind,
                  providerLabel: priceSourceLabel(investment.priceProvider),
                })}
              </small>
            ) : null}
          </label>

          {/* #1329: la posición nacida «por valor total» avisa ANTES de que el
              símbolo entregue la valoración a la cotización, y ofrece la única
              salida honesta que no es corregir la apertura. */}
          {valueOnlyOpening ? (
            <div className="warningBand">
              <span>{valueOnlySymbolFormNotice(valueOnlyOpening)}</span>
              <label className="checkLine">
                <input
                  defaultChecked={values["valueOnlySymbolAck"] === "on"}
                  name="valueOnlySymbolAck"
                  type="checkbox"
                />{" "}
                {VALUE_ONLY_ACK_LABEL}: guardar el símbolo sin tocar los títulos.
              </label>
            </div>
          ) : null}

          {/* El identificador que el instrumento PUEDE tener (#1746, decisión 9): el
              código DGS de un plan, el ISIN del resto, nada en lo que no lleva
              ninguno. La clase declarada viaja con el envío porque el selector de
              arriba puede estar reclasificándolo en el mismo guardado (#1512), y
              entonces el rechazo tiene que poder nombrar el cambio. */}
          {identity ? (
            <>
              <input name="securityIdKind" type="hidden" value={identity.field.kind} />
              <label>
                {identity.copy.fichaLabel}{" "}
                <small>· {identity.copy.provenance} (opcional)</small>
                <input
                  aria-label={identity.copy.fichaLabel}
                  autoComplete="off"
                  defaultValue={identity.state.value}
                  name="securityId"
                  placeholder={identity.copy.placeholder}
                />
                <small>{identity.copy.help}</small>
              </label>
              {identity.state.mismatch ? (
                <p className="warningBand">{identity.state.mismatch}</p>
              ) : null}
            </>
          ) : null}

          {/* El reintento que promete la señal de salud: un gesto, el MISMO envío de
              la ficha, así que el símbolo que siembre pasa por las mismas guardas que
              uno tecleado a mano (el símbolo que no resuelve, y #1329). */}
          {canSeedPlanSymbol ? (
            <div className="warningBand">
              <span>
                Este plan está identificado por su código DGS pero no cotiza: nadie le ha
                puesto símbolo de precio. Podemos pedírselo a Finect con el código.
              </span>
              <PendingSubmit
                name="seedPlanSymbol"
                pendingLabel="Buscando en Finect…"
                value="1"
              >
                Buscar el símbolo por su código DGS
              </PendingSubmit>
            </div>
          ) : null}

          <label>
            Precio manual por unidad (EUR) <small>(opcional)</small>
            <input
              defaultValue={
                values["manualPricePerUnit"] ?? investment.manualPricePerUnit ?? ""
              }
              inputMode="decimal"
              name="manualPricePerUnit"
            />
          </label>

          <p className="infoNote">
            Valor actual: {formatMoneyMinorPrivacy(asset.currentValue, privacyMode)} —
            derivado de las operaciones y del precio disponible.
          </p>

          <div className="formActions">
            <PendingSubmit pendingLabel="Guardando…">Guardar cambios</PendingSubmit>
            <Link href={boardHref}>Cancelar</Link>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={asset.id} />
        <input name="scopeMemberId" type="hidden" value={scopeMemberId ?? ""} />

        <label>
          Nombre
          <input
            aria-label="Nombre del activo"
            defaultValue={values["name"] ?? asset.name}
            name="name"
            disabled={isInvestment}
          />
        </label>

        {isInvestment ? (
          <p className="infoNote">
            Esta inversión cotiza con ticker. Su nombre, proveedor de precios y símbolo se
            fijaron al añadirla; su valor se deriva de las operaciones de abajo (ADR
            0006).
          </p>
        ) : (
          <>
            {/* #1512: el instrumento se corrige AQUÍ, con la misma lista del alta.
                El «Tipo» heredado (cash/manual/real_estate) ya no se teclea: se
                deriva del instrumento en el store (ADR 0098). */}
            <InstrumentPicker
              connectedSourceId={asset.connectedSourceId ?? null}
              currentInstrument={currentInstrument}
              liquidityTier={asset.liquidityTier}
              values={values}
            />

            <label>
              Disponibilidad
              <select
                defaultValue={values["liquidityTier"] ?? asset.liquidityTier}
                name="liquidityTier"
              >
                <option value="cash">Caja</option>
                <option value="market">Mercado</option>
                <option value="term-locked">A plazo</option>
                <option value="illiquid">Ilíquido</option>
                <option value="housing">Vivienda</option>
              </select>
            </label>

            {/* La casilla existe solo mientras el activo ES un inmueble: en
                cualquier otro instrumento no hay estado que marcar, y dejarla
                puesta resucitaría `property` en la siguiente edición (#1512). */}
            {currentInstrument === "property" ? (
              <label className="checkLine">
                <input
                  defaultChecked={
                    values["isPrimaryResidence"]
                      ? values["isPrimaryResidence"] === "on"
                      : asset.isPrimaryResidence
                  }
                  name="isPrimaryResidence"
                  type="checkbox"
                />{" "}
                Vivienda habitual
              </label>
            ) : null}

            <OwnershipInputs
              allowPartial={keepsKnownPartialOwnership(currentInstrument)}
              members={members}
              scopeMemberId={scopeMemberId}
              currentOwnership={asset.ownership}
              values={values}
            />
          </>
        )}

        {!isInvestment ? (
          <div className="formActions">
            <PendingSubmit pendingLabel="Guardando…">Guardar cambios</PendingSubmit>
            <Link href={boardHref}>Cancelar</Link>
          </div>
        ) : null}
      </form>

      {method === "derived" ? (
        <p className="infoNote">
          Valor actual: {formatMoneyMinorPrivacy(asset.currentValue, privacyMode)} —
          derivado de las operaciones (ADR 0006).
        </p>
      ) : (
        // stored AND appreciating keep the manual current-value form: a property's
        // current value is the appreciation curve's "today" anchor (the curve +
        // appraisals are additive via HousingValuationSection). Only derived
        // holdings (units × price) hide it (ADR 0006).
        <form action={updateAssetValuationAction} className="stackForm updateValueForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={asset.id} />
          <label>
            Valor actual (EUR)
            <input
              aria-label="Valor actual en EUR"
              defaultValue={formatMoneyInput(asset.currentValue.amountMinor)}
              inputMode="decimal"
              name="currentValue"
            />
          </label>
          <PendingSubmit pendingLabel="Actualizando…">Actualizar valor</PendingSubmit>
        </form>
      )}
    </>
  );
}

export function LiabilityEditForm({
  assets,
  boardHref,
  currentUrl,
  liability,
  members,
  scopeMemberId,
  showRawBalanceForm,
  values,
}: {
  assets: ManualAsset[];
  /** The board, anchored at this holding's row — the «Cancelar» destination. */
  boardHref: string;
  /** The holding's own public `wl_hld_…` URL, where every form here returns. */
  currentUrl: string;
  liability: Liability;
  members: Member[];
  scopeMemberId: string | undefined;
  /**
   * Whether `liabilities.current_balance_minor` still governs this debt's figure
   * (#1290). Decided server-side with `storedBalanceGovernsDebtFigure`: a debt
   * with a modelled curve (plan / re-baseline / anchors) takes its balance from
   * the curve, so the raw form would be a silent write into the void — the
   * repair door there is «Recalibrar con saldo real» or a new anchor (ADR 0056).
   */
  showRawBalanceForm: boolean;
  values: Record<string, string>;
}) {
  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liability.id} />
        <input name="scopeMemberId" type="hidden" value={scopeMemberId ?? ""} />
        <input name="isLiability" type="hidden" value="true" />

        <label>
          Nombre
          <input
            aria-label="Nombre de la deuda"
            defaultValue={values["name"] ?? liability.name}
            name="name"
          />
        </label>

        <label>
          Tipo
          <select defaultValue={values["type"] ?? liability.type} name="type">
            <option value="mortgage">Hipoteca</option>
            <option value="debt">Deuda</option>
          </select>
        </label>

        <label>
          Activo asociado (opcional)
          <select
            defaultValue={
              values["associatedAssetId"] ?? liability.associatedAssetId ?? ""
            }
            name="associatedAssetId"
          >
            <option value="">Sin activo asociado</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <OwnershipInputs
          allowPartial={
            assets.find((a) => a.id === liability.associatedAssetId)?.type ===
            "real_estate"
          }
          members={members}
          scopeMemberId={scopeMemberId}
          currentOwnership={liability.ownership}
          values={values}
        />

        <div className="formActions">
          <button type="submit">Guardar cambios</button>
          <Link href={boardHref}>Cancelar</Link>
        </div>
      </form>

      {showRawBalanceForm ? (
        <form action={updateLiabilityBalanceAction} className="stackForm updateValueForm">
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liability.id} />
          <label>
            Saldo pendiente (EUR)
            <input
              aria-label="Saldo pendiente en EUR"
              defaultValue={formatMoneyInput(liability.currentBalance.amountMinor)}
              inputMode="decimal"
              name="balance"
            />
          </label>
          <PendingSubmit pendingLabel="Actualizando…">Actualizar saldo</PendingSubmit>
        </form>
      ) : null}
    </>
  );
}

export function OwnershipInputs({
  allowPartial,
  members,
  scopeMemberId,
  currentOwnership,
  values = {},
}: {
  allowPartial: boolean;
  members: Member[];
  scopeMemberId: string | undefined;
  currentOwnership: Array<{ memberId: string; shareBps: number }>;
  values?: Record<string, string>;
}) {
  if (members.length === 0 || (members.length === 1 && !allowPartial)) {
    return null;
  }

  const scopeMember = members.find((m) => m.id === scopeMemberId) ?? members[0]!;
  const preset =
    values["ownershipPreset"] ??
    deriveOwnershipPreset(members, scopeMember.id, currentOwnership);

  const currentBpsFor = (memberId: string): string => {
    const share = currentOwnership.find((s) => s.memberId === memberId);
    return share ? String(Math.round(share.shareBps / 100)) : "0";
  };

  return (
    <fieldset className="ownershipGrid">
      <legend>Propiedad</legend>
      <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "scope"}
          name="ownershipPreset"
          type="radio"
          value="scope"
        />
        Solo mío
      </label>
      {members.length > 1 ? (
        <label className="ownerPreset">
          <input
            defaultChecked={preset === "even"}
            name="ownershipPreset"
            type="radio"
            value="even"
          />
          De los dos (mitad y mitad)
        </label>
      ) : null}
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "custom"}
          name="ownershipPreset"
          type="radio"
          value="custom"
        />
        Otro reparto…
      </label>
      <div className="ownerCustom">
        {members.map((member) => (
          <label key={member.id}>
            {member.name}
            <input
              defaultValue={values[`owner_${member.id}`] ?? currentBpsFor(member.id)}
              inputMode="decimal"
              name={`owner_${member.id}`}
              aria-label={`Porcentaje de ${member.name}`}
            />
          </label>
        ))}
        {allowPartial ? (
          <p className="simpleHint">
            ¿Un inmueble a medias con alguien de fuera? Pon solo vuestra parte; el resto
            se da por suyo.
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

function deriveOwnershipPreset(
  members: Member[],
  scopeMemberId: string,
  currentOwnership: Array<{ memberId: string; shareBps: number }>,
): "scope" | "even" | "custom" {
  if (
    currentOwnership.length === 1 &&
    currentOwnership[0]?.memberId === scopeMemberId &&
    currentOwnership[0]?.shareBps === 10_000
  ) {
    return "scope";
  }

  if (members.length > 1 && isEvenOwnership(members, currentOwnership)) {
    return "even";
  }

  return "custom";
}

function isEvenOwnership(
  members: Member[],
  currentOwnership: Array<{ memberId: string; shareBps: number }>,
): boolean {
  const shareByMember = new Map(
    currentOwnership.map((share) => [share.memberId, share.shareBps]),
  );
  const base = Math.floor(10_000 / members.length);
  let remainder = 10_000 - base * members.length;

  return members.every((member) => {
    const expected = base + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;

    return shareByMember.get(member.id) === expected;
  });
}
