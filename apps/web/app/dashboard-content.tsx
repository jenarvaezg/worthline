import {
  deriveFramedSnapshotDeltas,
  DRILL_GROUP_BY_TIER,
  donutArcSegments,
  formatMoneyMinorPrivacy,
  isLiquid,
  largestRemainderPercentages,
  LIQUIDITY_TIER_LABELS,
  moneySign,
  presentNetWorth,
} from "@worthline/domain";
import type {
  DrilldownKey,
  FireGlance,
  FramedDelta,
  FramedSnapshotDeltas,
  LiquidityTier,
  NetWorthFraming,
  NetWorthPresentation,
  NetWorthSnapshot,
} from "@worthline/domain";
import { createControlPlaneStore } from "@worthline/db";
import { refreshStalePrices } from "@worthline/pricing";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  parseDrillParam,
  parseRangeParam,
  parseViewParam,
  parseViviendaParam,
} from "./intake";
import { loadDashboard } from "./load-dashboard";
import type { RefreshPricesResult } from "./load-dashboard";
import BenchmarkComparisonCard from "./benchmark-comparison-card";
import CompositionPanel from "./composition-panel";
import { compositionUrl } from "./composition-url";
import { parseMode } from "./dashboard-matrix";
import DonutDrill, { type DonutSegment } from "./donut-drill";
import FramingPanel, { type FramingTab } from "./framing-panel";
import HeroMovers from "./hero-movers";
import type { HoldingMover, MoversData, MoversPeriod } from "./hero-movers";
import PrivacyToggle from "./privacy-toggle";
import { formatRatioPct, returnsTooltipLines } from "@web/_components/returns-format";
import { runBinanceRefresh } from "./ajustes/binance-refresh";
import { runNumistaCoinRefresh } from "./ajustes/numista-coin-refresh";
import { refreshAndPersistStalePrices } from "./refresh-prices";
import { readDemoContext } from "@web/demo/read-demo-context";
import { perfEnd, perfStart } from "@web/perf-log";
import { bootstrapHealthcheck, openStore } from "@web/store";

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

async function readBenchmarkPricesFromControlPlane(seriesId: string) {
  const url = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) return [];

  const controlPlane = await createControlPlaneStore({
    url,
    ...(process.env.WORTHLINE_DB_AUTH_TOKEN
      ? { authToken: process.env.WORTHLINE_DB_AUTH_TOKEN }
      : {}),
  });
  try {
    return await controlPlane.readBenchmarkPrices(seriesId);
  } finally {
    controlPlane.close();
  }
}

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

const MOVERS_MAX_PER_COLUMN = 4;

function moversMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

interface MoversHoldingRow {
  dateKey: string;
  holdingId: string;
  kind: "asset" | "liability";
  label: string;
  valueMinor: number;
  liquidityTier: LiquidityTier | null;
  securesHousing: boolean;
}

function moversIsLiquidHolding(meta: {
  kind: "asset" | "liability";
  tier: LiquidityTier | null;
  securesHousing: boolean;
}): boolean {
  if (meta.kind === "asset") return meta.tier !== null && isLiquid(meta.tier);
  if (meta.securesHousing) return false;
  return meta.tier === null || isLiquid(meta.tier);
}

function moversContribMinor(row: MoversHoldingRow): number {
  return row.kind === "liability" ? -row.valueMinor : row.valueMinor;
}

function moversPctFmt(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1).replace(".", ",")} %`;
}

function moversBaseSnapshot(
  snapshots: NetWorthSnapshot[],
  period: MoversPeriod,
): NetWorthSnapshot | undefined {
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return undefined;
  if (period === "year") {
    const [y, m] = latest.monthKey.split("-");
    const target = `${Number(y) - 1}-${m}`;
    const candidates = snapshots.filter((s) => s.monthKey <= target);
    return candidates[candidates.length - 1];
  }
  const candidates = snapshots.filter((s) => s.monthKey < latest.monthKey);
  return candidates[candidates.length - 1];
}

interface MoverRaw {
  label: string;
  impactMinor: number;
  pct: number | null;
  tag: "nuevo" | "vendido" | null;
}

function buildMoversData(params: {
  snapshots: NetWorthSnapshot[];
  selectedView: NetWorthFraming;
  period: MoversPeriod;
  holdingRows: MoversHoldingRow[];
  currency: string;
  privacyMode: boolean;
}): MoversData | null {
  const { snapshots, selectedView, period, holdingRows, currency, privacyMode } = params;
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return null;

  const base = moversBaseSnapshot(snapshots, period);
  const vsLabel = base
    ? period === "year"
      ? `vs ${moversMonthLabel(base.monthKey)} (YoY)`
      : `vs cierre ${moversMonthLabel(base.monthKey)}`
    : period === "year"
      ? "Año anterior"
      : "Cierre anterior";
  if (!base) {
    return { vsLabel, hasBase: false, up: [], down: [] };
  }

  type Agg = {
    label: string;
    kind: "asset" | "liability";
    base: number;
    cur: number;
    tier: LiquidityTier | null;
    securesHousing: boolean;
    latestSeen: boolean;
  };
  const byHolding = new Map<string, Agg>();
  for (const row of holdingRows) {
    if (row.dateKey !== latest.dateKey && row.dateKey !== base.dateKey) continue;
    const key = `${row.kind}:${row.holdingId}`;
    const entry =
      byHolding.get(key) ??
      ({
        label: row.label,
        kind: row.kind,
        base: 0,
        cur: 0,
        tier: row.liquidityTier,
        securesHousing: row.securesHousing,
        latestSeen: false,
      } satisfies Agg);
    entry.label = row.label;
    const isLatest = row.dateKey === latest.dateKey;
    if (isLatest) entry.cur += moversContribMinor(row);
    else entry.base += moversContribMinor(row);
    if (isLatest || !entry.latestSeen) {
      entry.tier = row.liquidityTier;
      entry.securesHousing = row.securesHousing;
      if (isLatest) entry.latestSeen = true;
    }
    byHolding.set(key, entry);
  }

  const raw: MoverRaw[] = [];
  for (const e of byHolding.values()) {
    if (selectedView === "liquid" && !moversIsLiquidHolding(e)) continue;
    const impactMinor = e.cur - e.base;
    if (impactMinor === 0) continue;
    raw.push({
      label: e.label,
      impactMinor,
      pct: e.base !== 0 ? (impactMinor / Math.abs(e.base)) * 100 : null,
      tag: e.base === 0 ? "nuevo" : e.cur === 0 ? "vendido" : null,
    });
  }

  if (raw.length === 0) {
    return { vsLabel, hasBase: true, up: [], down: [] };
  }

  const toMover = (r: MoverRaw): HoldingMover => {
    const amount = formatMoneyMinorPrivacy(
      { amountMinor: r.impactMinor, currency },
      privacyMode,
    );
    return {
      label: r.label,
      changeFmt: `${r.impactMinor > 0 ? "+" : ""}${amount}`,
      pctFmt: r.pct === null ? null : moversPctFmt(r.pct),
      sign: r.impactMinor > 0 ? "pos" : r.impactMinor < 0 ? "neg" : "zero",
      tag: r.tag,
    };
  };

  const byImpactDesc = [...raw].sort((a, b) => b.impactMinor - a.impactMinor);

  return {
    vsLabel,
    hasBase: true,
    up: byImpactDesc
      .filter((r) => r.impactMinor > 0)
      .slice(0, MOVERS_MAX_PER_COLUMN)
      .map(toMover),
    down: byImpactDesc
      .filter((r) => r.impactMinor < 0)
      .reverse()
      .slice(0, MOVERS_MAX_PER_COLUMN)
      .map(toMover),
  };
}

function parseMoversPeriod(raw: string | string[] | undefined): MoversPeriod {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "year" ? "year" : "month";
}

function selectMoversHoldingRows(
  rows: MoversHoldingRow[],
  snapshots: NetWorthSnapshot[],
  period: MoversPeriod,
): MoversHoldingRow[] {
  const base = moversBaseSnapshot(snapshots, period);
  if (!base) return [];
  return rows.filter((row) => row.dateKey >= base.dateKey);
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
 * The view-dependent slice of the hero (#518, S2): headline figure, delta chips,
 * hero stats and movers for ONE framing. The server renders it for BOTH framings
 * and hands both to <FramingPanel>, which shows the active one and toggles
 * client-side with no round-trip. The framing-independent chrome (the donut, the
 * composition chart, FIRE) stays outside, rendered once.
 */
function HeroFraming({
  hasHoldings,
  headlineDeltas,
  movers,
  moversPeriod,
  presentation,
  privacyMode,
  returnTo,
  showDeltas,
}: {
  hasHoldings: boolean;
  headlineDeltas: FramedSnapshotDeltas;
  movers: MoversData | null;
  moversPeriod: MoversPeriod;
  presentation: NetWorthPresentation | undefined;
  privacyMode: boolean;
  returnTo: string;
  showDeltas: boolean;
}) {
  return (
    <>
      {presentation ? (
        <div className="headline">
          <span>{presentation.headlineLabel}</span>
          <strong className={hasHoldings ? undefined : "emptyFigure"}>
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

      {movers ? <HeroMovers data={movers} period={moversPeriod} /> : null}
    </>
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
  const store = await openStore();
  let state;
  try {
    state = await loadDashboard({
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
  } finally {
    store.close();
    perfEnd("dashboard", perfStartedAt);
  }

  if (state.needsOnboarding) {
    redirect("/empezar");
  }

  const { fireGlance, onboarding, pyramid, snapshots } = state;
  const selectedRangeForView = state.activeCompositionRange;
  const moversHoldingRows = selectMoversHoldingRows(
    state.snapshotHoldingRows,
    snapshots,
    moversPeriod,
  );

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
    liquid: buildMoversData({
      snapshots,
      selectedView: "liquid",
      period: moversPeriod,
      holdingRows: moversHoldingRows,
      currency,
      privacyMode,
    }),
    total: buildMoversData({
      snapshots,
      selectedView: "total",
      period: moversPeriod,
      holdingRows: moversHoldingRows,
      currency,
      privacyMode,
    }),
  } as const;
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
    <div className="dashGrid">
      <section className="summaryBand heroPanel" aria-label="Resumen patrimonial">
        <FramingPanel
          initialView={selectedView}
          liquid={
            <HeroFraming
              hasHoldings={hasHoldings}
              headlineDeltas={deltasByView.liquid}
              movers={moversByView.liquid}
              moversPeriod={moversPeriod}
              presentation={presentationByView.liquid}
              privacyMode={privacyMode}
              returnTo={returnTo}
              showDeltas={Boolean(state.deltas)}
            />
          }
          tabs={framingTabsWithHref}
          total={
            <HeroFraming
              hasHoldings={hasHoldings}
              headlineDeltas={deltasByView.total}
              movers={moversByView.total}
              moversPeriod={moversPeriod}
              presentation={presentationByView.total}
              privacyMode={privacyMode}
              returnTo={returnTo}
              showDeltas={Boolean(state.deltas)}
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
        <section className="emptyDashCta" aria-label="Empieza tu patrimonio">
          <p>Aún no has añadido nada. Empieza por lo primero.</p>
          <Link className="primaryAction" href="/patrimonio/anadir">
            Añade algo →
          </Link>
        </section>
      ) : null}

      <section className="liquidityPanel" aria-label="Liquidez por capa">
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
                  <span>Deuda {formatMoneyMinorPrivacy(tier.debts, privacyMode)}</span>
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
        className="historyPanel"
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

      <section className="firePanel" aria-label="FIRE">
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
        <section className="onboardingChecklist" aria-label="Primeros pasos">
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
  );
}
