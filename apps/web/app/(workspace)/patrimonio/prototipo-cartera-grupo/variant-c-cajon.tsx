"use client";

/**
 * VARIANTE C — «Fila opaca + cajón».
 *
 * La cartera es una fila normal y corriente, indistinguible de un fondo salvo
 * por un chip discreto: la lista NUNCA cambia de forma ni de altura. El
 * desglose no se despliega hacia dentro, se abre en un cajón a pie de tablero,
 * ancho completo, donde caben las tres columnas (valor, peso, testigo) que en
 * media columna no caben.
 *
 * Apuesta: el invariante «Σ filas = bruto» se defiende solo si una cartera es
 * siempre exactamente una fila. Renuncia a la jerarquía visual y se apoya en el
 * cajón (y, en producción, en la ficha) para todo lo demás.
 *
 * Aprendido probándola: el cajón nace lejos de la fila que lo abre —con un
 * tablero de altura normal cae fuera de la vista y el botón parece muerto—, así
 * que la variante SOLO es honesta si al abrirse lleva la vista al cajón y deja
 * la fila marcada mientras está abierto. Ese acompañamiento es parte de la
 * propuesta, no un adorno: si al implementarla se olvida, la variante no
 * funciona.
 */

import { useEffect, useRef } from "react";

import { money, PlainRow, pct, SubHead } from "./board-bits";
import type { Section, Unit } from "./grouping";
import styles from "./prototipo-cartera-grupo.module.css";
import type { VariantProps } from "./variant-props";

export const VARIANT_C_NAME = "Fila opaca + cajón";

function PortfolioRow({
  unit,
  sectionDenom,
  banded,
  open,
  onToggle,
}: {
  unit: Extract<Unit, { kind: "portfolio" }>;
  sectionDenom: number;
  banded: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`balanceRow${banded ? " band" : ""}`}>
      <div className="balanceRowName">
        <span className={open ? styles.cActiveName : undefined}>{unit.name}</span>
        <div className="balanceRowSub">
          <span className={styles.cChip}>cartera</span>
          <span>
            {unit.portfolio.provider} · {unit.members.length} posiciones
          </span>
        </div>
      </div>
      <div className="balanceRowAmount">{money(unit.amountMinor)}</div>
      <button
        aria-expanded={open}
        className={styles.cOpen}
        onClick={onToggle}
        type="button"
      >
        {open ? "desglose ▴" : "desglose ▾"}
      </button>
      <div className="balanceRowBar">
        <span
          style={{
            background: `var(--tier-${unit.tier})`,
            width: `${(unit.amountMinor / (sectionDenom || 1)) * 100}%`,
          }}
        />
      </div>
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
              <PortfolioRow
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

export default function VariantC({ assets, liabilities, open, onToggle }: VariantProps) {
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Sin esto el botón parece no hacer nada: el cajón se abre por debajo del
  // tablero, fuera de la vista.
  useEffect(() => {
    if (open) drawerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [open]);

  const portfolios = assets
    .flatMap((section) => section.units)
    .filter((unit): unit is Extract<Unit, { kind: "portfolio" }> => {
      return unit.kind === "portfolio";
    });

  return (
    <>
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

      {open
        ? portfolios.map((unit) => (
            <div className={styles.cDrawer} key={unit.id} ref={drawerRef}>
              <div className={styles.cDrawerHead}>
                <div>
                  <strong>{unit.name}</strong>
                  <div className="balanceRowSub">
                    {unit.portfolio.provider} · testigo{" "}
                    {money(unit.portfolio.declaredMinor)} ({unit.portfolio.declaredAt}) ·
                    deriva {pct(unit.drift, 2)}
                  </div>
                </div>
                <span className="balancePaneTotal totalRule">
                  {money(unit.amountMinor)}
                </span>
              </div>
              <div className={styles.cTable}>
                {unit.members.map((member) => (
                  <div className={styles.cTableRow} key={member.id}>
                    <span>{member.name}</span>
                    <span>{pct(member.amountMinor / (unit.amountMinor || 1))}</span>
                    <span>{money(member.amountMinor)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        : null}
    </>
  );
}
