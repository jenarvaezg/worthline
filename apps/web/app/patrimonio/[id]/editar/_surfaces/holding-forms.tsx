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

import type { InvestmentAssetFull } from "@worthline/db";
import { formatMoneyInput, formatMoneyMinorPrivacy } from "@worthline/domain";
import type { Liability, ManualAsset, Member, ValuationMethod } from "@worthline/domain";
import Link from "next/link";

import {
  editAssetAction,
  updateAssetValuationAction,
  updateLiabilityBalanceAction,
} from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";

type FormAction = (formData: FormData) => void | Promise<void>;

export function AssetEditForm({
  asset,
  investment,
  isBinanceHolding = false,
  isCoinCollection = false,
  members,
  method,
  privacyMode,
  scopeMemberId,
  updateInvestmentAction,
  values,
}: {
  asset: ManualAsset;
  investment?: InvestmentAssetFull | null;
  isBinanceHolding?: boolean;
  isCoinCollection?: boolean;
  members: Member[];
  method: ValuationMethod;
  privacyMode: boolean;
  scopeMemberId: string | undefined;
  updateInvestmentAction?: FormAction;
  values: Record<string, string>;
}) {
  const isInvestment = asset.type === "investment";

  // A connected-source holding (Numista coins / Binance crypto) is `derived`, like
  // an investment: its name/type/liquidity are fixed by the source and its value
  // is computed from its mirrored positions (ADR 0016/0021). Lock the identity
  // fields, hide the manual value form, but keep ownership editable below.
  if (isCoinCollection || isBinanceHolding) {
    return (
      <>
        <form action={editAssetAction} className="stackForm">
          <input
            name="currentUrl"
            type="hidden"
            value={`/patrimonio/${asset.id}/editar`}
          />
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
            <Link href={`/patrimonio#${asset.id}`}>Cancelar</Link>
          </div>
        </form>
      </>
    );
  }

  if (isInvestment && investment && updateInvestmentAction) {
    return (
      <>
        <form action={updateInvestmentAction} className="stackForm">
          <input
            name="currentUrl"
            type="hidden"
            value={`/patrimonio/${asset.id}/editar`}
          />
          <input name="unitSymbol" type="hidden" value={investment.unitSymbol ?? ""} />

          <label>
            Nombre
            <input
              aria-label="Nombre del activo"
              defaultValue={values["name"] ?? investment.name}
              name="name"
            />
          </label>

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
              <option value="yahoo">Yahoo Finance</option>
              <option value="stooq">Stooq</option>
              <option value="finect">Finect</option>
              <option value="coingecko">CoinGecko</option>
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
          </label>

          <label>
            ISIN <small>(opcional)</small>
            <input
              aria-label="ISIN"
              autoComplete="off"
              defaultValue={values["isin"] ?? investment.isin ?? ""}
              name="isin"
            />
          </label>

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
            <Link href={`/patrimonio#${asset.id}`}>Cancelar</Link>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={`/patrimonio/${asset.id}/editar`} />
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
            <label>
              Tipo
              <select defaultValue={values["type"] ?? asset.type} name="type">
                <option value="cash">Cuenta o efectivo</option>
                <option value="manual">Activo general</option>
                <option value="real_estate">Vivienda o inmueble</option>
              </select>
            </label>

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

            <OwnershipInputs
              allowPartial={asset.type === "real_estate"}
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
            <Link href={`/patrimonio#${asset.id}`}>Cancelar</Link>
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
          <input
            name="currentUrl"
            type="hidden"
            value={`/patrimonio/${asset.id}/editar`}
          />
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
  liability,
  members,
  scopeMemberId,
  values,
}: {
  assets: ManualAsset[];
  liability: Liability;
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
}) {
  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input
          name="currentUrl"
          type="hidden"
          value={`/patrimonio/${liability.id}/editar`}
        />
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
          <Link href={`/patrimonio#${liability.id}`}>Cancelar</Link>
        </div>
      </form>

      <form action={updateLiabilityBalanceAction} className="stackForm updateValueForm">
        <input
          name="currentUrl"
          type="hidden"
          value={`/patrimonio/${liability.id}/editar`}
        />
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
