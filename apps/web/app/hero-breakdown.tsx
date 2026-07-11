/**
 * Home hero "Origen del cambio" render (#661, PRD #653 S3) — variant B, the
 * "hoja con margen": a thin stacked micro-band under the delta chips (the monthly
 * split) and the compact "Esta semana" block in the margin. Server-rendered,
 * zero client JS (ADR 0009); the figures come pre-formatted from
 * `hero-breakdown-data`. Colours are the canon /historico bands
 * (--tier-market / --gold / --blue).
 */

import type {
  FormattedHeroBand,
  FormattedHeroMonthly,
  FormattedHeroWeekly,
} from "./hero-breakdown-data";

function MiniBand({
  ariaLabel,
  bands,
}: {
  ariaLabel: string;
  bands: FormattedHeroBand[];
}) {
  const segments = bands.filter((band) => band.weightPct > 0);
  return (
    <div aria-label={ariaLabel} className="heroBandTrack" role="img">
      {segments.map((band) => (
        <span
          className={`heroBandSeg heroBandSeg--${band.id}`}
          key={band.id}
          style={{ width: `${band.weightPct}%` }}
        />
      ))}
    </div>
  );
}

function BandLegend({ bands }: { bands: FormattedHeroBand[] }) {
  return (
    <ul className="heroBandLegend">
      {bands.map((band) => (
        <li className={`heroBandLegendItem heroBandLegendItem--${band.id}`} key={band.id}>
          <i aria-hidden="true" />
          <span className="heroBandLegendLabel">{band.label}</span>
          <b className={`heroBandLegendAmount ${band.sign}`}>{band.amountFmt}</b>
        </li>
      ))}
    </ul>
  );
}

/** The micro-band under the delta chips — the newest close's split. */
export function HeroMonthlyMicroBand({ monthly }: { monthly: FormattedHeroMonthly }) {
  return (
    <section aria-label="Origen del cambio del mes" className="heroMicroBand">
      <div className="heroMicroBandHead">
        <span className="heroMicroBandTitle">
          Origen del cambio · {monthly.monthLabel}
        </span>
        <b className={`heroMicroBandTotal ${monthly.aggregateSign}`}>
          {monthly.aggregateFmt}
        </b>
      </div>
      <MiniBand
        ariaLabel={`Origen del cambio de ${monthly.monthLabel}`}
        bands={monthly.bands}
      />
      <BandLegend bands={monthly.bands} />
    </section>
  );
}

/** The margin "Esta semana" block — the ~7-day window's split. */
export function HeroWeeklyBlock({ weekly }: { weekly: FormattedHeroWeekly }) {
  return (
    <section aria-label="Esta semana" className="estaSemana">
      <div className="estaSemanaHead">
        <span className="estaSemanaTitle">Esta semana</span>
        <b className={`estaSemanaTotal ${weekly.aggregateSign}`}>{weekly.aggregateFmt}</b>
      </div>
      <small className="estaSemanaRange">{weekly.rangeLabel}</small>
      <MiniBand ariaLabel="Origen del cambio de esta semana" bands={weekly.bands} />
      <BandLegend bands={weekly.bands} />
    </section>
  );
}
