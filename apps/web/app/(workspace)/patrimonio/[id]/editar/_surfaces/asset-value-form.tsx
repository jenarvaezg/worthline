/**
 * «Actualizar valor»: the hand-set value of a holding nobody quotes (ADR 0014) — a
 * current account, a deposit, a vehicle, a flat's «today» anchor.
 *
 * One form in two places. On the tabbed ficha of a stored holding it is the bar's
 * habitual action and lives in the side panel (#1846), posting the ficha's URL as
 * `returnTo` so the success stays where the new value and today's date show; in
 * «Lo básico» of a ficha that still keeps the accordion it posts none, and the
 * success lands on the board's row as it always did.
 *
 * Either way its refusal is its own (`VALUE_FORM_ID`): it comes back with what was
 * typed and is printed HERE, once — inside the panel, which on a phone covers the
 * page band that used to say it.
 */

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
  placement,
  readOnly = false,
  returnTo,
}: {
  asset: ManualAsset;
  /** Where a refusal returns: the page or tab this form is on. */
  currentUrl: string;
  formError: FormErrorContext | null;
  /**
   * Where it sits. In «Lo básico» it is ruled off from the identity form above it;
   * alone in the side panel there is nothing to rule it off from.
   */
  placement: "basics" | "panel";
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  /** Where the success returns; absent, the board's row. */
  returnTo?: string;
}) {
  const refusal = formError?.formId === VALUE_FORM_ID ? formError : null;
  const currency = asset.currentValue.currency;

  return (
    <form
      action={updateAssetValuationAction}
      className={placement === "basics" ? "stackForm updateValueForm" : "stackForm"}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      {returnTo ? <input name="returnTo" type="hidden" value={returnTo} /> : null}
      <input name="id" type="hidden" value={asset.id} />
      {refusal ? (
        <p className="errorBand" id={ERROR_ID} role="alert">
          {refusal.message}
        </p>
      ) : null}
      <label>
        Valor actual ({currency})
        <input
          aria-describedby={refusal ? ERROR_ID : undefined}
          aria-invalid={refusal ? true : undefined}
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
