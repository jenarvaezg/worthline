"use client";

/**
 * VARIANTE E — «La mezcla» (veredicto de Jose, 23-08).
 *
 * Base **A**: la cartera es UNA fila del tablero, con el mismo peso visual que
 * cualquier otra, y un triángulo que indenta a sus miembros bajo un raíl.
 * De **C** se trae el chip «CARTERA», que dice lo que la fila es sin gastar
 * palabras ni obligar a desplegar. De **B**, la lectura del reparto: la barra
 * de la fila deja de ser un bloque liso y se **divide en segmentos, uno por
 * miembro**.
 *
 * La barra de la fila conserva su único significado de siempre —cuánto pesa
 * esta fila en su sección—; lo que cambia es que ahora, además, enseña por
 * dentro cómo está repartida. Al desplegar, una segunda barra a ancho completo
 * reescala ese mismo reparto al 100 % de la cartera, que es la escala en la que
 * los porcentajes de los hijos se pueden leer.
 */

import Link from "next/link";

import { barColor, money, PlainRow, pct, SubHead } from "./board-bits";
import type { Section, Unit } from "./grouping";
import styles from "./prototipo-cartera-grupo.module.css";
import type { VariantProps } from "./variant-props";

export const VARIANT_E_NAME = "La mezcla: A + chip de C + divisiones de B";

type PortfolioUnit = Extract<Unit, { kind: "portfolio" }>;

/** Los segmentos del reparto interno, en una escala u otra. */
function Segments({ unit, scaleMinor }: { unit: PortfolioUnit; scaleMinor: number }) {
  return unit.members.map((member) => (
    <span
      className={styles.eSeg}
      key={member.id}
      style={{
        // El color lo pone el escalón del miembro y nada más (design-system §5):
        // una rampa de opacidad por tamaño sería color decorativo en un tablero
        // donde el color significa liquidez. Las divisiones las hacen las
        // separaciones, no el tono.
        background: barColor(member.tier, true),
        // Sin min-width: un suelo por segmento hace que 8 miembros ocupen 8 px
        // en una barra de 3 px y el recorte se coma los últimos. Que un miembro
        // diminuto desaparezca es más honesto que una barra desproporcionada.
        width: `${(member.amountMinor / (scaleMinor || 1)) * 100}%`,
      }}
      title={`${member.name} · ${money(member.amountMinor)}`}
    />
  ));
}

function GroupRow({
  unit,
  sectionDenom,
  open,
  onToggle,
  banded,
}: {
  unit: PortfolioUnit;
  sectionDenom: number;
  open: boolean;
  onToggle: () => void;
  banded: boolean;
}) {
  const weight = unit.amountMinor / (sectionDenom || 1);

  return (
    <>
      <div className={`balanceRow${banded ? " band" : ""}`}>
        <div className="balanceRowName">
          {/* El triángulo despliega; el NOMBRE navega a la ficha de cartera
              (S1, #1547). Si el nombre entero fuese el toggle, el grupo se
              comería la puerta que S1 acaba de construir. */}
          <span className={styles.eNameRow}>
            <button
              aria-expanded={open}
              aria-label={open ? "Colapsar la cartera" : "Expandir la cartera"}
              className={styles.eCaret}
              onClick={onToggle}
              type="button"
            >
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            </button>
            <Link href={`/patrimonio/carteras/${unit.id}`}>{unit.name}</Link>
          </span>
          <div className="balanceRowSub">
            <span className={styles.cChip}>cartera</span>
            <span>
              {unit.portfolio.provider} · {unit.members.length} posiciones
            </span>
          </div>
        </div>
        <div className="balanceRowAmount">{money(unit.amountMinor)}</div>
        <span aria-hidden="true" className="balanceCalc">
          ⋯
        </span>
        {/* La barra sigue diciendo lo de siempre —el peso de la fila en su
            sección— pero dividida por miembros: el reparto se lee sin abrir. */}
        <div className="balanceRowBar">
          <span className={styles.eSegBar} style={{ width: `${weight * 100}%` }}>
            <Segments scaleMinor={unit.amountMinor} unit={unit} />
          </span>
        </div>
      </div>

      {open ? (
        <div className={styles.aRail}>
          {/* Mismo reparto, reescalado al 100 % de la cartera: es la escala en la
              que los porcentajes de abajo se pueden comprobar con el ojo. */}
          <div
            aria-label={`Composición de ${unit.name}`}
            className={styles.eInnerBar}
            role="img"
          >
            <Segments scaleMinor={unit.amountMinor} unit={unit} />
          </div>
          {unit.members.map((member) => (
            <div className={styles.eChild} key={member.id}>
              <span className={styles.aChildName}>{member.name}</span>
              <span className={styles.eChildWeight}>
                {pct(member.amountMinor / (unit.amountMinor || 1))}
              </span>
              <span className={styles.aChildAmount}>{money(member.amountMinor)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Pane({
  sections,
  isAsset,
  title,
  open,
  onToggle,
}: {
  sections: Section[];
  isAsset: boolean;
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  const total = sections.reduce((sum, s) => sum + s.totalMinor, 0);
  let band = 0;

  return (
    <div className={`balancePane ${isAsset ? "" : "balancePaneDebt debitCol"}`}>
      <div className="balancePaneHead">
        <div className="balancePaneTop">
          <h3>{title}</h3>
          <span className="balancePaneTotal totalRule">
            {isAsset ? money(total) : `− ${money(total)}`}
          </span>
        </div>
      </div>
      {sections.map((section) => (
        <div key={section.key}>
          {sections.length > 1 ? (
            <SubHead
              isAsset={isAsset}
              label={section.label}
              tier={section.tier}
              totalMinor={section.totalMinor}
            />
          ) : null}
          {section.units.map((unit) =>
            unit.kind === "portfolio" ? (
              <GroupRow
                banded={band++ % 2 === 1}
                key={unit.id}
                onToggle={onToggle}
                open={open}
                sectionDenom={section.totalMinor}
                unit={unit}
              />
            ) : (
              <PlainRow
                amountMinor={unit.amountMinor}
                banded={band++ % 2 === 1}
                derived={unit.derived}
                isAsset={isAsset}
                key={unit.id}
                name={unit.name}
                note={unit.note}
                sectionDenom={section.totalMinor}
                tier={unit.tier}
              />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

export default function VariantE({ assets, liabilities, open, onToggle }: VariantProps) {
  return (
    <section aria-label="Activos y pasivos" className="balanceBoard">
      <Pane isAsset onToggle={onToggle} open={open} sections={assets} title="Activos" />
      <Pane
        isAsset={false}
        onToggle={onToggle}
        open={open}
        sections={liabilities}
        title="Pasivos"
      />
    </section>
  );
}
