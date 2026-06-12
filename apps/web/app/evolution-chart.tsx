import { deriveMonthlyCloses, formatMoneyMinor } from "@worthline/domain";
import type { NetWorthFraming, NetWorthSnapshot } from "@worthline/domain";

/**
 * Server-rendered SVG area chart of the headline figure over the snapshot
 * history (ADR 0009), with value/date axes so the curve is interpretable
 * without interaction. Zero client JS — hover values use native <title>.
 *
 * Fixed aspect ratio (no preserveAspectRatio="none") so axis text never
 * stretches; the chart scales down proportionally on narrow viewports.
 */

const W = 720;
const H = 240;
const MARGIN = { top: 14, right: 16, bottom: 30, left: 64 };
const Y_TICKS = 4;

/** Compact axis label: 2.555.400 (minor) → "25,6 k€"; 32.000 → "320 €". */
function formatCompactEur(amountMinor: number): string {
  const euros = amountMinor / 100;

  if (Math.abs(euros) < 1000) return `${Math.round(euros)} €`;

  return `${(euros / 1000).toFixed(1).replace(".", ",")} k€`;
}

const SHORT_MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

/** "2026-06-12" → "12 jun 26". */
function formatShortDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-");

  return `${Number(day)} ${SHORT_MONTHS[Number(month) - 1] ?? ""} ${year?.slice(2) ?? ""}`;
}

export default function EvolutionChart({
  framing,
  snapshots,
}: {
  framing: NetWorthFraming;
  snapshots: NetWorthSnapshot[];
}) {
  const monthlyCloseIds = new Set(deriveMonthlyCloses(snapshots).values());
  const points = [...snapshots]
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
    .map((snapshot) => ({
      dateKey: snapshot.dateKey,
      isMonthlyClose: monthlyCloseIds.has(snapshot.id),
      valueMinor:
        framing === "liquid"
          ? snapshot.liquidNetWorth.amountMinor
          : snapshot.totalNetWorth.amountMinor,
    }));

  if (points.length < 2) {
    return (
      <p className="emptyLine evolutionEmpty">
        La evolución aparecerá cuando haya más capturas.
      </p>
    );
  }

  const currency = snapshots[0]!.totalNetWorth.currency;
  const seriesLabel = framing === "liquid" ? "patrimonio líquido" : "patrimonio neto";

  const values = points.map((point) => point.valueMinor);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax) * 0.02, 100);
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;

  const innerW = W - MARGIN.left - MARGIN.right;
  const innerH = H - MARGIN.top - MARGIN.bottom;
  const x = (index: number) => MARGIN.left + (index / (points.length - 1)) * innerW;
  const y = (value: number) =>
    MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * innerH;

  const yTicks = Array.from(
    { length: Y_TICKS },
    (_, i) => yMin + ((i + 0.5) / Y_TICKS) * (yMax - yMin),
  );
  // X ticks: first, middle, last — deduplicated to avoid React key warnings
  // when few points exist (e.g. 2 points → [0, 0, 1] would duplicate key 0).
  const xTickIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  const line = points.map(
    (point, i) => `${x(i).toFixed(1)},${y(point.valueMinor).toFixed(1)}`,
  );
  const area = [
    `${MARGIN.left},${MARGIN.top + innerH}`,
    ...line,
    `${MARGIN.left + innerW},${MARGIN.top + innerH}`,
  ].join(" ");

  return (
    <svg
      className="evolutionChart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Evolución del ${seriesLabel} en el tiempo`}
    >
      <defs>
        <linearGradient id="evolutionFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {yTicks.map((tick) => (
        <g key={tick}>
          <line
            stroke="var(--ink)"
            strokeDasharray="2 4"
            strokeOpacity="0.1"
            x1={MARGIN.left}
            x2={MARGIN.left + innerW}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text
            fill="var(--muted)"
            fontSize="10.5"
            textAnchor="end"
            x={MARGIN.left - 8}
            y={y(tick) + 3.5}
          >
            {formatCompactEur(tick)}
          </text>
        </g>
      ))}

      {xTickIndexes.map((index) => (
        <text
          fill="var(--muted)"
          fontSize="10.5"
          key={index}
          textAnchor={
            index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"
          }
          x={x(index)}
          y={H - 10}
        >
          {formatShortDate(points[index]!.dateKey)}
        </text>
      ))}

      <polygon points={area} fill="url(#evolutionFill)" />
      <polyline
        points={line.join(" ")}
        fill="none"
        stroke="var(--ink)"
        strokeWidth="1.8"
        vectorEffect="non-scaling-stroke"
      />

      {points.map((point, index) => (
        <circle
          className={point.isMonthlyClose ? "evolutionMarker" : "evolutionPoint"}
          cx={x(index)}
          cy={y(point.valueMinor)}
          fill="var(--ink)"
          key={point.dateKey}
          r={point.isMonthlyClose ? 3.5 : 2.25}
        >
          {/* React requires <title> children to be ONE string — an array of
              text nodes hydrates differently than it server-renders. */}
          <title>
            {`${point.dateKey} · ${formatMoneyMinor({ amountMinor: point.valueMinor, currency })}`}
          </title>
        </circle>
      ))}
    </svg>
  );
}
