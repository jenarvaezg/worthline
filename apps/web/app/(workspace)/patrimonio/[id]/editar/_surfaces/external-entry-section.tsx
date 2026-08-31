"use client";

/**
 * The «Traer de otra entidad» surface (#1518): a movilización arriving at a holding
 * this book already keeps.
 *
 * Why it sits here and not inside «Traspasar» (#1480). That screen starts from an
 * ORIGIN — this holding gives participaciones up — and asks which destination
 * receives them. This one is the mirror with a hole where the origin should be: the
 * outgoing half belongs to MyInvestor's ledger, or ING's, and no picker can ever
 * name it. Folding the two into one form would mean a destination selector with a
 * «ninguna, viene de fuera» option, which is a promise about a pair that does not
 * exist (ADR 0083, decisión 7).
 *
 * Why it is not the operations editor's third kind either. A `buy` and a `sell` are
 * one row each with the same five fields; an external entry declares an inherited
 * cost and an inherited seniority that no purchase has, and both are looked up in
 * the OLD provider's paperwork. A third `<option>` in that select would put two
 * fields on screen that mean nothing for the other two kinds.
 *
 * It is an island for the one reason the pane in the add wizard is: the
 * participaciones are `importe ÷ VL`, nobody types them, and watching them appear is
 * what tells you the VL is right. The copy comes from `externalTransferCaptureCopy`,
 * which runs `planExternalTransferIn` — the gate's own plan — so the figures on
 * screen are the figures that get stored and a refusal is worded exactly as the
 * submit would word it (#1438).
 *
 * The mutation is not optimistic (interaction-patterns §4): what it changes is a
 * position, a cost basis and a re-rippled history, none of it predictable client-side.
 */

import type { FormErrorContext } from "@web/intake";
import { externalTransferCaptureCopy } from "@web/patrimonio/anadir/external-transfer-in";
import { type FormEvent, useRef, useState, useTransition } from "react";

import { stampTransferSubmission } from "./transfer-form";

function RecordExternalEntrySubmit({
  disabled = false,
  pending,
}: {
  disabled?: boolean;
  pending: boolean;
}) {
  return (
    <button aria-busy={pending} disabled={pending || disabled} type="submit">
      {pending ? "Registrando…" : "Registrar entrada"}
    </button>
  );
}

export default function ExternalEntrySection({
  currentUrl,
  formError,
  holdingName,
  readOnly = false,
  recordAction,
  today,
}: {
  currentUrl: string;
  formError: FormErrorContext | null;
  holdingName: string;
  /** Demo: the write guard refuses, so the submit is disabled rather than lying (§10). */
  readOnly?: boolean;
  recordAction: (formData: FormData) => void | Promise<void>;
  today: string;
}) {
  const roundTripped = formError?.formId === "externalEntry" ? formError.values : {};

  const [amount, setAmount] = useState(roundTripped["trAmount"] ?? "");
  const [price, setPrice] = useState(roundTripped["trPrice"] ?? "");
  // Today, explicitly — never a blank field that means «hoy» in silence (#1490).
  const [date, setDate] = useState(roundTripped["trDate"] ?? today);
  const [cost, setCost] = useState(roundTripped["trCost"] ?? "");
  // Blank on purpose, unlike the landing date: «hoy» is a sensible guess for when
  // capital arrived and a terrible one for how old it is (#1518).
  const [seniority, setSeniority] = useState(roundTripped["trSeniority"] ?? "");

  const [isRecording, startRecording] = useTransition();
  // The key of the submit in flight (#1394), so a second click in the same frame
  // reuses it and the server recognises the replay. Cleared when it settles, or a
  // legitimate second movilización would be mistaken for a replay of the first.
  const inFlightSubmissionId = useRef<string | null>(null);

  const { costNote, costRefused, hint, refused, seniorityNote, seniorityRefused } =
    externalTransferCaptureCopy({
      amountRaw: amount,
      costRaw: cost,
      dateRaw: date,
      priceRaw: price,
      seniorityRaw: seniority,
      today,
    });

  const onSubmit = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        stampTransferSubmission(formData, inFlightSubmissionId, () =>
          crypto.randomUUID(),
        );
        startRecording(async () => {
          try {
            await recordAction(formData);
          } finally {
            inFlightSubmissionId.current = null;
          }
        });
      };

  return (
    <section aria-label="Entrada por traspaso desde otra entidad" id="entrada-externa">
      <h3>Traer de otra entidad</h3>
      <p className="infoNote">
        Capital que llega a {holdingName} movilizado desde otra gestora. No es una compra:{" "}
        <strong>no consume cupo de aportación</strong> y no realiza plusvalía. El coste
        que traían las participaciones viaja con ellas.
      </p>

      {formError?.formId === "externalEntry" ? (
        <p className="errorBand" id="external-entry-error" role="alert">
          {formError.message}
        </p>
      ) : null}

      <form
        action={recordAction}
        aria-label="Registrar entrada desde otra entidad"
        className="stackForm inversionesForm"
        onSubmit={onSubmit}
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <label>
          ¿Cuánto entró? (€)
          <input
            autoComplete="off"
            inputMode="decimal"
            name="trAmount"
            onChange={(event) => setAmount(event.target.value)}
            placeholder="95,46"
            value={amount}
          />
        </label>
        <label>
          Valor liquidativo de ese día (€)
          <input
            autoComplete="off"
            inputMode="decimal"
            name="trPrice"
            onChange={(event) => setPrice(event.target.value)}
            placeholder="12,50"
            value={price}
          />
        </label>
        {/* Polite live regions, one per derived figure, each below the fields it is
            about — the same order as the add wizard's pane. */}
        <p
          aria-live="polite"
          className={refused ? "opEntryReading opEntryRefused" : "opEntryReading"}
        >
          {hint}
        </p>

        <label>
          ¿Cuándo entró?
          <input
            max={today}
            name="trDate"
            onChange={(event) => setDate(event.target.value)}
            type="date"
            value={date}
          />
        </label>

        <label>
          Coste de adquisición que traen (€) <small>(opcional)</small>
          <input
            autoComplete="off"
            inputMode="decimal"
            name="trCost"
            onChange={(event) => setCost(event.target.value)}
            placeholder="80,00"
            value={cost}
          />
        </label>
        <p
          aria-live="polite"
          className={costRefused ? "opCaptureHint opEntryRefused" : "opCaptureHint"}
        >
          {costNote}
        </p>

        <label>
          Antigüedad que traen <small>(opcional)</small>
          <input
            max={date}
            name="trSeniority"
            onChange={(event) => setSeniority(event.target.value)}
            type="date"
            value={seniority}
          />
        </label>
        <p
          aria-live="polite"
          className={seniorityRefused ? "opCaptureHint opEntryRefused" : "opCaptureHint"}
        >
          {seniorityNote}
        </p>

        <RecordExternalEntrySubmit disabled={readOnly} pending={isRecording} />
      </form>
    </section>
  );
}
