"use client";

/**
 * VARIANTE A — «Subsección con jerarquía».
 *
 * La lectura literal de #1548: la cartera es UNA fila del tablero, con el mismo
 * peso visual que cualquier otra, y un triángulo que despliega a sus miembros
 * indentados bajo un raíl. Los hijos se pintan en densidad reducida y SIN barra
 * de peso, para que se lean como desglose y no como sumandos nuevos: la barra
 * es el signo de «esto suma», y solo la cabecera la tiene.
 *
 * Apuesta: la jerarquía se entiende sola con indentación, sin caja ni marco.
 */

import { barColor, money, PlainRow, SubHead } from "./board-bits";
import type { Section, Unit } from "./grouping";
import styles from "./prototipo-cartera-grupo.module.css";
import type { VariantProps } from "./variant-props";

export const VARIANT_A_NAME = "Subsección con jerarquía";

function GroupRow({
  unit,
  sectionDenom,
  open,
  onToggle,
  banded,
}: {
  unit: Extract<Unit, { kind: "portfolio" }>;
  sectionDenom: number;
  open: boolean;
  onToggle: () => void;
  banded: boolean;
}) {
  return (
    <>
      <div className={`balanceRow${banded ? " band" : ""} ${styles.aGroupRow}`}>
        <div className="balanceRowName">
          <button className={styles.aToggle} onClick={onToggle} type="button">
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            {unit.name}
          </button>
          <div className="balanceRowSub">
            <span>{unit.portfolio.provider}</span>
            <span>· {unit.members.length} posiciones</span>
          </div>
        </div>
        <div className="balanceRowAmount">{money(unit.amountMinor)}</div>
        <span aria-hidden="true" className="balanceCalc">
          ⋯
        </span>
        <div className="balanceRowBar">
          <span
            style={{
              background: barColor(unit.tier, true),
              width: `${(unit.amountMinor / (sectionDenom || 1)) * 100}%`,
            }}
          />
        </div>
      </div>

      {open ? (
        <div className={styles.aRail}>
          {unit.members.map((member) => (
            <div className={styles.aChild} key={member.id}>
              <span className={styles.aChildName}>{member.name}</span>
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

export default function VariantA({ assets, liabilities, open, onToggle }: VariantProps) {
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
