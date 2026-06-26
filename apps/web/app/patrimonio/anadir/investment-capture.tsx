"use client";

/**
 * The "saldo de hoy" capture island (#597, PRD #593 S2). The wizard is otherwise
 * server-rendered with CSS-`:has()` disclosure (ADR 0009), but this one field
 * earns a client island: it shows `≈ participaciones` live **as you type** the
 * euro balance (an explicit acceptance criterion). It owns the saldo + price
 * inputs so the hint reacts to both — the price prefilled from the picked symbol's
 * live quote, or typed by hand when search found nothing (the manual fallback).
 *
 * The derivation is `previewOpeningUnits` — the SAME pure helper the server action
 * uses to record the opening BUY, so the preview can never drift from what gets
 * persisted (units = saldo ÷ precio).
 */

import { useState } from "react";

import { previewOpeningUnits } from "./investment-units";

export function InvestmentCapture({
  defaultPrice,
  defaultSaldo,
  instrument,
  priceHint,
}: {
  instrument: string;
  defaultPrice: string;
  defaultSaldo: string;
  priceHint?: string | undefined;
}) {
  const [saldo, setSaldo] = useState(defaultSaldo);
  const [price, setPrice] = useState(defaultPrice);

  const units = previewOpeningUnits(saldo, price);

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
      <p className="invUnitsHint" aria-live="polite">
        {units
          ? `≈ ${Number.parseFloat(units).toLocaleString("es-ES", {
              maximumFractionDigits: 6,
            })} participaciones`
          : "Escribe el saldo para ver las participaciones."}
      </p>
    </div>
  );
}
