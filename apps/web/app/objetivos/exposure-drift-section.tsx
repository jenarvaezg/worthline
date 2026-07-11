"use client";

import type { ExposureDriftPoint, FireGrowthAssumption } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import { useEffect, useState } from "react";

import {
  coverageParts,
  EXPOSURE_DRIFT_GROWTH_PARAM,
  EXPOSURE_DRIFT_YEAR_PARAM,
  exposureDriftGrowthUrl,
  exposureDriftYearUrl,
  formatExposureWeight,
  geographyLabel,
  parseExposureDriftGrowth,
  parseExposureDriftYear,
} from "./exposure-drift-view";

/**
 * Exposure-drift what-if (#560): geography composition forward under the plan.
 * Server renders the full trajectory once; year and growth toggles mirror to
 * the URL via pushState (interaction-patterns §2).
 */
export function ExposureDriftSection({
  trajectories,
  initialGrowth,
  initialYear,
  currency,
  privacyMode,
}: {
  trajectories: Record<FireGrowthAssumption, ExposureDriftPoint[]>;
  initialGrowth: FireGrowthAssumption;
  initialYear: number;
  currency: string;
  privacyMode: boolean;
}) {
  const [growth, setGrowth] = useState(initialGrowth);
  const [year, setYear] = useState(initialYear);

  useEffect(() => {
    const syncFromUrl = () => {
      const url = new URL(window.location.href);
      const nextGrowth = parseExposureDriftGrowth(
        url.searchParams.get(EXPOSURE_DRIFT_GROWTH_PARAM) ?? undefined,
      );
      const trajectory = trajectories[nextGrowth];
      setGrowth(nextGrowth);
      setYear(
        parseExposureDriftYear(
          url.searchParams.get(EXPOSURE_DRIFT_YEAR_PARAM) ?? undefined,
          trajectory,
        ),
      );
    };
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [trajectories]);

  const trajectory = trajectories[growth];
  if (trajectory.length === 0) {
    return null;
  }

  const point =
    trajectory.find((candidate) => candidate.year === year) ?? trajectory.at(-1)!;
  const yearOptions = trajectory.map((candidate) => candidate.year);

  const selectGrowth = (next: FireGrowthAssumption) => {
    setGrowth(next);
    const nextTrajectory = trajectories[next];
    const nextYear = parseExposureDriftYear(String(year), nextTrajectory);
    setYear(nextYear);
    window.history.pushState({}, "", exposureDriftGrowthUrl(window.location.href, next));
  };

  const selectYear = (nextYear: number) => {
    setYear(nextYear);
    window.history.pushState(
      {},
      "",
      exposureDriftYearUrl(window.location.href, nextYear),
    );
  };

  return (
    <section className="firePanel exposureDrift" aria-label="Deriva de exposición">
      <div className="panelHeader">
        <h3>Deriva de exposición · what-if</h3>
        <span>cómo cambia tu geografía si sigues el plan</span>
      </div>

      <div className="exposureDriftControls">
        <div
          className="exposureDriftToggle"
          role="group"
          aria-label="Supuesto de crecimiento"
        >
          <button
            className={growth === "flat" ? "active" : undefined}
            onClick={() => selectGrowth("flat")}
            type="button"
          >
            Sin revalorización
          </button>
          <button
            className={growth === "historical" ? "active" : undefined}
            onClick={() => selectGrowth("historical")}
            type="button"
          >
            Histórico por activo
          </button>
        </div>

        <label className="exposureDriftYearSelect">
          <span>Año</span>
          <select
            value={point.year}
            onChange={(event) => selectYear(Number(event.target.value))}
          >
            {yearOptions.map((optionYear) => (
              <option key={optionYear} value={optionYear}>
                {optionYear === 0 ? "Hoy" : `+${optionYear}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="exposureDriftNote">
        Proyección bajo el plan de aportaciones · metadatos de previsión, no dinero
        confirmado.
      </p>

      <div className="exposureDriftSlices">
        {point.geography.slices.map((slice) => (
          <div className="exposureDriftSlice" key={slice.key}>
            <span>{geographyLabel(slice.key)}</span>
            <strong>{formatExposureWeight(slice.weight)}</strong>
            <span className="exposureBarTrack" aria-hidden="true">
              <i
                style={{
                  width: `${Math.max(0, Math.min(100, Number(slice.weight) * 100))}%`,
                }}
              />
            </span>
          </div>
        ))}
      </div>

      <dl className="exposureCoverage exposureDriftCoverage">
        {coverageParts(point.geography.coverage).map((part) => (
          <div className={`exposureCoveragePart ${part.kind}`} key={part.kind}>
            <dt>{part.label}</dt>
            <dd>{formatMoneyMinorPrivacy(part.value, privacyMode)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
