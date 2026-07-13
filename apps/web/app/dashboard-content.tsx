import { formatRatioPct, returnsTooltipLines } from "@web/_components/returns-format";
import { readDemoContext } from "@web/demo/read-demo-context";
import { perfEnd, perfStart } from "@web/perf-log";
import { getRequestStore } from "@web/request-store";
import { bootstrapHealthcheck } from "@web/store";
import type {
  DrilldownKey,
  FireGlance,
  FramedDelta,
  FramedSnapshotDeltas,
  NetWorthFraming,
  NetWorthPresentation,
} from "@worthline/domain";
import {
  DRILL_GROUP_BY_TIER,
  deriveFramedSnapshotDeltas,
  donutArcSegments,
  formatMoneyMinorPrivacy,
  LIQUIDITY_TIER_LABELS,
  largestRemainderPercentages,
  moneySign,
  presentNetWorth,
} from "@worthline/domain";
import { refreshStalePrices } from "@worthline/pricing";
import Link from "next/link";
import { redirect } from "next/navigation";
import { runBinanceRefresh } from "./ajustes/binance-refresh";
import { runNumistaCoinRefresh } from "./ajustes/numista-coin-refresh";
import BenchmarkComparisonCard from "./benchmark-comparison-card";
import CompositionPanel from "./composition-panel";
import { compositionUrl } from "./composition-url";
import { parseMode } from "./dashboard-matrix";
import DonutDrill, { type DonutSegment } from "./donut-drill";
import FramingPanel, { type FramingTab } from "./framing-panel";
import { HeroMonthlyMicroBand, HeroWeeklyBlock } from "./hero-breakdown";
import {
  type FormattedHeroMonthly,
  type FormattedHeroWeekly,
  formatHeroBreakdown,
} from "./hero-breakdown-data";
import type { HeroHealthView } from "./hero-data-health";
import HeroDataHealthAlert from "./hero-data-health-alert";
import HeroMovers, { type MoversPeriodTab } from "./hero-movers";
import {
  parseDrillParam,
  parseRangeParam,
  parseViewParam,
  parseViviendaParam,
} from "./intake";
import type { RefreshPricesResult } from "./load-dashboard";
import { loadDashboard } from "./load-dashboard";
import {
  buildMoversDataByPeriod,
  type MoversDataByPeriod,
  parseMoversPeriod,
} from "./movers-data";
import PrivacyToggle from "./privacy-toggle";
import { readBenchmarkPricesFromControlPlane } from "./read-benchmark-prices";
import { refreshAndPersistStalePrices } from "./refresh-prices";
import { MOVERS_PERIOD_VIEW_PARAM, writeViewParam } from "./view-state";

const framingTabs = [
  { id: "total" as NetWorthFraming, label: "Patrimonio neto" },
  { id: "liquid" as NetWorthFraming, label: "Líquido" },
];

const TIER_DONUT_GEOMETRY = { cx: 50, cy: 50, innerRadius: 27, outerRadius: 45 };

const DRILL_DESTINATION_LABELS: Record<DrilldownKey, string> = {
  debts: "ver desglose de las deudas",
  housing: "ver desglose de la vivienda",
  liquid: "ver desglose del líquido",
  rest: "ver desglose del resto",
};

const ONBOARDING_LINKS: Record<string, string> = {
  members: "/ajustes",
  holdings: "/patrimonio/anadir",
  fire: "/ajustes",
  snapshot: "/",
};

function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1).replace(".", ",")} %`;
}

function DeltaChip({
  delta,
  label,
  privacyMode,
}: {
  delta: FramedDelta | null;
  label: string;
  privacyMode: boolean;
}) {
  if (!delta) {
    return <span className="deltaChip zero">{label}: sin dato</span>;
  }
  const sign = moneySign(delta.change);
  const arrow = sign === "pos" ? "▲" : sign === "neg" ? "▼" : "•";
  const prefix = delta.change.amountMinor > 0 ? "+" : "";
  const amount = formatMoneyMinorPrivacy(delta.change, privacyMode);
  return (
    <span className={`deltaChip ${sign}`}>
      {arrow} {prefix}
      {amount}
      {delta.pct !== null ? ` (${formatPct(delta.pct)})` : ""} {label}
    </span>
  );
}

/**
 * Compact FIRE glance card for the home dashboard (PRD #507, S1).
 * Shows: % funded + progress bar with coast tick + status pill +
 * years-to-FIRE + goals teaser + link to /ajustes until /objetivos exists.
 */
function FireGlanceCard({
  glance,
  currency,
  privacyMode,
}: {
  glance: FireGlance;
  currency: string;
  privacyMode: boolean;
}) {
  const yearsLabel = (years: number | null) =>
    years === null ? null : `${years} ${years === 1 ? "año" : "años"}`;

  return (
    <div className="fireResults">
      <div className="fireProgress">
        <p className="fireBig" aria-label="Porcentaje financiado">
          {glance.percentFunded.toFixed(1).replace(".", ",")} %
        </p>
        <div className="fireBar">
          {glance.coastTickFraction !== null ? (
            <span
              aria-hidden="true"
              className="fireTick"
              style={{
                left: `${Math.min(100, glance.coastTickFraction * 100)}%`,
              }}
            />
          ) : null}
          <i
            style={{
              width: `${Math.min(100, Math.max(0, glance.percentFunded))}%`,
            }}
          />
        </div>
        {glance.isFunded ? (
          <span className="statePill ready">FIRE alcanzado</span>
        ) : glance.isAlreadyAtCoastFire ? (
          <span className="statePill ready">Coast FIRE alcanzado</span>
        ) : null}
      </div>
      {glance.yearsToFire !== null ? (
        <div className="fireMetric">
          <span>Alcanzas FIRE en</span>
          <strong>{yearsLabel(glance.yearsToFire)}</strong>
        </div>
      ) : null}
      <div className="fireMetric">
        <span>
          {glance.goalsCount > 0
            ? `${glance.goalsCount} ${glance.goalsCount === 1 ? "objetivo" : "objetivos"}`
            : "Sin objetivos"}
        </span>
        {glance.goalsReservedMinor > 0 ? (
          <strong className="fireReserved">
            Reservado{" "}
            {formatMoneyMinorPrivacy(
              { amountMinor: glance.goalsReservedMinor, currency },
              privacyMode,
            )}
          </strong>
        ) : null}
      </div>
      <Link className="panelAction" href="/objetivos">
        Ver objetivos →
      </Link>
    </div>
  );
}

/**
 * The hero "sheet" (#661, variant B «la hoja con margen»): a main column
 * (headline, delta chips, the monthly "Origen del cambio" micro-band, hero stats)
 * beside a margin column (the "Esta semana" block, the movers as margin
 * annotations, and the link to /historico). Server-rendered for BOTH framings and
 * handed to <FramingPanel>, which shows the active one and toggles client-side
 * with no round-trip (#518). The framing-independent chrome (donut, composition,
 * FIRE) stays outside, rendered once.
 *
 * The monthly micro-band and "Esta semana" are whole-patrimony (framing-
 * independent) — the same split /historico shows — so both framings receive the
 * identical `monthly`/`weekly`; only headline, chips, stats and movers reframe.
 */
function HeroFraming({
  hasHoldings,
  headlineDeltas,
  health,
  monthly,
  moversByPeriod,
  moversPeriod,
  moversPeriodTabs,
  presentation,
  privacyMode,
  returnTo,
  showDeltas,
  weekly,
}: {
  hasHoldings: boolean;
  headlineDeltas: FramedSnapshotDeltas;
  health: HeroHealthView;
  monthly: FormattedHeroMonthly | null;
  moversByPeriod: MoversDataByPeriod | null;
  moversPeriod: ReturnType<typeof parseMoversPeriod>;
  moversPeriodTabs: readonly MoversPeriodTab[];
  presentation: NetWorthPresentation | undefined;
  privacyMode: boolean;
  returnTo: string;
  showDeltas: boolean;
  weekly: FormattedHeroWeekly | null;
}) {
  const hasMargin = Boolean(weekly || moversByPeriod);
  return (
    <div className={hasMargin ? "heroSheet" : "heroSheet heroSheet--noMargin"}>
      <div className="heroSheetMain">
        {presentation ? (
          <div className="headline">
            <span>{presentation.headlineLabel}</span>
            <strong className={hasHoldings ? "totalRule" : "totalRule emptyFigure"}>
              {formatMoneyMinorPrivacy(presentation.headline, privacyMode)}
              {!hasHoldings ? <small>sin datos aún</small> : null}
            </strong>
            <PrivacyToggle privacyMode={privacyMode} returnTo={returnTo} />
          </div>
        ) : null}

        {showDeltas ? (
          <div className="deltaChips" aria-label="Cambios de snapshots">
            <DeltaChip
              delta={headlineDeltas.sincePrevious}
              label="vs anterior"
              privacyMode={privacyMode}
            />
            <DeltaChip
              delta={headlineDeltas.sinceMonthlyClose}
              label="vs cierre mensual"
              privacyMode={privacyMode}
            />
          </div>
        ) : null}

        <HeroDataHealthAlert health={health} />

        {monthly ? <HeroMonthlyMicroBand monthly={monthly} /> : null}

        {presentation ? (
          <div className="heroStats">
            {presentation.breakdown.map((item) => (
              <div className="heroStat" key={item.id}>
                <span>{item.label}</span>
                <b className={hasHoldings ? undefined : "emptyFigure"}>
                  {formatMoneyMinorPrivacy(item.value, privacyMode)}
                </b>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {hasMargin ? (
        <aside className="heroMargin" aria-label="Cambio reciente y qué lo movió">
          {weekly ? <HeroWeeklyBlock weekly={weekly} /> : null}
          {moversByPeriod ? (
            <HeroMovers
              dataByPeriod={moversByPeriod}
              initialPeriod={moversPeriod}
              periodTabs={moversPeriodTabs}
            />
          ) : null}
          <Link className="heroMarginLink" href="/historico" scroll={false}>
            Origen completo en el histórico →
          </Link>
        </aside>
      ) : null}
    </div>
  );
}

export default async function DashboardContent({
  privacyMode,
  returnTo,
  searchParams,
  scopeId,
}: {
  privacyMode: boolean;
  returnTo: string;
  searchParams?: Record<string, string | string[] | undefined> | undefined;
  scopeId: string | undefined;
}) {
  const persistence = await bootstrapHealthcheck();
  const demo = await readDemoContext();
  const selectedView = parseViewParam(searchParams?.view);
  const selectedDrill = parseDrillParam(searchParams?.drill);
  const selectedRange =
    searchParams?.range === undefined ? undefined : parseRangeParam(searchParams.range);
  const selectedHousingMode = parseViviendaParam(searchParams?.vivienda);

  const moversPeriod = parseMoversPeriod(searchParams?.mvp);

  const now = persistence.checkedAt;
  const today = now.slice(0, 10);

  const perfStartedAt = perfStart();
  const store = await getRequestStore();
  const state = await loadDashboard({
    store,
    persistence,
    scopeId,
    selectedView,
    drill: selectedDrill,
    today,
    now,
    ...(selectedRange === undefined ? {} : { range: selectedRange }),
    readBenchmarkPrices: readBenchmarkPricesFromControlPlane,
    refreshPrices: demo.enabled
      ? async (): Promise<RefreshPricesResult> => ({ priceCache: [], errors: [] })
      : async ({ cacheEntries, assets, nowIso }): Promise<RefreshPricesResult> => {
          return refreshAndPersistStalePrices({
            cacheEntries,
            assets,
            nowIso,
            refreshStalePrices,
            upsertPrices: (prices) => store.operations.upsertPrices(prices),
            readCache: () => store.operations.readAllPriceCacheEntries(),
          });
        },
    ...(demo.enabled
      ? {}
      : {
          refreshCoinValuations: () => runNumistaCoinRefresh(store, now),
          refreshBinanceSources: () => runBinanceRefresh(store, now),
        }),
  });
  perfEnd("dashboard", perfStartedAt);

  if (state.needsOnboarding) {
    redirect("/empezar");
  }

  const { fireGlance, onboarding, pyramid, snapshots } = state;
  const selectedRangeForView = state.activeCompositionRange;

  const hasHoldings = state.assets.length + state.liabilities.length > 0;

  // Both framings, computed server-side from the view-independent summary/deltas
  // (#518, S2): the heavy store work already ran once, so framing the figures for
  // both views is cheap pure math. <FramingPanel> ships both and toggles between
  // them client-side — no second round-trip on a Vista switch.
  const presentationByView = {
    liquid: state.summary ? presentNetWorth(state.summary, "liquid") : undefined,
    total: state.summary ? presentNetWorth(state.summary, "total") : undefined,
  } as const;
  const currency = presentationByView.total?.headline.currency ?? "EUR";
  // The hero "Origen del cambio" figures (#661): whole-patrimony, so formatted
  // once and shared by both framings (only headline/chips/stats/movers reframe).
  const heroBreakdown = state.heroBreakdown
    ? formatHeroBreakdown(state.heroBreakdown, currency, privacyMode)
    : null;
  const emptyFramedDeltas: FramedSnapshotDeltas = {
    sinceMonthlyClose: null,
    sincePrevious: null,
  };
  const deltasByView = {
    liquid: state.deltas
      ? deriveFramedSnapshotDeltas(state.deltas, "liquid")
      : emptyFramedDeltas,
    total: state.deltas
      ? deriveFramedSnapshotDeltas(state.deltas, "total")
      : emptyFramedDeltas,
  } as const;
  const moversByView = {
    liquid: buildMoversDataByPeriod({
      snapshots,
      selectedView: "liquid",
      holdingRows: state.snapshotHoldingRows,
      currency,
      privacyMode,
    }),
    total: buildMoversDataByPeriod({
      snapshots,
      selectedView: "total",
      holdingRows: state.snapshotHoldingRows,
      currency,
      privacyMode,
    }),
  } as const;
  const currentSearch = (() => {
    if (!searchParams) return "";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) params.append(key, entry);
      } else {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  })();
  const moversPeriodTabs: MoversPeriodTab[] = (
    [
      { id: "month" as const, label: "Mes" },
      { id: "year" as const, label: "Año" },
    ] as const
  ).map((tab) => {
    const nextSearch = writeViewParam(currentSearch, MOVERS_PERIOD_VIEW_PARAM, tab.id);
    return {
      ...tab,
      href: `/${nextSearch}`,
    };
  });
  const framingTabsWithHref: FramingTab[] = framingTabs.map((tab) => ({
    href: compositionUrl(
      tab.id,
      selectedDrill,
      selectedRangeForView,
      selectedHousingMode,
      false,
    ),
    id: tab.id,
    label: tab.label,
  }));

  const anyStepPending = onboarding.some((step) => !step.done);

  const tierBpsValues = pyramid.map((tier) => tier.shareOfGrossBps);
  const tierPercents = largestRemainderPercentages(tierBpsValues);
  const donutSegments = donutArcSegments(tierPercents, TIER_DONUT_GEOMETRY);
  // The donut becomes a client island so a segment opens its drill in place
  // (S4 #520): pre-resolve each segment's geometry, drill destination and a11y
  // copy server-side; the island builds the live hrefs + intercepts the click.
  const donutSegmentsForIsland: DonutSegment[] = donutSegments.map((segment) => {
    const tier = pyramid[segment.index]!;
    const drillKey = DRILL_GROUP_BY_TIER[tier.tier];
    return {
      ariaLabel: `${LIQUIDITY_TIER_LABELS[tier.tier]}: ${DRILL_DESTINATION_LABELS[drillKey]}`,
      drillKey,
      path: segment.path,
      tier: tier.tier,
      title: `${LIQUIDITY_TIER_LABELS[tier.tier]} · ${segment.share}%`,
    };
  });

  return (
    <>
      <div className="dashGrid">
        <section className="summaryBand heroPanel" aria-label="Resumen patrimonial">
          <FramingPanel
            initialView={selectedView}
            liquid={
              <HeroFraming
                hasHoldings={hasHoldings}
                headlineDeltas={deltasByView.liquid}
                health={state.heroHealth}
                monthly={heroBreakdown?.monthly ?? null}
                moversByPeriod={moversByView.liquid}
                moversPeriod={moversPeriod}
                moversPeriodTabs={moversPeriodTabs}
                presentation={presentationByView.liquid}
                privacyMode={privacyMode}
                returnTo={returnTo}
                showDeltas={Boolean(state.deltas)}
                weekly={heroBreakdown?.weekly ?? null}
              />
            }
            tabs={framingTabsWithHref}
            total={
              <HeroFraming
                hasHoldings={hasHoldings}
                headlineDeltas={deltasByView.total}
                health={state.heroHealth}
                monthly={heroBreakdown?.monthly ?? null}
                moversByPeriod={moversByView.total}
                moversPeriod={moversPeriod}
                moversPeriodTabs={moversPeriodTabs}
                presentation={presentationByView.total}
                privacyMode={privacyMode}
                returnTo={returnTo}
                showDeltas={Boolean(state.deltas)}
                weekly={heroBreakdown?.weekly ?? null}
              />
            }
          />
          {/* Portfolio returns line (#551, ADR 0040): one small line INSIDE the hero
            cell — never a new dashGrid child (that broke the layout in #562). The
            hover explains the three measures + honest caveats. */}
          {hasHoldings &&
          state.portfolioReturns &&
          state.portfolioReturns.totalReturnRatio !== null ? (
            <p
              className="heroReturns returnsHint"
              tabIndex={0}
              aria-label={`Rentabilidad: ${returnsTooltipLines(state.portfolioReturns).join(". ")}`}
            >
              Rentabilidad{" "}
              <strong
                className={state.portfolioReturns.totalReturnRatio >= 0 ? "pos" : "neg"}
              >
                {formatRatioPct(state.portfolioReturns.totalReturnRatio)}
              </strong>
              {state.portfolioReturns.irr?.rate != null
                ? ` · IRR ${formatRatioPct(state.portfolioReturns.irr.rate)} anual`
                : null}
              <span className="returnsHintBody" role="tooltip">
                {returnsTooltipLines(state.portfolioReturns).map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            </p>
          ) : null}
        </section>

        {!hasHoldings ? (
          <section className="emptyDashCta section" aria-label="Empieza tu patrimonio">
            <p>Aún no has añadido nada. Empieza por lo primero.</p>
            <Link className="primaryAction" href="/patrimonio/anadir">
              Añade algo →
            </Link>
          </section>
        ) : null}

        <section className="liquidityPanel section" aria-label="Liquidez por capa">
          <div className="panelHeader">
            <h2>Liquidez</h2>
            <span>Por capa · % del bruto</span>
          </div>
          <DonutDrill
            geometry={TIER_DONUT_GEOMETRY}
            initialHousingMode={selectedHousingMode}
            initialRange={selectedRangeForView}
            initialView={selectedView}
            segments={donutSegmentsForIsland}
          />
          <div className="pyramid">
            {pyramid.map((tier, idx) => {
              const pct = tierPercents[idx] ?? 0;
              return (
                <details className={`tier ${tier.tier}`} key={tier.tier}>
                  <summary>
                    <span className="tierName">{LIQUIDITY_TIER_LABELS[tier.tier]}</span>
                    <b className={moneySign(tier.netValue) === "neg" ? "neg" : undefined}>
                      {formatMoneyMinorPrivacy(tier.netValue, privacyMode)}
                    </b>
                    <span className="tierShare">{pct}%</span>
                    <span className="tierBar" aria-hidden="true">
                      <i style={{ width: `${pct}%` }} />
                    </span>
                  </summary>
                  <div className="tierDetails">
                    <span>
                      Bruto {formatMoneyMinorPrivacy(tier.grossAssets, privacyMode)}
                    </span>
                    <span className="debitCol">
                      Deuda {formatMoneyMinorPrivacy(tier.debts, privacyMode)}
                    </span>
                    {tier.assets.map((asset) => (
                      <small key={asset.id}>+ {asset.name}</small>
                    ))}
                    {tier.liabilities.map((liability) => (
                      <small key={liability.id}>- {liability.name}</small>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </section>

        <section
          className="historyPanel section"
          id="composicion"
          aria-label="Evolución del patrimonio"
        >
          {/* The whole composition surface (range pills + chart ⇄ drilldown) is one
            client island over the matrix (S4 #520): opening/closing a drill and
            changing the range are instant, no round-trip (interaction-patterns
            §2). The server shipped the initial cross; the island prefetches the
            next from /api/dashboard/cells. */}
          <CompositionPanel
            currency={snapshots[0]?.totalNetWorth.currency ?? "EUR"}
            historicoLink={
              <Link className="panelAction" href="/historico" scroll={false}>
                Ver histórico →
              </Link>
            }
            initialCells={state.matrixCells}
            initialHousingMode={selectedHousingMode}
            initialMode={parseMode(selectedDrill)}
            initialRange={selectedRangeForView}
            initialView={selectedView}
            offeredRanges={state.compositionRanges}
            privacyMode={privacyMode}
          />
          <BenchmarkComparisonCard result={state.benchmarkComparison} />
        </section>

        <section className="firePanel section" aria-label="FIRE">
          <div className="panelHeader">
            <h2>FIRE</h2>
            <span>Independencia financiera</span>
          </div>
          {fireGlance ? (
            <FireGlanceCard
              currency={currency}
              glance={fireGlance}
              privacyMode={privacyMode}
            />
          ) : (
            <div className="fireEmpty">
              <p className="fireEmptyHint">
                Configura tu número FIRE para ver tu progreso hacia la independencia
                financiera.
              </p>
              <Link className="panelAction" href="/ajustes">
                Configurar → Ajustes
              </Link>
            </div>
          )}
        </section>

        {anyStepPending ? (
          <section className="onboardingChecklist section" aria-label="Primeros pasos">
            <div className="panelHeader">
              <h2>Primeros pasos</h2>
              <span>Empieza aquí</span>
            </div>
            <ol>
              {onboarding.map((step) => (
                <li className={step.done ? "done" : undefined} key={step.id}>
                  {step.done ? (
                    <span>✓ {step.label}</span>
                  ) : (
                    <Link href={ONBOARDING_LINKS[step.id] ?? "/"}>○ {step.label}</Link>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </>
  );
}
