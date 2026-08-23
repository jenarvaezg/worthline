"use client";

/**
 * PROTOTIPO (#1548) — las piezas que las cuatro variantes comparten sin
 * discutir: cómo se escribe un euro, de qué color va una barra y cómo se pinta
 * una fila SUELTA (las que no son cartera). Todo lo demás — el panel, la
 * sección, y sobre todo el grupo — lo decide cada variante por su cuenta.
 *
 * Las clases son las de producción (`balanceRow`, `balancePane`… de globals.css)
 * a propósito: la pregunta es cómo cae el grupo en el tablero real, y con CSS
 * inventado cualquier variante parece buena.
 */

import type { Tier } from "./fixture";

const MONEY = new Intl.NumberFormat("es-ES", {
  currency: "EUR",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

export function money(amountMinor: number): string {
  return MONEY.format(amountMinor / 100);
}

export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits).replace(".", ",")} %`;
}

export function barColor(tier: Tier, isAsset: boolean): string {
  return isAsset ? `var(--tier-${tier})` : "var(--debit-rule)";
}

/** Una fila suelta del tablero, calcada de `HoldingRow` sin sus acciones. */
export function PlainRow({
  amountMinor,
  banded,
  derived,
  isAsset,
  name,
  note,
  sectionDenom,
  tier,
}: {
  amountMinor: number;
  banded: boolean;
  derived: boolean;
  isAsset: boolean;
  name: string;
  note?: string | undefined;
  sectionDenom: number;
  tier: Tier;
}) {
  return (
    <div className={`balanceRow${banded ? " band" : ""}`}>
      <div className="balanceRowName">
        <span>{name}</span>
        {note ? <div className="balanceRowSub">{note}</div> : null}
      </div>
      <div className="balanceRowAmount">
        {derived ? <abbr className="balanceCalc">≈</abbr> : null}
        {isAsset ? money(amountMinor) : `− ${money(amountMinor)}`}
      </div>
      <span aria-hidden="true" className="balanceCalc">
        ⋯
      </span>
      <div className="balanceRowBar">
        <span
          style={{
            background: barColor(tier, isAsset),
            width: `${(amountMinor / (sectionDenom || 1)) * 100}%`,
          }}
        />
      </div>
    </div>
  );
}

/** La cabecera de subsección del tablero real (punto de color + total). */
export function SubHead({
  label,
  tier,
  isAsset,
  totalMinor,
}: {
  label: string;
  tier: Tier;
  isAsset: boolean;
  totalMinor: number;
}) {
  return (
    <div className="balanceSub">
      <span className="balanceSubLabel">
        <span className="balanceDot" style={{ background: barColor(tier, isAsset) }} />
        {label}
      </span>
      <span className="balanceSubTotal">{money(totalMinor)}</span>
    </div>
  );
}
