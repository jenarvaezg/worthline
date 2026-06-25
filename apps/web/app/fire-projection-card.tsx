import { formatMoneyMinorPrivacy } from "@worthline/domain";
import type { FireProjection, FireScenario } from "@worthline/domain";

const SCENARIO_LABELS: Record<FireScenario["label"], string> = {
  optimistic: "Optimista",
  base: "Base",
  pessimistic: "Pesimista",
};

export default function FireProjectionCard({
  projection,
  currency,
  privacyMode,
}: {
  projection: FireProjection;
  currency: string;
  privacyMode: boolean;
}) {
  const byLabel = (label: FireScenario["label"]) =>
    projection.scenarios.find((scenario) => scenario.label === label);
  const base = byLabel("base");

  if (!base) {
    return null;
  }

  const ordered = (["optimistic", "base", "pessimistic"] as const)
    .map(byLabel)
    .filter((scenario): scenario is FireScenario => scenario !== undefined);

  const yearsLabel = (years: number | null) =>
    years === null ? "—" : `${years} ${years === 1 ? "año" : "años"}`;

  // Discrete yearly bars for the base trajectory.
  const points = base.trajectory;
  const target = projection.fireNumberMinor;
  const maxV =
    Math.max(target, ...points.map((point) => point.eligibleMinor)) * 1.05 || 1;
  const width = 320;
  const height = 110;
  const padBottom = 4;
  const padTop = 4;
  const plotH = height - padBottom - padTop;
  const slot = width / Math.max(points.length, 1);
  const barW = Math.max(2, slot * 0.6);
  const yOf = (value: number) => padTop + plotH - (Math.min(value, maxV) / maxV) * plotH;

  return (
    <div className="fireProjection">
      <div className="fireProjEyebrow">Alcanzas FIRE en</div>
      <div className="fireProjHeadline">
        {yearsLabel(base.yearsToFire)}
        {base.ageAtFire !== null ? <small> · a los {base.ageAtFire} años</small> : null}
      </div>

      <div className="fireScenarios">
        {ordered.map((scenario) => (
          <div
            className={`fireScenario${scenario.label === "base" ? " base" : ""}`}
            key={scenario.label}
          >
            <h4>{SCENARIO_LABELS[scenario.label]}</h4>
            <div className="fireScenarioYears">{yearsLabel(scenario.yearsToFire)}</div>
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

      <svg
        className="fireTrajectory"
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
        <line
          className="fireTarget"
          x1={0}
          x2={width}
          y1={yOf(target)}
          y2={yOf(target)}
        />
      </svg>
    </div>
  );
}
