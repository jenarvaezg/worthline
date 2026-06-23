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
  CompositionHousingMode,
  CompositionRange,
  DrilldownKey,
  FireProjection,
  FireScenario,
  FramedDelta,
  FramedSnapshotDeltas,
  LiquidityTier,
  NetWorthFraming,
  NetWorthPresentation,
  NetWorthSnapshot,
} from "@worthline/domain";
import { refreshStalePrices } from "@worthline/pricing";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  appendParam,
  parseDrillParam,
  parseRangeParam,
  parseViewParam,
  parseViviendaParam,
} from "./intake";
import { loadDashboard } from "./load-dashboard";
import type { RefreshPricesResult } from "./load-dashboard";
import CompositionPanel from "./composition-panel";
import CompositionRangeControls from "./composition-range-controls";
import DrilldownPanel from "./drilldown-panel";
import FramingPanel, { type FramingTab } from "./framing-panel";
import HeroMovers from "./hero-movers";
import type { HoldingMover, MoversData, MoversPeriod } from "./hero-movers";
import PrivacyToggle from "./privacy-toggle";
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

function compositionUrl(
  view: NetWorthFraming,
  drill: DrilldownKey | null,
  range: CompositionRange,
  housingMode: CompositionHousingMode,
  anchor = true,
): string {
  let url = "/";
  if (view === "liquid") url = appendParam(url, "view", "liquid");
  if (drill) url = appendParam(url, "drill", drill);
  if (range !== "all") url = appendParam(url, "range", range);
  if (housingMode === "hidden") url = appendParam(url, "vivienda", "oculta");
  return anchor ? `${url}#composicion` : url;
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

async function readMoversHoldingRows(
  store: Awaited<ReturnType<typeof openStore>>,
  scopeId: string | undefined,
  snapshots: NetWorthSnapshot[],
  period: MoversPeriod,
): Promise<MoversHoldingRow[]> {
  const base = moversBaseSnapshot(snapshots, period);
  if (!scopeId || !base) return [];
  return store.snapshots.readSnapshotHoldings({ scopeId, from: base.dateKey });
}

const SCENARIO_LABELS: Record<FireScenario["label"], string> = {
  optimistic: "Optimista",
  base: "Base",
  pessimistic: "Pesimista",
};

/**
 * FIRE projection card (PRD #421, #427): the base-scenario headline (years +
 * age to FIRE), the three scenarios side by side, and the year-by-year capital
 * trajectory as discrete bars (ADR 0032) with the FIRE number as a dashed
 * target. Zero JS — a server-rendered SVG.
 */
function FireProjectionCard({
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
  const selectedRange = parseRangeParam(searchParams?.range);
  const selectedHousingMode = parseViviendaParam(searchParams?.vivienda);

  const moversPeriod = parseMoversPeriod(searchParams?.mvp);

  const composicionHomeUrl = compositionUrl(
    selectedView,
    null,
    selectedRange,
    selectedHousingMode,
  );
  const drillHrefs = {
    debts: compositionUrl(selectedView, "debts", selectedRange, selectedHousingMode),
    housing: compositionUrl(selectedView, "housing", selectedRange, selectedHousingMode),
    liquid: compositionUrl(selectedView, "liquid", selectedRange, selectedHousingMode),
    rest: compositionUrl(selectedView, "rest", selectedRange, selectedHousingMode),
  };

  const housingToggleHref = compositionUrl(
    selectedView,
    selectedDrill,
    selectedRange,
    selectedHousingMode === "hidden" ? "net" : "hidden",
  );

  const now = persistence.checkedAt;
  const today = now.slice(0, 10);

  const perfStartedAt = perfStart();
  const store = await openStore();
  let state;
  let moversHoldingRows: MoversHoldingRow[] = [];
  try {
    state = await loadDashboard({
      store,
      persistence,
      scopeId,
      selectedView,
      drill: selectedDrill,
      range: selectedRange,
      today,
      now,
      refreshPrices: demo.enabled
        ? async (): Promise<RefreshPricesResult> => ({ priceCache: [], errors: [] })
        : async ({ cacheEntries, assets, nowIso }): Promise<RefreshPricesResult> => {
            return refreshAndPersistStalePrices({
              cacheEntries,
              assets,
              nowIso,
              refreshStalePrices,
              upsertPrice: (price) => store.operations.upsertPrice(price),
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
    moversHoldingRows = await readMoversHoldingRows(
      store,
      state.selectedScope?.id,
      state.snapshots,
      moversPeriod,
    );
  } finally {
    store.close();
    perfEnd("dashboard", perfStartedAt);
  }

  if (state.needsOnboarding) {
    redirect("/empezar");
  }

  const { fireProjection, fireResult, fireScopeConfig, onboarding, pyramid, snapshots } =
    state;

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
      selectedRange,
      selectedHousingMode,
      false,
    ),
    id: tab.id,
    label: tab.label,
  }));

  const rangeOptions = state.compositionRanges.map((range) => ({
    href: compositionUrl(selectedView, selectedDrill, range, selectedHousingMode),
    range,
  }));

  const anyStepPending = onboarding.some((step) => !step.done);

  const tierBpsValues = pyramid.map((tier) => tier.shareOfGrossBps);
  const tierPercents = largestRemainderPercentages(tierBpsValues);
  const donutSegments = donutArcSegments(tierPercents, TIER_DONUT_GEOMETRY);

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
      </section>

      <section className="liquidityPanel" aria-label="Liquidez por capa">
        <div className="panelHeader">
          <h2>Liquidez</h2>
          <span>Por capa · % del bruto</span>
        </div>
        <svg
          className="tierDonut"
          viewBox="0 0 100 100"
          role="img"
          aria-label="Distribución por capa de liquidez"
        >
          <circle
            className="donutTrack"
            cx={TIER_DONUT_GEOMETRY.cx}
            cy={TIER_DONUT_GEOMETRY.cy}
            r={(TIER_DONUT_GEOMETRY.outerRadius + TIER_DONUT_GEOMETRY.innerRadius) / 2}
            strokeWidth={
              TIER_DONUT_GEOMETRY.outerRadius - TIER_DONUT_GEOMETRY.innerRadius
            }
          />
          {donutSegments.map((segment) => {
            const tier = pyramid[segment.index]!;
            const drillKey = DRILL_GROUP_BY_TIER[tier.tier];
            return (
              <a
                aria-label={`${LIQUIDITY_TIER_LABELS[tier.tier]}: ${DRILL_DESTINATION_LABELS[drillKey]}`}
                href={drillHrefs[drillKey]}
                key={tier.tier}
              >
                <path className={`donutSegment ${tier.tier}`} d={segment.path}>
                  <title>{`${LIQUIDITY_TIER_LABELS[tier.tier]} · ${segment.share}%`}</title>
                </path>
              </a>
            );
          })}
        </svg>
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
        {selectedDrill && state.drilldown ? (
          // A drill stays server-rendered (its window deep-links): the range
          // pills remain plain links here — they re-window the open drill on the
          // server, the case S3's client island deliberately does not cover.
          <>
            <div className="panelHeader">
              <h2>Evolución</h2>
              <div className="historyControls">
                <CompositionRangeControls
                  options={rangeOptions}
                  selected={selectedRange}
                />
                <Link className="panelAction" href="/historico" scroll={false}>
                  Ver histórico →
                </Link>
              </div>
            </div>
            <DrilldownPanel
              backHref={composicionHomeUrl}
              currency={snapshots[0]?.totalNetWorth.currency ?? "EUR"}
              drilldown={state.drilldown}
              privacyMode={privacyMode}
            />
          </>
        ) : (
          // No drill → the range pills + chart are one client island (S3 #519):
          // toggling the window is instant, no round-trip (interaction-patterns
          // §2). The server still shipped every range's series and the right
          // initial window from the URL.
          <CompositionPanel
            currency={snapshots[0]?.totalNetWorth.currency ?? "EUR"}
            drillHrefs={drillHrefs}
            historicoLink={
              <Link className="panelAction" href="/historico" scroll={false}>
                Ver histórico →
              </Link>
            }
            housingMode={selectedHousingMode}
            housingToggleHref={housingToggleHref}
            initialRange={selectedRange}
            initialView={selectedView}
            privacyMode={privacyMode}
            rangeOptions={rangeOptions}
            seriesByRange={state.compositionSeriesByRange}
          />
        )}
      </section>

      <section className="firePanel" aria-label="FIRE">
        <div className="panelHeader">
          <h2>FIRE</h2>
          <span>Independencia financiera</span>
        </div>
        {fireScopeConfig && fireResult ? (
          <div className="fireResults">
            <div className="fireProgress">
              <p className="fireBig" aria-label="Porcentaje financiado">
                {fireResult.percentFunded.toFixed(1).replace(".", ",")} %
              </p>
              <div className="fireBar">
                {fireResult.coastFireRequired && fireResult.fireNumber.amountMinor > 0 ? (
                  <span
                    aria-hidden="true"
                    className="fireTick"
                    style={{
                      left: `${Math.min(
                        100,
                        (fireResult.coastFireRequired.amountMinor /
                          fireResult.fireNumber.amountMinor) *
                          100,
                      )}%`,
                    }}
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
            </div>
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
            {fireResult.reservedForGoals &&
            fireResult.reservedForGoals.amountMinor > 0 ? (
              <div className="fireMetric">
                <span>Reservado para objetivos</span>
                <strong className="fireReserved">
                  −{formatMoneyMinorPrivacy(fireResult.reservedForGoals, privacyMode)}
                </strong>
              </div>
            ) : null}
            <details className="fireEligibleNote">
              <summary>¿Qué cuenta como elegible?</summary>
              <p className="fireEligibleRule">
                Suma todos tus activos del ámbito actual salvo tu vivienda principal y los
                que excluyas a mano; cada activo cuenta según tu porcentaje de propiedad.
              </p>
              {fireResult.excludedAssets.length > 0 ? (
                <ul className="fireExcludedList">
                  {fireResult.excludedAssets.map((asset) => (
                    <li key={asset.id}>
                      <span>{asset.name}</span>
                      <span className="fireExcludedReason">
                        {asset.reason === "primary_residence"
                          ? "Vivienda principal"
                          : "Excluido a mano"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fireEligibleRule">
                  Ahora mismo no se excluye ningún activo: todos cuentan.
                </p>
              )}
            </details>
            {fireResult.coastFireRequired ? (
              <div className="fireMetric">
                <span>Coast FIRE requerido</span>
                <strong>
                  {formatMoneyMinorPrivacy(fireResult.coastFireRequired, privacyMode)}
                </strong>
              </div>
            ) : null}
            {fireResult.coastFireAge !== undefined ? (
              <div className="fireMetric">
                <span>Edad Coast FIRE</span>
                <strong>{fireResult.coastFireAge.toFixed(1)}</strong>
              </div>
            ) : null}
            {fireProjection ? (
              <FireProjectionCard
                currency={fireResult.fireNumber.currency}
                privacyMode={privacyMode}
                projection={fireProjection}
              />
            ) : null}
            <Link className="panelAction" href="/ajustes">
              Configurar → Ajustes
            </Link>
          </div>
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
