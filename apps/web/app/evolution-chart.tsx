import {
  buildEvolutionChartGeometry,
  deriveMonthlyCloses,
  formatMoneyMinor,
} from "@worthline/domain";
import type { NetWorthFraming, NetWorthSnapshot } from "@worthline/domain";

/**
 * Server-rendered SVG area chart of the headline figure over the snapshot
 * history (ADR 0009). Geometry comes from the domain package; this component
 * only assembles dumb SVG. Zero client JS — hover values use native <title>.
 */
export default function EvolutionChart({
  framing,
  snapshots,
}: {
  framing: NetWorthFraming;
  snapshots: NetWorthSnapshot[];
}) {
  const monthlyCloseIds = new Set(deriveMonthlyCloses(snapshots).values());
  const points = snapshots.map((snapshot) => ({
    dateKey: snapshot.dateKey,
    isMonthlyClose: monthlyCloseIds.has(snapshot.id),
    valueMinor:
      framing === "liquid"
        ? snapshot.liquidNetWorth.amountMinor
        : snapshot.totalNetWorth.amountMinor,
  }));

  const geometry = buildEvolutionChartGeometry(points);

  if (!geometry) {
    return (
      <p className="emptyLine evolutionEmpty">
        La evolución aparecerá cuando haya más capturas.
      </p>
    );
  }

  // A geometry implies >= 2 snapshots, so the first one exists.
  const currency = snapshots[0]!.totalNetWorth.currency;
  const seriesLabel = framing === "liquid" ? "patrimonio líquido" : "patrimonio neto";

  return (
    <svg
      className="evolutionChart"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      role="img"
      aria-label={`Evolución del ${seriesLabel} en el tiempo`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="evolutionFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={geometry.areaPoints} fill="url(#evolutionFill)" />
      <polyline
        points={geometry.linePoints}
        fill="none"
        stroke="var(--ink)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      {geometry.markers.map((marker) => (
        <circle
          className="evolutionMarker"
          cx={marker.x}
          cy={marker.y}
          fill="var(--ink)"
          key={marker.dateKey}
          r="3.5"
        >
          {/* React requires <title> children to be ONE string — an array of
              text nodes hydrates differently than it server-renders. */}
          <title>
            {`${marker.dateKey} · ${formatMoneyMinor({ amountMinor: marker.valueMinor, currency })}`}
          </title>
        </circle>
      ))}
    </svg>
  );
}
