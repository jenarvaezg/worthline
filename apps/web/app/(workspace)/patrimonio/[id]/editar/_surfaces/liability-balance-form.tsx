/**
 * «Actualizar saldo»: the hand-set `current_balance_minor` of a debt — the ONLY
 * balance a debt without a modelled curve has (#1290).
 *
 * The sibling of `AssetValueForm` (#1846), for a debt. On the debt's tabbed ficha it
 * is an action of the bar and lives in the side panel (#1848), posting the ficha's
 * URL as `returnTo` so the success stays where the new balance shows; in «Lo
 * básico» (a ficha still on the accordion) it posts none, and the success lands on
 * the board's row as it always did. Either way its refusal is its own
 * (`BALANCE_FORM_ID`), printed HERE, once, with what was typed.
 *
 * Offered only while the stored balance governs the debt's figure
 * (`storedBalanceGovernsDebtFigure`); the server action re-checks it.
 */

import type { FormErrorContext } from "@web/intake";
import { BALANCE_FORM_ID } from "@web/patrimonio/action-helpers";
import { updateLiabilityBalanceAction } from "@web/patrimonio/actions";
import { PendingSubmit } from "@web/pending-submit";
import type { Liability } from "@worthline/domain";
import { formatMoneyInput } from "@worthline/domain";

const ERROR_ID = "balance-error";

export function LiabilityBalanceForm({
  currentUrl,
  formError,
  liability,
  placement,
  readOnly = false,
  returnTo,
}: {
  /** Where a refusal returns: the page or tab this form is on. */
  currentUrl: string;
  formError: FormErrorContext | null;
  liability: Liability;
  /** In «Lo básico» it is ruled off from the identity form above it. */
  placement: "basics" | "panel";
  /** Demo: the write-guard rejects it, so the submit is not offered (§10). */
  readOnly?: boolean;
  /** Where the success returns; absent, the board's row. */
  returnTo?: string;
}) {
  const refusal = formError?.formId === BALANCE_FORM_ID ? formError : null;

  return (
    <form
      action={updateLiabilityBalanceAction}
      className={placement === "basics" ? "stackForm updateValueForm" : "stackForm"}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      {returnTo ? <input name="returnTo" type="hidden" value={returnTo} /> : null}
      <input name="id" type="hidden" value={liability.id} />
      {refusal ? (
        <p className="errorBand" id={ERROR_ID} role="alert">
          {refusal.message}
        </p>
      ) : null}
      <label>
        Saldo pendiente (EUR)
        <input
          aria-describedby={refusal ? ERROR_ID : undefined}
          aria-invalid={refusal ? true : undefined}
          aria-label="Saldo pendiente en EUR"
          defaultValue={
            refusal?.values["balance"] ??
            formatMoneyInput(liability.currentBalance.amountMinor)
          }
          inputMode="decimal"
          name="balance"
        />
      </label>
      <PendingSubmit disabled={readOnly} pendingLabel="Actualizando…">
        Actualizar saldo
      </PendingSubmit>
    </form>
  );
}
