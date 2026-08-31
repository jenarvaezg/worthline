/**
 * The lease-terms block under one declared rent (#1521) — server-rendered, a plain
 * server-action form like every other affordance on the schedule's row.
 *
 * It shows first and asks second, and the order is the whole point: the sentence on
 * top says what the app is assuming RIGHT NOW about what happens when the lease ends
 * — including «nadie lo ha declarado», which used to be invisible while it quietly
 * dropped a flat to the housing rung's 3 %. The selects below are how that assumption
 * stops being one.
 *
 * Only a rented property gets this block: `endISO` on a coupon or a dividend means
 * exactly what it says, and there is no regime to declare (ADR 0076 point 4).
 */

import type { PayoutSchedule } from "@worthline/domain";
import { LeaseTermFields } from "./lease-term-fields";
import { leaseTermsSpec } from "./lease-terms-form";

type FormAction = (formData: FormData) => void | Promise<void>;

export function LeaseTermsRow({
  action,
  currentUrl,
  schedule,
}: {
  action: FormAction;
  currentUrl: string;
  schedule: PayoutSchedule;
}) {
  const { spec, warning } = leaseTermsSpec(schedule);

  return (
    <div className="cobrosLease">
      <p className="cobrosCap">{spec}</p>
      {warning ? <p className="cobrosLeaseWarning">{warning}</p> : null}
      <form action={action} className="cobrosLeaseForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="scheduleId" type="hidden" value={schedule.id} />
        {/* Marks the intent, so an empty select reads as «retiro la declaración»
            instead of as a form that never carried the field. */}
        <input name="saveLease" type="hidden" value="1" />
        <LeaseTermFields ofLabel={schedule.label} values={schedule} />
        <button className="btnSmall" type="submit">
          Guardar condiciones
        </button>
      </form>
    </div>
  );
}
