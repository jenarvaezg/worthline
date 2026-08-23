"use client";

/**
 * VARIANTE D — «Sección propia por encima de los ejes».
 *
 * Lleva «la cartera manda sobre los ejes» hasta el final: las carteras
 * gestionadas ni siquiera compiten dentro del eje elegido. Salen de él y se
 * agrupan en una sección fija en cabeza del panel de activos —«Carteras
 * gestionadas»— igual con Liquidez que con Instrumento. Debajo, el eje reparte
 * lo que queda, ya sin carteras que colocar.
 *
 * El desglose no son filas: son fichas de composición (nombre + peso), porque
 * aquí la cartera ya está dicha como bloque y lo que falta es su reparto.
 *
 * Apuesta: la pregunta «¿en qué bucket cae la Metal?» no tiene buena respuesta,
 * así que se elimina la pregunta. Cuesta que el eje deje de ser exhaustivo.
 */

import { money, PlainRow, pct, SubHead } from "./board-bits";
import type { Section, Unit } from "./grouping";
import styles from "./prototipo-cartera-grupo.module.css";
import type { VariantProps } from "./variant-props";

export const VARIANT_D_NAME = "Sección propia sobre los ejes";

type PortfolioUnit = Extract<Unit, { kind: "portfolio" }>;

function isPortfolio(unit: Unit): unit is PortfolioUnit {
  return unit.kind === "portfolio";
}

function PortfolioBlock({
  unit,
  open,
  onToggle,
}: {
  unit: PortfolioUnit;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.dBlock}>
      <div className="balanceRow">
        <div className="balanceRowName">
          <button className={styles.dToggle} onClick={onToggle} type="button">
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            {unit.name}
          </button>
          <div className="balanceRowSub">
            <span>{unit.portfolio.provider}</span>
            <span>· {unit.members.length} posiciones</span>
            <span>· deriva {pct(unit.drift, 2)}</span>
          </div>
        </div>
        <div className="balanceRowAmount">{money(unit.amountMinor)}</div>
        <span aria-hidden="true" className="balanceCalc">
          ⋯
        </span>
      </div>
      {open ? (
        <div className={styles.dChips}>
          {unit.members.map((member) => (
            <span className={styles.dChip} key={member.id}>
              <span className={styles.dChipName}>{member.name}</span>
              <span className={styles.dChipWeight}>
                {pct(member.amountMinor / (unit.amountMinor || 1))}
              </span>
            </span>
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
  hoisted,
  open,
  onToggle,
}: {
  sections: Section[];
  isAsset: boolean;
  title: string;
  hoisted: PortfolioUnit[];
  open: boolean;
  onToggle: () => void;
}) {
  const hoistedTotal = hoisted.reduce((sum, u) => sum + u.amountMinor, 0);
  const total = sections.reduce((sum, s) => sum + s.totalMinor, 0) + hoistedTotal;
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

      {hoisted.length > 0 ? (
        <div className={styles.dHoist}>
          <div className={styles.dHoistHead}>
            <span>Carteras gestionadas</span>
            <span className="balanceSubTotal">{money(hoistedTotal)}</span>
          </div>
          {hoisted.map((unit) => (
            <PortfolioBlock key={unit.id} onToggle={onToggle} open={open} unit={unit} />
          ))}
        </div>
      ) : null}

      {sections.map((section) => (
        <div key={section.key}>
          {sections.length > 1 || hoisted.length > 0 ? (
            <SubHead
              isAsset={isAsset}
              label={section.label}
              tier={section.tier}
              totalMinor={section.totalMinor}
            />
          ) : null}
          {section.units.map((unit) => (
            <PlainRow
              amountMinor={unit.amountMinor}
              banded={band++ % 2 === 1}
              derived={unit.kind === "row" ? unit.derived : false}
              isAsset={isAsset}
              key={unit.id}
              name={unit.name}
              note={unit.kind === "row" ? unit.note : undefined}
              sectionDenom={section.totalMinor}
              tier={unit.tier}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function VariantD({ assets, liabilities, open, onToggle }: VariantProps) {
  const hoisted = assets.flatMap((section) => section.units.filter(isPortfolio));
  const rest = assets
    .map((section) => {
      const units = section.units.filter((unit) => !isPortfolio(unit));
      return {
        ...section,
        totalMinor: units.reduce((sum, u) => sum + u.amountMinor, 0),
        units,
      };
    })
    .filter((section) => section.units.length > 0);

  return (
    <section aria-label="Activos y pasivos" className="balanceBoard">
      <Pane
        hoisted={hoisted}
        isAsset
        onToggle={onToggle}
        open={open}
        sections={rest}
        title="Activos"
      />
      <Pane
        hoisted={[]}
        isAsset={false}
        onToggle={onToggle}
        open={open}
        sections={liabilities}
        title="Pasivos"
      />
    </section>
  );
}
