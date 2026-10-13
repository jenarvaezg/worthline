/**
 * «Actualizar valor»: the hand-set value of a holding nobody quotes (ADR 0014) — a
 * current account, a deposit, a vehicle, a flat's «today» anchor.
 *
 * On the ficha of a stored holding it is the bar's habitual action and lives in the
 * side panel (#1846), posting the ficha's URL as `returnTo` so the success stays
 * where the new value and today's date show.
 *
 * Its refusal is its own (`VALUE_FORM_ID`): it comes back with what was typed and
 * is printed HERE, once — inside the panel, which on a phone covers the page band
 * that used to say it.
 */

import { FormRefusal, refusalAria, refusalFor } from "@web/_components/form-refusal";
import type { FormErrorContext } from "@web/intake";
import { VALUE_FORM_ID } from "@web/patrimonio/action-helpers";
import { updateAssetValuationAction } from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { ManualAsset } from "@worthline/domain";
import { formatMoneyInput } from "@worthline/domain";

const ERROR_ID = "value-error";

export function AssetValueForm({
  asset,
  currentUrl,
  formError,
  readOnly = false,
  returnTo,
}: {
  asset: ManualAsset;
  /** Where a refusal returns: the page or tab this form is on. */
  currentUrl: string;
  formError: FormErrorContext | null;
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  /** Where the success returns: the ficha, where the new value shows. */
  returnTo: string;
}) {
  const refusal = refusalFor(formError, VALUE_FORM_ID);
  const currency = asset.currentValue.currency;

  return (
    <form action={updateAssetValuationAction} className="stackForm">
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="returnTo" type="hidden" value={returnTo} />
      <input name="id" type="hidden" value={asset.id} />
      <FormRefusal id={ERROR_ID} refusal={refusal} />
      <label>
        Valor actual ({currency})
        <input
          {...refusalAria(refusal ? ERROR_ID : undefined)}
          aria-label={`Valor actual en ${currency}`}
          defaultValue={
            refusal?.values["currentValue"] ??
            formatMoneyInput(asset.currentValue.amountMinor)
          }
          inputMode="decimal"
          name="currentValue"
        />
      </label>
      <PendingSubmit disabled={readOnly} pendingLabel="Actualizando…">
        Actualizar valor
      </PendingSubmit>
    </form>
  );
}
