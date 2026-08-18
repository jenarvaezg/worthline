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
 * nor the date they are stamped with.
 *
 * Since #1395 the pane also owns «Fecha del saldo» (optional, today by default).
 * What the user types is then a balance AT that date — an alta is often a position
 * that did not start today (a traspaso executed weeks ago), and dating it today left
 * the net worth with a hole between the exit and the re-entry. The field lives in
 * this island rather than beside it because the whole pane has to re-read itself
 * against it: both labels change, the price stops being «the live quote» and becomes
 * that date's NAV, and a date the server would refuse says so while you type. All of
 * that copy comes from the pure helper, not from JSX conditionals invented here.
 */

import { useState } from "react";

import { openingCaptureCopy } from "./investment-units";

export function InvestmentCapture({
  defaultDate,
  defaultPrice,
  defaultSaldo,
  instrument,
  livePrice,
  priceHint,
  today,
}: {
  instrument: string;
  defaultDate: string;
  defaultPrice: string;
  defaultSaldo: string;
  /** The provider quote that prefilled the price, so the copy can CHECK it. */
  livePrice?: string | undefined;
  priceHint?: string | undefined;
  today: string;
}) {
  const [saldo, setSaldo] = useState(defaultSaldo);
  const [price, setPrice] = useState(defaultPrice);
  const [date, setDate] = useState(defaultDate);

  const { backdatedTo, hint, priceNote, refused } = openingCaptureCopy({
    dateRaw: date,
    livePriceRaw: livePrice,
    priceRaw: price,
    saldoRaw: saldo,
    today,
  });

  return (
    <div className="invCapture">
      <label className="simpleField">
        <span>
          {backdatedTo === null
            ? "¿Cuánto tienes hoy? (€)"
            : `¿Cuánto tenías el ${backdatedTo}? (€)`}
        </span>
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
        <span>
          {backdatedTo === null
            ? "Precio por participación (€)"
            : `Precio por participación el ${backdatedTo} (€)`}
        </span>
        <input
          autoComplete="off"
          inputMode="decimal"
          name={`price_${instrument}`}
          onChange={(event) => setPrice(event.target.value)}
          placeholder="50.000,00"
          value={price}
        />
        {priceNote === null ? (
          priceHint ? (
            <small>{priceHint}</small>
          ) : null
        ) : (
          <small>{priceNote}</small>
        )}
      </label>
      <label className="simpleField">
        <span>Fecha del saldo (opcional)</span>
        <input
          max={today}
          name={`saldoDate_${instrument}`}
          onChange={(event) => setDate(event.target.value)}
          type="date"
          value={date}
        />
        <small>Si el saldo no es de hoy, ponla y reconstruimos el histórico.</small>
      </label>
      {/* One live region, always polite: swapping `role` on a live node in flight is
          unreliable in assistive tech, and the refusal is announced by the text
          change either way — `.invUnitsRefused` carries the visual meaning. */}
      <p
        className={refused ? "invUnitsHint invUnitsRefused" : "invUnitsHint"}
        aria-live="polite"
      >
        {hint}
      </p>
    </div>
  );
}
