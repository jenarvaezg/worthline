import {
  EXPOSURE_LENS_VIEW_PARAM,
  type ExposureLens,
  writeViewParam,
} from "@web/view-state";
import type {
  ExposureDimensionResult,
  ExposureLookthrough,
  ExposureSectorStyle,
} from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";

import ExposureLensPanel, { type ExposureLensTab } from "./exposure-lens";
import {
  coverageParts,
  formatExposureWeight,
  geographyForLens,
  geographyLabel,
  sectorForLens,
  sectorLabel,
  sectorStyleChips,
  sectorStyleForLens,
} from "./exposure-view";

/**
 * The exposure look-through section on /patrimonio (PRD #539 S3, #543; sector:
 * PRD #1018 S3, #1021): a present-time lens (never a snapshot/figure) over where
 * the portfolio is actually invested, computed by the S0 domain
 * `lookThroughExposure` and handed here already aggregated. It renders the
 * geography breakdown (MSCI buckets) and the GICS-11 sector breakdown behind a
 * single client lens toggle — full portfolio ↔ equity-only — each with the
 * three-way coverage split (classified / not-applicable / unknown) so an
 * `unknown` remainder is never hidden and crypto/cash reads as "no aplica", not
 * missing. Sector is equity-scaled (ADR 0065) and carries a derived
 * defensive/cyclical chip line; plus the unhedged currency-risk readout. Both
 * breakdowns and their coverage swap with the lens; currency risk is
 * portfolio-level, shown once (Variant A).
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
    <section className="exposureSection section" aria-label="Exposición">
      <div className="panelHeader">
        <h2>Exposición</h2>
        <span>Dónde está invertido de verdad</span>
      </div>

      <ExposureLensPanel
        all={
          <LensView equity={equity} full={full} lens="all" privacyMode={privacyMode} />
        }
        equity={
          <LensView equity={equity} full={full} lens="equity" privacyMode={privacyMode} />
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
 * Everything that swaps with the lens (Variant A): the geography breakdown then
 * the equity-scaled sector breakdown, each with its own three-way coverage, so
 * one toggle re-renders both blocks together. The among-state (which
 * pre-rendered breakdown a lens shows) is the pure `exposure-view` module.
 */
function LensView({
  lens,
  full,
  equity,
  privacyMode,
}: {
  lens: ExposureLens;
  full: ExposureLookthrough;
  equity: ExposureLookthrough;
  privacyMode: boolean;
}) {
  return (
    <>
      <GeographyBlock
        geography={geographyForLens(lens, full, equity)}
        privacyMode={privacyMode}
      />
      <SectorBlock
        privacyMode={privacyMode}
        sector={sectorForLens(lens, full, equity)}
        style={sectorStyleForLens(lens, full, equity)}
      />
    </>
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

/**
 * The equity-scaled sector breakdown for one lens (PRD #1018, ADR 0065): a
 * derived defensive/cyclical chip line over a labelled bar per GICS-11 sector,
 * plus the three-way coverage readout for THIS lens's sector. Titled "de la
 * renta variable" because the vector is relative to the equity sleeve, not the
 * whole fund. The chips are a derived lens — never a bar and never a bucket.
 */
function SectorBlock({
  sector,
  style,
  privacyMode,
}: {
  sector: ExposureDimensionResult;
  style: ExposureSectorStyle;
  privacyMode: boolean;
}) {
  return (
    <div className="exposureSector">
      <h3 className="exposureSectorTitle">Por sector · de la renta variable</h3>

      {/* The defensive/cyclical line only reads meaningfully over classified
          slices; with none it would print "0 % · 0 %" above the empty note, so
          it is suppressed alongside the empty state. */}
      {sector.slices.length > 0 ? (
        <ul className="exposureSectorStyle" aria-label="Estilo defensivo/cíclico">
          {sectorStyleChips(style).map((chip) => (
            <li className={`exposureStyleChip ${chip.kind}`} key={chip.kind}>
              <span className="exposureStyleChipLabel">{chip.label}</span>
              <b>{formatExposureWeight(chip.weight)}</b>
            </li>
          ))}
        </ul>
      ) : null}

      {sector.slices.length > 0 ? (
        <ul className="exposureBars">
          {sector.slices.map((slice) => (
            <li className="exposureBar" key={slice.key}>
              <span className="exposureBarLabel">{sectorLabel(slice.key)}</span>
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
        <p className="emptyLine">Sin exposición por sector clasificada.</p>
      )}

      <dl className="exposureCoverage">
        {coverageParts(sector.coverage).map((part) => (
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
