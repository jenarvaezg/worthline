"use client";

/**
 * VARIANTE B — «Mini-panel anidado».
 *
 * La cartera no es una fila: es un panel dentro del panel, con su propia
 * cabecera, su total y —lo que la distingue— su **barra de composición propia,
 * visible incluso cerrada**. La forma de la cartera (7 fondos y un pico de
 * efectivo) se lee sin desplegar nada; desplegar solo añade nombres y pesos.
 *
 * Apuesta: lo que el titular quiere saber de una cartera gestionada no es la
 * lista de fondos, es en qué está repartida. Cuesta el ritmo de la lista: el
 * tablero deja de ser filas homogéneas y mete un objeto con marco.
 */

import { barColor, money, PlainRow, pct, SubHead } from "./board-bits";
import type { Section, Unit } from "./grouping";
import styles from "./prototipo-cartera-grupo.module.css";
import type { VariantProps } from "./variant-props";

export const VARIANT_B_NAME = "Mini-panel anidado";

function Card({
  unit,
  open,
  onToggle,
}: {
  unit: Extract<Unit, { kind: "portfolio" }>;
  open: boolean;
  onToggle: () => void;
}) {
  const total = unit.amountMinor || 1;

  return (
    <div className={styles.bCard}>
      <div className={styles.bHead}>
        <div className={styles.bTitle}>
          <strong>{unit.name}</strong>
          <div className="balanceRowSub">
            <span>{unit.portfolio.provider}</span>
            <span>· {unit.members.length} posiciones</span>
            <span>
              · testigo {money(unit.portfolio.declaredMinor)} ({unit.portfolio.declaredAt}
              )
            </span>
          </div>
        </div>
        <span className={styles.bTotal}>{money(unit.amountMinor)}</span>
      </div>

      <div aria-label={`Composición de ${unit.name}`} className={styles.bBar} role="img">
        {unit.members.map((member, index) => (
          <span
            className={styles.bSeg}
            key={member.id}
            style={{
              background: barColor(member.tier, true),
              opacity: 1 - Math.min(index, 7) * 0.09,
              width: `${(member.amountMinor / total) * 100}%`,
            }}
            title={`${member.name} · ${money(member.amountMinor)}`}
          />
        ))}
      </div>

      <button className={styles.bMore} onClick={onToggle} type="button">
        {open ? "Ocultar composición ▴" : `Ver composición (${unit.members.length}) ▾`}
      </button>

      {open ? (
        <div className={styles.bRows}>
          {unit.members.map((member) => (
            <div className={styles.bRow} key={member.id}>
              <span>{member.name}</span>
              <span className={styles.bWeight}>{pct(member.amountMinor / total)}</span>
              <span>{money(member.amountMinor)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
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
              <Card key={unit.id} onToggle={onToggle} open={open} unit={unit} />
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

export default function VariantB({ assets, liabilities, open, onToggle }: VariantProps) {
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
