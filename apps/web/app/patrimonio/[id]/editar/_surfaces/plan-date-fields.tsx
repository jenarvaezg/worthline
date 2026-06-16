/**
 * The two amortization-plan dates (ADR 0019, #189) as a minimal client island.
 *
 * The plan editor is otherwise zero-client-JS (ADR 0009: forms POST, no
 * `useState`). This is the same scoped escape hatch ADR 0009 took for the chart
 * tooltip — `"use client"` confined to the one interaction that genuinely needs
 * it. The acceptance criterion wants a *live* suggestion: editing the
 * disbursement re-derives the first-payment date until the user overrides it.
 *
 * The suggestion itself stays a pure, tested domain function
 * (`suggestFirstPaymentDate`); this component only holds the two inputs' state
 * and the "has the user overridden the suggestion?" flag. Both inputs submit by
 * `name` exactly like the native inputs they replace, so the server action and
 * the strict parser are unchanged — and server-side validation still re-checks
 * everything (`min` here is a convenience, never the source of truth).
 */
"use client";

import { suggestFirstPaymentDate } from "@worthline/domain";
import { useState } from "react";

export function PlanDateFields({
  initialDisbursement,
  initialFirstPayment,
  max,
}: {
  initialDisbursement: string;
  initialFirstPayment: string;
  max: string;
}) {
  const [disbursement, setDisbursement] = useState(initialDisbursement);
  const [firstPayment, setFirstPayment] = useState(initialFirstPayment);
  // A pre-filled first payment is already a user-chosen value — an existing plan
  // being edited, or a field recovered from a failed submit. Treat it as an
  // override so the suggestion never clobbers it; only a blank field (a fresh
  // plan) tracks the disbursement live.
  const [overridden, setOverridden] = useState(Boolean(initialFirstPayment));

  return (
    <>
      <label>
        Fecha de firma
        <input
          aria-label="Fecha de firma"
          max={max}
          name="disbursementDate"
          onChange={(event) => {
            const next = event.target.value;
            setDisbursement(next);
            if (!overridden && next) {
              setFirstPayment(suggestFirstPaymentDate(next));
            }
          }}
          required
          type="date"
          value={disbursement}
        />
      </label>
      <label>
        Fecha del primer pago
        <input
          aria-label="Fecha del primer pago"
          min={disbursement || undefined}
          name="firstPaymentDate"
          onChange={(event) => {
            setOverridden(true);
            setFirstPayment(event.target.value);
          }}
          required
          type="date"
          value={firstPayment}
        />
      </label>
      <p className="infoNote">
        Sugerimos el 1 del mes ~2 meses tras la firma (el «resto del mes más uno completo»
        que usan algunos bancos). Ajústalo a tu primer recibo real: manda tu fecha, no la
        sugerencia.
      </p>
    </>
  );
}
