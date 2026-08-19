"use client";

/**
 * The "saldo de hoy" capture island (#597, PRD #593 S2). The wizard is otherwise
 * server-rendered with CSS-`:has()` disclosure (ADR 0009), but this one field
 * earns a client island: it shows `≈ participaciones` live **as you type** the
 * euro balance (an explicit acceptance criterion). It owns the saldo + price
 * inputs so the hint reacts to both — the price prefilled from the picked symbol's
 * live quote, or typed by hand when search found nothing (the manual fallback).
 *
 * The copy is `openingCaptureCopy` — built on the SAME pure helpers the server
 * action uses to record the opening BUY, so the preview can never drift from what
 * gets persisted: neither the units (saldo ÷ precio, cut at the declared precision)
 * nor the date they are stamped with, nor the cost they are bought at.
 *
 * Since #1395 the pane also owns the DATE, and since #1490 the **coste de
 * adquisición** — because an alta declares a position that already existed. The four
 * fields say four different things and the island is what keeps them apart while you
 * type: the saldo and the price are today's (they fix how many participaciones there
 * are), the cost is what the position cost (it is the price the opening operation
 * carries), and the date is since when it is held (the ripple rebuilds the history
 * from there). Leaving the cost empty is a legitimate answer — the pane says out loud
 * that there will be no plusvalía, rather than inventing one (ADR 0048).
 *
 * All of that copy comes from the pure helper, not from JSX conditionals invented
 * here.
 */

import { useState } from "react";

import { type OpeningCostMode, openingCaptureCopy } from "./investment-units";

export function InvestmentCapture({
  defaultCost,
  defaultCostMode,
  defaultDate,
  defaultPrice,
  defaultSaldo,
  instrument,
  priceHint,
  today,
}: {
  instrument: string;
  defaultCost?: string | undefined;
  defaultCostMode?: OpeningCostMode | undefined;
  defaultDate: string;
  defaultPrice: string;
  defaultSaldo: string;
  priceHint?: string | undefined;
  today: string;
}) {
  const [saldo, setSaldo] = useState(defaultSaldo);
  const [price, setPrice] = useState(defaultPrice);
  // Today, explicitly (#1490): the field used to start empty and mean "hoy" in
  // silence, which is how a position bought in December got dated in August. A
  // visible date is a date the user can disagree with.
  const [date, setDate] = useState(defaultDate === "" ? today : defaultDate);
  const [cost, setCost] = useState(defaultCost ?? "");
  const [costMode, setCostMode] = useState<OpeningCostMode>(defaultCostMode ?? "total");

  const { costNote, costRefused, hint, refused } = openingCaptureCopy({
    costMode,
    costRaw: cost,
    dateRaw: date,
    priceRaw: price,
    saldoRaw: saldo,
    today,
  });

  return (
    <div className="invCapture">
      <label className="simpleField">
        <span>¿Cuánto tienes hoy? (€)</span>
        <input
          autoComplete="off"
          inputMode="decimal"
          name={`saldo_${instrument}`}
          onChange={(event) => setSaldo(event.target.value)}
          placeholder="1.000,00"
          value={saldo}
        />
      </label>
      <label className="simpleField">
        <span>Precio por participación (€)</span>
        <input
          autoComplete="off"
          inputMode="decimal"
          name={`price_${instrument}`}
          onChange={(event) => setPrice(event.target.value)}
          placeholder="50.000,00"
          value={price}
        />
        {priceHint ? <small>{priceHint}</small> : null}
      </label>
      {/* Two live regions, one per figure the pane derives (the units, the cost) —
          each beside the fields it is about, so a refusal is read where it can be
          fixed. Both stay polite: swapping `role` on a live node in flight is
          unreliable in assistive tech, and the refusal is announced by the text
          change either way — `.invUnitsRefused` carries the visual meaning. */}
      <p
        className={refused ? "invUnitsHint invUnitsRefused" : "invUnitsHint"}
        aria-live="polite"
      >
        {hint}
      </p>
      <label className="simpleField">
        <span>¿Desde cuándo la tienes?</span>
        <input
          max={today}
          name={`saldoDate_${instrument}`}
          onChange={(event) => setDate(event.target.value)}
          type="date"
          value={date}
        />
        <small>Si ya la tenías antes de hoy, ponlo y reconstruimos el histórico.</small>
      </label>
      <label className="simpleField">
        <span>¿Cuánto te costó? (€, opcional)</span>
        <input
          autoComplete="off"
          inputMode="decimal"
          name={`cost_${instrument}`}
          onChange={(event) => setCost(event.target.value)}
          placeholder="4.999,86"
          value={cost}
        />
      </label>
      <fieldset className="simpleChoiceGroup invCostMode">
        <legend>Ese coste es…</legend>
        <label className="ownerPreset simpleChoice">
          <input
            checked={costMode === "total"}
            name={`costMode_${instrument}`}
            onChange={() => setCostMode("total")}
            type="radio"
            value="total"
          />
          <span>En total</span>
        </label>
        <label className="ownerPreset simpleChoice">
          <input
            checked={costMode === "unit"}
            name={`costMode_${instrument}`}
            onChange={() => setCostMode("unit")}
            type="radio"
            value="unit"
          />
          <span>Por participación</span>
        </label>
      </fieldset>
      <p
        className={costRefused ? "invCostNote invUnitsRefused" : "invCostNote"}
        aria-live="polite"
      >
        {costNote}
      </p>
    </div>
  );
}
