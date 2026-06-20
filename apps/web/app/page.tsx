import {
  DRILL_GROUP_BY_TIER,
  donutArcSegments,
  formatMoneyMinor,
  largestRemainderPercentages,
  moneySign,
} from "@worthline/domain";
import type {
  CompositionHousingMode,
  CompositionRange,
  DrilldownKey,
  FramedDelta,
  LiquidityTier,
  NetWorthFraming,
} from "@worthline/domain";
import { refreshStalePrices } from "@worthline/pricing";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  appendParam,
  buildCurrentUrl,
  parseDrillParam,
  parseRangeParam,
  parseScopeParam,
  parseScopeCookie,
  parseViewParam,
  parseViviendaParam,
  SCOPE_COOKIE_NAME,
} from "./intake";
import { loadDashboard } from "./load-dashboard";
import type { RefreshPricesResult } from "./load-dashboard";
import CompositionChart from "./composition-chart";
import CompositionRangeControls from "./composition-range-controls";
import DrilldownPanel from "./drilldown-panel";
import { runBinanceRefresh } from "./ajustes/binance-refresh";
import { runNumistaCoinRefresh } from "./ajustes/numista-coin-refresh";
import { refreshAndPersistStalePrices } from "./refresh-prices";
import Shell from "./shell";
import { readDemoContext } from "@web/demo/read-demo-context";
import { bootstrapHealthcheck, openStore } from "@web/store";

export const dynamic = "force-dynamic";

const framingTabs = [
  { id: "total" as NetWorthFraming, label: "Patrimonio neto" },
  { id: "liquid" as NetWorthFraming, label: "Líquido" },
];

const TIER_LABELS: Record<LiquidityTier, string> = {
  cash: "Caja",
  market: "Mercado",
  "term-locked": "A plazo",
  illiquid: "Ilíquido",
  housing: "Vivienda",
};

// Donut ring geometry in viewBox units (viewBox 0 0 100 100).
const TIER_DONUT_GEOMETRY = { cx: 50, cy: 50, innerRadius: 27, outerRadius: 45 };

// Drill destinations phrased like the decomposition band anchors (#79), so a
// donut segment and its band read the same to assistive tech.
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

/** "+3,6 %" with es-ES decimal comma; sign always explicit. */
function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";

  return `${sign}${Math.abs(pct).toFixed(1).replace(".", ",")} %`;
}

/** Sign-colored delta pill: amount, percent and period label. */
function DeltaChip({ delta, label }: { delta: FramedDelta | null; label: string }) {
  if (!delta) {
    return <span className="deltaChip zero">{label}: sin dato</span>;
  }

  const sign = moneySign(delta.change);
  const arrow = sign === "pos" ? "▲" : sign === "neg" ? "▼" : "•";
  const prefix = delta.change.amountMinor > 0 ? "+" : "";

  return (
    <span className={`deltaChip ${sign}`}>
      {arrow} {prefix}
      {formatMoneyMinor(delta.change)}
      {delta.pct !== null ? ` (${formatPct(delta.pct)})` : ""} {label}
    </span>
  );
}

/**
 * A composition-area URL preserving the framing, an optional drill, the temporal
 * range (#144/#145) and the Vivienda presentation. Clean defaults are omitted
 * (total view, no drill, the `all` range, net Vivienda). The `#composicion`
 * fragment anchors full-document <a> navigation to the chart panel (ADR 0009);
 * the hero's framing tabs pass `anchor = false` so switching Vista does not
 * scroll away from the headline. Threading `housingMode` through here is what
 * keeps the "Ocultar vivienda" choice alive across every range/view/drill change.
 */
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = await bootstrapHealthcheck();
  const demo = await readDemoContext();
  const selectedView = parseViewParam(resolvedSearchParams?.view);
  const selectedDrill = parseDrillParam(resolvedSearchParams?.drill);
  const selectedRange = parseRangeParam(resolvedSearchParams?.range);
  const selectedHousingMode = parseViviendaParam(resolvedSearchParams?.vivienda);
  const currentUrl = buildCurrentUrl(resolvedSearchParams);

  // Drill navigation (#76, #77, #145): every URL preserves the selected Vista,
  // the temporal range (#144) AND the Vivienda presentation, so changing one
  // dimension never resets the others. The `#composicion` fragment anchors the
  // full-document <a> navigation (ADR 0009) to the composition panel instead of
  // the page top, so a drill leaves the reader where they were (#143 follow-up).
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

  // The "Ocultar/Mostrar vivienda" toggle: preserves Vista + range + drill while
  // flipping only the Vivienda dimension (net ⇄ hidden) — URL state, not a client
  // gesture (ADR 0009), so it persists across navigation.
  const housingToggleHref = compositionUrl(
    selectedView,
    selectedDrill,
    selectedRange,
    selectedHousingMode === "hidden" ? "net" : "hidden",
  );

  const jar = await cookies();
  const queryScopeId = parseScopeParam(resolvedSearchParams?.scope);
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const now = persistence.checkedAt;
  const today = now.slice(0, 10);

  const store = await openStore();
  let state;
  try {
    state = await loadDashboard({
      store,
      persistence,
      scopeId: queryScopeId ?? cookieScopeId,
      selectedView,
      drill: selectedDrill,
      range: selectedRange,
      today,
      now,
      // Demo mode never reaches out (ADR 0029): the fixture is frozen, so price
      // refresh is a no-op and the connected-source refreshers are omitted.
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
  } finally {
    store.close();
  }

  if (state.needsOnboarding) {
    redirect("/empezar");
  }

  const {
    dashboard,
    deltas,
    fireResult,
    fireScopeConfig,
    headlineDeltas,
    onboarding,
    presentation,
    pyramid,
    scopes,
    selectedScope,
    snapshots,
    warnings,
  } = state;

  const hasHoldings = state.assets.length + state.liabilities.length > 0;

  // Range controls (#144): the ranges this scope's history actually spans, each
  // a link that sets the range while preserving the Vista and any active drill.
  const rangeOptions = state.compositionRanges.map((range) => ({
    href: compositionUrl(selectedView, selectedDrill, range, selectedHousingMode),
    range,
  }));

  // Onboarding checklist: show while ANY step is still pending.
  const anyStepPending = onboarding.some((step) => !step.done);

  // Liquidity tier percentages — largest-remainder so they sum to 100.
  const tierBpsValues = pyramid.map((tier) => tier.shareOfGrossBps);
  const tierPercents = largestRemainderPercentages(tierBpsValues);

  // Tier donut: arc segments over the same percentages the rows display,
  // so the visual summary and the row text always agree.
  const donutSegments = donutArcSegments(tierPercents, TIER_DONUT_GEOMETRY);

  const shellProps = {
    activeSection: "resumen" as const,
    currentPageUrl: currentUrl,
    persistence: dashboard.persistence,
    scopes,
    selectedScopeId: selectedScope?.id,
    warnings: warnings.map((w) => ({
      code: w.code,
      entityId: w.entityId,
      message: w.message,
    })),
  };

  // Hero delta chips — change vs previous snapshot and vs monthly close, with
  // percent, framed and computed behind the read contract (#244). The page only
  // renders them.
  const { sincePrevious: vsPrevious, sinceMonthlyClose: vsMonthlyClose } = headlineDeltas;

  return (
    <Shell {...shellProps}>
      <div className="dashGrid">
        {/* ── 1. Hero — light card with a subtle green tint: framing selector,
               headline, delta chips with %, breakdown stats (docs/design-system.md) ── */}
        <section className="summaryBand heroPanel" aria-label="Resumen patrimonial">
          <div className="resumenHeader">
            <nav className="framingTabs" aria-label="Vista de patrimonio">
              {framingTabs.map((tab) => (
                <Link
                  className={tab.id === selectedView ? "active" : undefined}
                  href={compositionUrl(
                    tab.id,
                    selectedDrill,
                    selectedRange,
                    selectedHousingMode,
                    false,
                  )}
                  key={tab.id}
                  scroll={false}
                >
                  {tab.label}
                </Link>
              ))}
            </nav>
          </div>

          {presentation ? (
            <div className="headline">
              <span>{presentation.headlineLabel}</span>
              <strong className={hasHoldings ? undefined : "emptyFigure"}>
                {formatMoneyMinor(presentation.headline)}
                {!hasHoldings ? <small>sin datos aún</small> : null}
              </strong>
            </div>
          ) : null}

          {deltas ? (
            <div className="deltaChips" aria-label="Cambios de snapshots">
              <DeltaChip delta={vsPrevious} label="vs anterior" />
              <DeltaChip delta={vsMonthlyClose} label="vs cierre mensual" />
            </div>
          ) : null}

          {/* ── Breakdown — always visible: Neto líquido · Vivienda · Brutos · Deudas ── */}
          {presentation ? (
            <div className="heroStats">
              {presentation.breakdown.map((item) => (
                <div className="heroStat" key={item.id}>
                  <span>{item.label}</span>
                  <b className={hasHoldings ? undefined : "emptyFigure"}>
                    {formatMoneyMinor(item.value)}
                  </b>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {/* ── 2. Liquidez — donut with drill anchors + dense tier rows with
               embedded share bars ── */}
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
              // Native SVG anchor to the segment's drill group (#79) — same
              // destinations as the decomposition bands, Vista preserved, zero
              // client JS (ADR 0009).
              return (
                <a
                  aria-label={`${TIER_LABELS[tier.tier]}: ${DRILL_DESTINATION_LABELS[drillKey]}`}
                  href={drillHrefs[drillKey]}
                  key={tier.tier}
                >
                  <path className={`donutSegment ${tier.tier}`} d={segment.path}>
                    <title>{`${TIER_LABELS[tier.tier]} · ${segment.share}%`}</title>
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
                    <span className="tierName">{TIER_LABELS[tier.tier]}</span>
                    {/* Green stays reserved for deltas/P&L — tier values render
                        in ink, only a negative net goes red. */}
                    <b className={moneySign(tier.netValue) === "neg" ? "neg" : undefined}>
                      {formatMoneyMinor(tier.netValue)}
                    </b>
                    <span className="tierShare">{pct}%</span>
                    <span className="tierBar" aria-hidden="true">
                      <i style={{ width: `${pct}%` }} />
                    </span>
                  </summary>
                  <div className="tierDetails">
                    <span>Bruto {formatMoneyMinor(tier.grossAssets)}</span>
                    <span>Deuda {formatMoneyMinor(tier.debts)}</span>
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

        {/* ── 3. Evolution — server-rendered SVG area chart of the headline
             figure, with value/date axes; the hero chips are its numeric legend ── */}
        <section
          className="historyPanel"
          id="composicion"
          aria-label="Evolución del patrimonio"
        >
          <div className="panelHeader">
            <h2>Evolución</h2>
            <div className="historyControls">
              <CompositionRangeControls options={rangeOptions} selected={selectedRange} />
              <Link className="panelAction" href="/historico" scroll={false}>
                Ver histórico →
              </Link>
            </div>
          </div>
          {/* Composition (#142) — the single historical chart: gross asset bands
            stack above zero (four liquidity rungs + Vivienda from the property
            instrument), one aggregated debt stack below, a net-worth line over
            the total. Framing-invariant. When a drill is active (#76, #77) the
            drill panel renders in its place, breadcrumb back preserving the Vista. */}
          {selectedDrill && state.drilldown ? (
            <DrilldownPanel
              backHref={composicionHomeUrl}
              currency={snapshots[0]?.totalNetWorth.currency ?? "EUR"}
              drilldown={state.drilldown}
            />
          ) : (
            <CompositionChart
              currency={snapshots[0]?.totalNetWorth.currency ?? "EUR"}
              drillHrefs={drillHrefs}
              housingMode={selectedHousingMode}
              housingToggleHref={housingToggleHref}
              points={state.compositionSeries}
            />
          )}
        </section>

        {/* ── 4. FIRE card — funded percent leads, read-only, link to /ajustes ── */}
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
                  {fireResult.coastFireRequired &&
                  fireResult.fireNumber.amountMinor > 0 ? (
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
                <strong>{formatMoneyMinor(fireResult.fireNumber)}</strong>
              </div>
              <div className="fireMetric">
                <span>Activos elegibles</span>
                <strong>{formatMoneyMinor(fireResult.eligibleAssets)}</strong>
              </div>
              <details className="fireEligibleNote">
                <summary>¿Qué cuenta como elegible?</summary>
                <p className="fireEligibleRule">
                  Suma todos tus activos del ámbito actual salvo tu vivienda principal y
                  los que excluyas a mano; cada activo cuenta según tu porcentaje de
                  propiedad.
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
                  <strong>{formatMoneyMinor(fireResult.coastFireRequired)}</strong>
                </div>
              ) : null}
              {fireResult.coastFireAge !== undefined ? (
                <div className="fireMetric">
                  <span>Edad Coast FIRE</span>
                  <strong>{fireResult.coastFireAge.toFixed(1)}</strong>
                </div>
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

        {/* ── 5. Onboarding checklist — shown while any step is pending ── */}
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
    </Shell>
  );
}
