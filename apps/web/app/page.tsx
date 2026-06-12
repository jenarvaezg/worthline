import {
  DRILL_GROUP_BY_TIER,
  donutArcSegments,
  formatMoneyMinor,
  largestRemainderPercentages,
  moneySign,
} from "@worthline/domain";
import type {
  DrilldownKey,
  LiquidityTier,
  MoneyMinor,
  NetWorthFraming,
  NetWorthSnapshot,
} from "@worthline/domain";
import { refreshStalePrices } from "@worthline/pricing";
import { createWorthlineStore, runBootstrapHealthcheck } from "@worthline/db";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  appendParam,
  buildCurrentUrl,
  parseDrillParam,
  parseScopeParam,
  parseScopeCookie,
  parseViewParam,
  SCOPE_COOKIE_NAME,
} from "./intake";
import { loadDashboard } from "./load-dashboard";
import type { RefreshPricesResult } from "./load-dashboard";
import DecompositionChart from "./decomposition-chart";
import DrilldownPanel from "./drilldown-panel";
import EvolutionChart from "./evolution-chart";
import { refreshAndPersistStalePrices } from "./refresh-prices";
import Shell from "./shell";

export const dynamic = "force-dynamic";

const framingTabs = [
  { id: "total" as NetWorthFraming, label: "Patrimonio neto" },
  { id: "liquid" as NetWorthFraming, label: "Líquido" },
];

const TIER_LABELS: Record<LiquidityTier, string> = {
  cash: "Caja",
  market: "Mercado",
  retirement: "Jubilación",
  illiquid: "Ilíquido",
  housing: "Vivienda",
};

// Donut ring geometry in viewBox units (viewBox 0 0 100 100).
const TIER_DONUT_GEOMETRY = { cx: 50, cy: 50, innerRadius: 27, outerRadius: 45 };

// Drill destinations phrased like the decomposition band anchors (#79), so a
// donut segment and its band read the same to assistive tech.
const DRILL_DESTINATION_LABELS: Record<DrilldownKey, string> = {
  housing: "ver desglose de la vivienda",
  liquid: "ver desglose del líquido",
  rest: "ver desglose del resto",
};

const ONBOARDING_LINKS: Record<string, string> = {
  members: "/ajustes",
  holdings: "/patrimonio/nuevo-activo",
  investments: "/inversiones/nueva",
  fire: "/ajustes",
  snapshot: "/",
};

/** Headline value of a snapshot under the active framing. */
function snapshotValueMinor(
  snapshot: NetWorthSnapshot,
  framing: NetWorthFraming,
): number {
  return framing === "liquid"
    ? snapshot.liquidNetWorth.amountMinor
    : snapshot.totalNetWorth.amountMinor;
}

interface DeltaWithPct {
  change: MoneyMinor;
  /** Percent vs the base snapshot; null when the base value is zero. */
  pct: number | null;
}

/** Delta of the current snapshot vs a base one, in the active framing. */
function deltaWithPct(
  current: NetWorthSnapshot | undefined,
  base: NetWorthSnapshot | undefined,
  framing: NetWorthFraming,
): DeltaWithPct | null {
  if (!current || !base) return null;

  const currentMinor = snapshotValueMinor(current, framing);
  const baseMinor = snapshotValueMinor(base, framing);

  return {
    change: {
      amountMinor: currentMinor - baseMinor,
      currency: current.totalNetWorth.currency,
    },
    pct: baseMinor === 0 ? null : ((currentMinor - baseMinor) / Math.abs(baseMinor)) * 100,
  };
}

/** "+3,6 %" with es-ES decimal comma; sign always explicit. */
function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";

  return `${sign}${Math.abs(pct).toFixed(1).replace(".", ",")} %`;
}

/** Sign-colored delta pill: amount, percent and period label. */
function DeltaChip({ delta, label }: { delta: DeltaWithPct | null; label: string }) {
  if (!delta) {
    return (
      <span className="deltaChip zero">
        {label}: sin dato
      </span>
    );
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const selectedView = parseViewParam(resolvedSearchParams?.view);
  const selectedDrill = parseDrillParam(resolvedSearchParams?.drill);
  const currentUrl = buildCurrentUrl(resolvedSearchParams);

  // Drill navigation (#76, #77): every URL preserves the selected Vista.
  const viewHomeUrl = selectedView === "total" ? "/" : `/?view=${selectedView}`;
  const drillHrefs = {
    housing: appendParam(viewHomeUrl, "drill", "housing"),
    liquid: appendParam(viewHomeUrl, "drill", "liquid"),
    rest: appendParam(viewHomeUrl, "drill", "rest"),
  };

  const jar = await cookies();
  const queryScopeId = parseScopeParam(resolvedSearchParams?.scope);
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const now = persistence.checkedAt;
  const today = now.slice(0, 10);

  const store = createWorthlineStore();
  let state;
  try {
    state = await loadDashboard({
      store,
      persistence,
      scopeId: queryScopeId ?? cookieScopeId,
      selectedView,
      drill: selectedDrill,
      today,
      now,
      refreshPrices: async ({
        cacheEntries,
        assets,
        nowIso,
      }): Promise<RefreshPricesResult> => {
        return refreshAndPersistStalePrices({
          cacheEntries,
          assets,
          nowIso,
          refreshStalePrices,
          upsertPrice: (price) => store.upsertPrice(price),
          readCache: () => store.readAllPriceCacheEntries(),
        });
      },
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
    onboarding,
    presentation,
    pyramid,
    scopes,
    selectedScope,
    snapshots,
    warnings,
  } = state;

  const hasHoldings = state.assets.length + state.liabilities.length > 0;

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

  // Hero delta chips — change vs previous snapshot and vs monthly close,
  // with percent, in the active framing.
  const vsPrevious = deltaWithPct(
    deltas?.snapshot,
    deltas?.previousSnapshot,
    selectedView,
  );
  const vsMonthlyClose = deltaWithPct(
    deltas?.snapshot,
    deltas?.previousMonthlyClose,
    selectedView,
  );

  return (
    <Shell {...shellProps}>
      <div className="dashGrid">
        {/* ── 1. Hero — the one dark ink panel: framing selector, headline,
               delta chips with %, breakdown stats (docs/design-system.md) ── */}
        <section className="summaryBand heroPanel" aria-label="Resumen patrimonial">
          <div className="resumenHeader">
            <nav className="framingTabs" aria-label="Vista de patrimonio">
              {framingTabs.map((tab) => (
                <Link
                  className={tab.id === selectedView ? "active" : undefined}
                  href={
                    selectedDrill
                      ? appendParam(`/?view=${tab.id}`, "drill", selectedDrill)
                      : `/?view=${tab.id}`
                  }
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
      <section className="historyPanel" aria-label="Evolución del patrimonio">
        <div className="panelHeader">
          <h2>Evolución</h2>
          <Link className="panelAction" href="/historico" scroll={false}>
            Ver histórico →
          </Link>
        </div>
        <EvolutionChart framing={selectedView} snapshots={snapshots} />
        {/* Decomposition — always splits NET WORTH (framing-invariant):
            liquid (green), housing (gold), rest (blue). When a drill is
            active (#76, #77) the drill panel renders in its place, with a
            breadcrumb back that preserves the Vista. */}
        {selectedDrill && state.drilldown ? (
          <DrilldownPanel
            backHref={viewHomeUrl}
            currency={snapshots[0]?.totalNetWorth.currency ?? "EUR"}
            drilldown={state.drilldown}
          />
        ) : (
          <DecompositionChart drillHrefs={drillHrefs} snapshots={snapshots} />
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
              <strong>{formatMoneyMinor(fireResult.fireNumber)}</strong>
            </div>
            <div className="fireMetric">
              <span>Activos elegibles</span>
              <strong>{formatMoneyMinor(fireResult.eligibleAssets)}</strong>
            </div>
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
