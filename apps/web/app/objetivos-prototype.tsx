/**
 * S0 PROTOTYPE (throwaway, PRD #507) — ?variant=objetivos
 *
 * Renders the proposed /objetivos page (FIRE as star + goals below) with the
 * user's REAL FIRE data. Goal cards are EXAMPLES (the "+X meses" metric is S4).
 * Not wired to nav, no tests. Delete this file + its .module.css + the
 * ?variant hook in dashboard-content.tsx to remove.
 */
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import type { FireProjection, FireScenario } from "@worthline/domain";
import Link from "next/link";

import styles from "./objetivos-prototype.module.css";

type Money = { amountMinor: number; currency: string };

type ProtoFireResult = {
  percentFunded: number;
  fireNumber: Money;
  eligibleAssets: Money;
  reservedForGoals?: Money;
  coastFireRequired?: Money | null;
  coastFireAge?: number;
  isAlreadyAtCoastFire?: boolean;
};

const SCENARIO_LABELS: Record<FireScenario["label"], string> = {
  optimistic: "Optimista",
  base: "Base",
  pessimistic: "Pesimista",
};

const EXAMPLE_GOALS = [
  {
    name: "Coche nuevo",
    priority: "media" as const,
    reserved: "15.000 €",
    target: "25.000 €",
    deadline: "2027",
    fundedPct: 60,
    impact: "FIRE +4 meses",
  },
  {
    name: "Fondo de emergencia",
    priority: "alta" as const,
    reserved: "18.000 €",
    target: "18.000 €",
    deadline: "sin fecha",
    fundedPct: 100,
    impact: "FIRE +5 meses",
  },
  {
    name: "Reforma cocina",
    priority: "baja" as const,
    reserved: "25.000 €",
    target: "28.000 €",
    deadline: "2028",
    fundedPct: 89,
    impact: "FIRE +7 meses",
  },
];

function yearsLabel(years: number | null): string {
  return years === null ? "—" : `${years} ${years === 1 ? "año" : "años"}`;
}

function Trajectory({ projection }: { projection: FireProjection }) {
  const base = projection.scenarios.find((s) => s.label === "base");
  if (!base) {
    return null;
  }
  const points = base.trajectory;
  const target = projection.fireNumberMinor;
  const maxV = Math.max(target, ...points.map((p) => p.eligibleMinor)) * 1.05 || 1;
  const width = 320;
  const height = 150;
  const padTop = 4;
  const padBottom = 4;
  const plotH = height - padTop - padBottom;
  const slot = width / Math.max(points.length, 1);
  const barW = Math.max(2, slot * 0.6);
  const yOf = (v: number) => padTop + plotH - (Math.min(v, maxV) / maxV) * plotH;
  return (
    <svg
      className={`fireTrajectory ${styles.bigTrajectory}`}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Trayectoria anual del capital elegible hacia el número FIRE (escenario base)"
    >
      {points.map((point, index) => {
        const cx = slot * index + slot / 2;
        const top = yOf(point.eligibleMinor);
        return (
          <rect
            className={point.eligibleMinor >= target ? "reached" : undefined}
            height={padTop + plotH - top}
            key={point.year}
            rx={1}
            width={barW}
            x={cx - barW / 2}
            y={top}
          />
        );
      })}
      <line className="fireTarget" x1={0} x2={width} y1={yOf(target)} y2={yOf(target)} />
    </svg>
  );
}

function etaYears(projection: FireProjection, targetMinor: number): number | null {
  const base = projection.scenarios.find((s) => s.label === "base");
  if (!base || base.trajectory.length === 0) {
    return null;
  }
  if (base.trajectory[0]!.eligibleMinor >= targetMinor) {
    return 0;
  }
  const hit = base.trajectory.find((p) => p.eligibleMinor >= targetMinor);
  return hit ? hit.year : null;
}

export default function ObjetivosPrototype({
  currency,
  fireProjection,
  fireResult,
  privacyMode,
}: {
  currency: string;
  fireProjection: FireProjection | null;
  fireResult: ProtoFireResult | null;
  privacyMode: boolean;
}) {
  const ordered = fireProjection
    ? (["optimistic", "base", "pessimistic"] as const)
        .map((label) => fireProjection.scenarios.find((s) => s.label === label))
        .filter((s): s is FireScenario => s !== undefined)
    : [];

  const tickLeft =
    fireResult?.coastFireRequired && fireResult.fireNumber.amountMinor > 0
      ? Math.min(
          100,
          (fireResult.coastFireRequired.amountMinor / fireResult.fireNumber.amountMinor) *
            100,
        )
      : null;

  const regularMinor = fireResult?.fireNumber.amountMinor ?? 0;
  const levels = [
    {
      key: "lean",
      label: "Lean",
      targetMinor: Math.round(regularMinor * 0.7),
      hint: "gasto ×0,7",
    },
    { key: "regular", label: "Regular", targetMinor: regularMinor, hint: "tu nº FIRE" },
    {
      key: "fat",
      label: "Fat",
      targetMinor: Math.round(regularMinor * 1.5),
      hint: "gasto ×1,5",
    },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.banner}>
        ⚠ Prototipo S0 (throwaway) · <code>?variant=objetivos</code> · datos FIRE reales,
        objetivos de ejemplo
      </div>

      <header className={styles.header}>
        <h1>Objetivos</h1>
        <p>A dónde vas · tu independencia financiera y tus metas con fecha</p>
      </header>

      {fireResult ? (
        <section className={styles.heroPanel} aria-label="FIRE">
          <div className="panelHeader">
            <h2>Independencia financiera · FIRE</h2>
            <span className={styles.sub}>tu objetivo estrella</span>
          </div>
          <div className={styles.heroGrid}>
            <div className={styles.heroLeft}>
              <p className="fireBig">
                {fireResult.percentFunded.toFixed(1).replace(".", ",")} %
              </p>
              <div className="fireBar">
                {tickLeft !== null ? (
                  <span
                    aria-hidden="true"
                    className="fireTick"
                    style={{ left: `${tickLeft}%` }}
                  />
                ) : null}
                <i
                  style={{
                    width: `${Math.min(100, Math.max(0, fireResult.percentFunded))}%`,
                  }}
                />
              </div>
              {fireResult.percentFunded >= 100 ? (
                <span className="statePill ready">FIRE alcanzado</span>
              ) : fireResult.isAlreadyAtCoastFire ? (
                <span className="statePill ready">Coast FIRE alcanzado</span>
              ) : null}
              {tickLeft !== null ? (
                <p className={styles.coastNote}>
                  El tick ▏ de la barra marca <b>Coast FIRE</b> (
                  {tickLeft.toFixed(1).replace(".", ",")} %): con eso hoy, sin aportar un
                  euro más, el interés compuesto te lleva a tu número FIRE para tu
                  jubilación.
                </p>
              ) : null}
              <div className={styles.heroMetrics}>
                <div className="fireMetric">
                  <span>Número FIRE</span>
                  <strong>
                    {formatMoneyMinorPrivacy(fireResult.fireNumber, privacyMode)}
                  </strong>
                </div>
                <div className="fireMetric">
                  <span>Activos elegibles</span>
                  <strong>
                    {formatMoneyMinorPrivacy(fireResult.eligibleAssets, privacyMode)}
                  </strong>
                </div>
                {fireResult.coastFireRequired ? (
                  <div className="fireMetric">
                    <span>Coast requerido</span>
                    <strong>
                      {formatMoneyMinorPrivacy(fireResult.coastFireRequired, privacyMode)}
                    </strong>
                  </div>
                ) : null}
                {fireResult.coastFireAge !== undefined ? (
                  <div className="fireMetric">
                    <span>Edad Coast</span>
                    <strong>{fireResult.coastFireAge.toFixed(1)}</strong>
                  </div>
                ) : null}
              </div>
              <span className={styles.note}>▸ ¿Qué cuenta como elegible?</span>
            </div>

            <div className={styles.heroRight}>
              {fireProjection ? (
                <>
                  <div className="fireProjEyebrow">Alcanzas FIRE en</div>
                  <div className="fireProjHeadline">
                    {yearsLabel(
                      fireProjection.scenarios.find((s) => s.label === "base")
                        ?.yearsToFire ?? null,
                    )}
                    {(() => {
                      const age = fireProjection.scenarios.find(
                        (s) => s.label === "base",
                      )?.ageAtFire;
                      return age !== null && age !== undefined ? (
                        <small> · a los {age} años</small>
                      ) : null;
                    })()}
                  </div>
                  <div className="fireScenarios">
                    {ordered.map((scenario) => (
                      <div
                        className={`fireScenario${scenario.label === "base" ? " base" : ""}`}
                        key={scenario.label}
                      >
                        <h4>{SCENARIO_LABELS[scenario.label]}</h4>
                        <div className="fireScenarioYears">
                          {yearsLabel(scenario.yearsToFire)}
                        </div>
                        <div className="fireScenarioMeta">
                          {scenario.ageAtFire !== null ? (
                            <span>edad {scenario.ageAtFire}</span>
                          ) : null}
                          <span>
                            {formatMoneyMinorPrivacy(
                              { amountMinor: scenario.finalEligibleMinor, currency },
                              privacyMode,
                            )}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <Trajectory projection={fireProjection} />
                </>
              ) : (
                <p className={styles.sub}>Configura tu edad para ver la proyección.</p>
              )}
            </div>
          </div>
          {fireResult && fireProjection ? (
            <div className={styles.levelsStrip}>
              <div className="fireProjEyebrow">
                Niveles FIRE{" "}
                <span className={styles.sub}>
                  · Lean/Fat estimados (gasto ×0,7 / ×1,5)
                </span>
              </div>
              <div className={styles.levels}>
                <div
                  className={`${styles.levelChip} ${fireResult.isAlreadyAtCoastFire ? styles.reached : ""}`}
                >
                  <h4>Coast {fireResult.isAlreadyAtCoastFire ? "✓" : ""}</h4>
                  <div className={styles.levelVal}>
                    {fireResult.coastFireRequired
                      ? formatMoneyMinorPrivacy(fireResult.coastFireRequired, privacyMode)
                      : "—"}
                  </div>
                  <div className={styles.levelMeta}>
                    {fireResult.isAlreadyAtCoastFire
                      ? "ya puedes dejar de aportar"
                      : "sigue aportando"}
                  </div>
                </div>
                {levels.map((lvl) => {
                  const eta = etaYears(fireProjection, lvl.targetMinor);
                  return (
                    <div
                      className={`${styles.levelChip} ${eta === 0 ? styles.reached : ""} ${lvl.key === "regular" ? styles.regular : ""}`}
                      key={lvl.key}
                    >
                      <h4>{lvl.label}</h4>
                      <div className={styles.levelVal}>
                        {formatMoneyMinorPrivacy(
                          { amountMinor: lvl.targetMinor, currency },
                          privacyMode,
                        )}
                      </div>
                      <div className={styles.levelMeta}>
                        {eta === 0 ? "alcanzado" : eta !== null ? `en ~${eta} años` : "—"}{" "}
                        · {lvl.hint}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className={styles.heroFoot}>
            <span>Supuestos FIRE (retirada, retorno, edades) → en Ajustes</span>
            <Link className="panelAction" href="/ajustes">
              Configurar supuestos → Ajustes
            </Link>
          </div>
        </section>
      ) : (
        <section className={styles.heroPanel}>
          <p className={styles.sub}>FIRE no configurado en este ámbito.</p>
          <Link className="panelAction" href="/ajustes">
            Configurar → Ajustes
          </Link>
        </section>
      )}

      <section className={styles.heroPanel} aria-label="Objetivos">
        <div className={styles.goalsBar}>
          <div className={styles.goalsHeading}>
            <h2>Tus objetivos</h2>
            <p className={styles.sub}>
              reservan capital que se descuenta de FIRE · (ejemplos)
            </p>
          </div>
          <button className={styles.addBtn} type="button">
            + Nuevo objetivo
          </button>
        </div>
        <div className={styles.goalGrid}>
          {EXAMPLE_GOALS.map((goal) => (
            <div className={styles.goalCard} key={goal.name}>
              <div className={styles.goalTop}>
                <span className={styles.goalName}>{goal.name}</span>
                <span className={`${styles.prio} ${styles[goal.priority]}`}>
                  {goal.priority}
                </span>
              </div>
              <div className={styles.goalMeta}>
                <span>
                  <b>{goal.reserved}</b> / {goal.target}
                </span>
                <span>{goal.deadline}</span>
              </div>
              <div className={styles.fundedBar}>
                <i style={{ width: `${goal.fundedPct}%` }} />
              </div>
              <div className={styles.goalFooter}>
                <span className={styles.reserved}>
                  Reservado <b>{goal.reserved}</b>
                </span>
                <span className={styles.fireImpact}>{goal.impact}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
