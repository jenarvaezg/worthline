import {
  EXPOSURE_LENS_VIEW_PARAM,
  type ExposureLens,
  writeViewParam,
} from "@web/view-state";
import type { ExposureDimensionResult, ExposureLookthrough } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";

import ExposureLensPanel, { type ExposureLensTab } from "./exposure-lens";
import {
  coverageParts,
  formatExposureWeight,
  geographyForLens,
  geographyLabel,
} from "./exposure-view";

/**
 * The exposure look-through section on /patrimonio (PRD #539 S3, #543): a
 * present-time lens (never a snapshot/figure) over where the portfolio is
 * actually invested, computed by the S0 domain `lookThroughExposure` and handed
 * here already aggregated. It renders the geography breakdown (MSCI buckets)
 * behind a client lens toggle — full portfolio ↔ equity-only — with the
 * three-way coverage split (classified / not-applicable / unknown) so an
 * `unknown` remainder is never hidden and crypto/cash reads as "no aplica", not
 * missing; plus the unhedged currency-risk readout. Only the geography block and
 * its coverage swap with the lens; currency risk is portfolio-level, shown once.
 */
export default function ExposureSection({
  currentUrl,
  full,
  equity,
  initialLens,
  privacyMode,
}: {
  currentUrl: string;
  full: ExposureLookthrough;
  equity: ExposureLookthrough;
  initialLens: ExposureLens;
  privacyMode: boolean;
}) {
  const query = currentUrl.includes("?") ? currentUrl.slice(currentUrl.indexOf("?")) : "";
  const path = currentUrl.includes("?")
    ? currentUrl.slice(0, currentUrl.indexOf("?"))
    : currentUrl;
  const lensHref = (lens: ExposureLens): string =>
    `${path}${writeViewParam(query, EXPOSURE_LENS_VIEW_PARAM, lens)}`;

  const tabs: ExposureLensTab[] = [
    { href: lensHref("all"), id: "all", label: "Cartera completa" },
    { href: lensHref("equity"), id: "equity", label: "Solo renta variable" },
  ];

  const currencyRisk = full.currencyRisk;

  return (
    <section className="exposureSection" aria-label="Exposición">
      <div className="panelHeader">
        <h2>Exposición</h2>
        <span>Dónde está invertido de verdad</span>
      </div>

      <ExposureLensPanel
        all={
          <GeographyBlock
            geography={geographyForLens("all", full, equity)}
            privacyMode={privacyMode}
          />
        }
        equity={
          <GeographyBlock
            geography={geographyForLens("equity", full, equity)}
            privacyMode={privacyMode}
          />
        }
        initialLens={initialLens}
        tabs={tabs}
      />

      <div className="exposureCurrencyRisk">
        <h3>Riesgo divisa no cubierto</h3>
        {currencyRisk.length > 0 ? (
          <ul className="exposureBars">
            {currencyRisk.map((slice) => (
              <li className="exposureBar" key={slice.key}>
                <span className="exposureBarLabel">{slice.key}</span>
                <b>{formatMoneyMinorPrivacy(slice.value, privacyMode)}</b>
                <span className="exposureBarShare">
                  {formatExposureWeight(slice.weight)}
                </span>
                <span className="exposureBarTrack" aria-hidden="true">
                  <i style={{ width: percentWidth(slice.weight) }} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="emptyLine">Todo en euros o cubierto.</p>
        )}
      </div>
    </section>
  );
}

/**
 * The geography breakdown for one lens: a labelled bar per MSCI bucket plus the
 * three-way coverage readout for THIS lens's geography, so the bars and their
 * coverage swap together when the lens toggles.
 */
function GeographyBlock({
  geography,
  privacyMode,
}: {
  geography: ExposureDimensionResult;
  privacyMode: boolean;
}) {
  return (
    <div className="exposureGeography">
      {geography.slices.length > 0 ? (
        <ul className="exposureBars">
          {geography.slices.map((slice) => (
            <li className="exposureBar" key={slice.key}>
              <span className="exposureBarLabel">{geographyLabel(slice.key)}</span>
              <b>{formatMoneyMinorPrivacy(slice.value, privacyMode)}</b>
              <span className="exposureBarShare">
                {formatExposureWeight(slice.weight)}
              </span>
              <span className="exposureBarTrack" aria-hidden="true">
                <i style={{ width: percentWidth(slice.weight) }} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="emptyLine">Sin exposición geográfica clasificada.</p>
      )}

      <dl className="exposureCoverage">
        {coverageParts(geography.coverage).map((part) => (
          <div className={`exposureCoveragePart ${part.kind}`} key={part.kind}>
            <dt>{part.label}</dt>
            <dd>{formatMoneyMinorPrivacy(part.value, privacyMode)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Clamp a `0..1` weight ratio to a CSS bar width (never over 100%). */
function percentWidth(weight: string): string {
  const percent = Math.max(0, Math.min(100, Number(weight) * 100));
  return `${percent}%`;
}
