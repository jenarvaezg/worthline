"use client";

/**
 * The «viene traspasada de otra entidad» capture island (#1541, S6 of PRD #1393) —
 * the sibling of `InvestmentCapture`, and a thin shell over the same kind of pure
 * module (`interaction-patterns` §7).
 *
 * It earns its JS for the same reason that one does: the participaciones the entry
 * will carry are `importe ÷ VL`, nobody types them, and seeing them appear while you
 * type is what tells you the VL you wrote is the right one. The copy comes from
 * `externalTransferCaptureCopy`, which runs `planExternalTransferIn` — the gate's own
 * plan — so the figures on screen are the figures that get stored and a refusal is
 * worded exactly as the submit would word it.
 *
 * The four fields say four different things and the island keeps them apart:
 * the importe is what ARRIVED, the VL is the destination's on that day (the two
 * together fix the participaciones), the date is when the capital landed (the ripple
 * rebuilds the history from there), and the cost is what those participaciones cost
 * in the OLD provider — left empty it is the importe itself, which books no latent
 * gain rather than inventing one.
 */

import { useState } from "react";

import { externalTransferCaptureCopy } from "./external-transfer-in";

export function ExternalTransferCapture({
  defaultAmount,
  defaultCost,
  defaultDate,
  defaultPrice,
  instrument,
  today,
}: {
  defaultAmount: string;
  defaultCost: string;
  defaultDate: string;
  defaultPrice: string;
  instrument: string;
  today: string;
}) {
  const [amount, setAmount] = useState(defaultAmount);
  const [price, setPrice] = useState(defaultPrice);
  // Today, explicitly — never a blank field that means «hoy» in silence (#1490's
  // lesson): a visible date is a date the user can disagree with.
  const [date, setDate] = useState(defaultDate === "" ? today : defaultDate);
  const [cost, setCost] = useState(defaultCost);

  const { costNote, costRefused, hint, refused } = externalTransferCaptureCopy({
    amountRaw: amount,
    costRaw: cost,
    dateRaw: date,
    priceRaw: price,
    today,
  });

  return (
    <div className="invCapture">
      <label className="simpleField">
        <span>¿Cuánto entró? (€)</span>
        <input
          autoComplete="off"
          inputMode="decimal"
          name={`trAmount_${instrument}`}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="95,46"
          value={amount}
        />
        <small>Lo que la nueva entidad dice que ha recibido.</small>
      </label>
      <label className="simpleField">
        <span>Valor liquidativo de ese día (€)</span>
        <input
          autoComplete="off"
          inputMode="decimal"
          name={`trPrice_${instrument}`}
          onChange={(event) => setPrice(event.target.value)}
          placeholder="12,50"
          value={price}
        />
        <small>
          El de la fecha de entrada, no el de hoy: es lo que fija las participaciones.
        </small>
      </label>
      {/* Two polite live regions, one per derived figure, each below the fields it is
          about — the same order as the saldo pane, so the participaciones read right
          under the two figures that make them and a refusal is read where it can be
          fixed. */}
      <p
        aria-live="polite"
        className={refused ? "invUnitsHint invUnitsRefused" : "invUnitsHint"}
      >
        {hint}
      </p>
      <label className="simpleField">
        <span>¿Cuándo entró?</span>
        <input
          max={today}
          name={`trDate_${instrument}`}
          onChange={(event) => setDate(event.target.value)}
          type="date"
          value={date}
        />
      </label>
      <label className="simpleField">
        <span>Coste de adquisición que traen (€, opcional)</span>
        <input
          autoComplete="off"
          inputMode="decimal"
          name={`trCost_${instrument}`}
          onChange={(event) => setCost(event.target.value)}
          placeholder="80,00"
          value={cost}
        />
      </label>
      <p
        aria-live="polite"
        className={costRefused ? "invCostNote invUnitsRefused" : "invCostNote"}
      >
        {costNote}
      </p>
    </div>
  );
}
