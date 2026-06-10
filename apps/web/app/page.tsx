import {
  donutArcSegments,
  formatMoneyMinor,
  largestRemainderPercentages,
  moneySign,
} from "@worthline/domain";
import type { LiquidityTier, NetWorthFraming } from "@worthline/domain";
import { refreshStalePrices } from "@worthline/pricing";
import { createWorthlineStore, runBootstrapHealthcheck } from "@worthline/db";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  buildCurrentUrl,
  parseScopeCookie,
  parseViewParam,
  SCOPE_COOKIE_NAME,
} from "./intake";
import { loadDashboard } from "./load-dashboard";
import type { RefreshPricesResult } from "./load-dashboard";
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

const ONBOARDING_LINKS: Record<string, string> = {
  members: "/ajustes",
  holdings: "/patrimonio/nuevo-activo",
  investments: "/inversiones/nueva",
  fire: "/ajustes",
  snapshot: "/",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const selectedView = parseViewParam(resolvedSearchParams?.view);
  const currentUrl = buildCurrentUrl(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const now = persistence.checkedAt;
  const today = now.slice(0, 10);

  const store = createWorthlineStore();
  let state;
  try {
    state = await loadDashboard({
      store,
      persistence,
      scopeId: cookieScopeId,
      selectedView,
      today,
      now,
      refreshPrices: async ({ cacheEntries, assets, nowIso }): Promise<RefreshPricesResult> => {
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
  return (
    <Shell
      activeSection="resumen"
      currentPageUrl={currentUrl}
      persistence={dashboard.persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={warnings.map((w) => ({
        code: w.code,
        entityId: w.entityId,
        message: w.message,
      }))}
    >
      {/* ── 1. Headline — framing selector visibly labeled beside the hero ── */}
      <section className="summaryBand" aria-label="Resumen patrimonial">
        <div className="resumenHeader">
          <nav className="framingTabs" aria-label="Vista de patrimonio">
            {framingTabs.map((tab) => (
              <Link
                className={tab.id === selectedView ? "active" : undefined}
                href={`/?view=${tab.id}`}
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

        {/* ── 2. Breakdown — always visible: Activos brutos · Deudas · Vivienda · Líquido ── */}
        {presentation ? (
          <div className="breakdown">
            {presentation.breakdown.map((item) => (
              <span key={item.id}>
                {item.label}{" "}
                <b className={hasHoldings ? undefined : "emptyFigure"}>
                  {formatMoneyMinor(item.value)}
                </b>
              </span>
            ))}
          </div>
        ) : null}

        {/* ── Delta strip ── */}
        {deltas ? (
          <div className="deltaStrip" aria-label="Cambios de snapshots">
            <span>
              Snapshot anterior{" "}
              <b
                className={
                  deltas.changeSincePrevious
                    ? moneySign(deltas.changeSincePrevious)
                    : undefined
                }
              >
                {deltas.changeSincePrevious
                  ? formatMoneyMinor(deltas.changeSincePrevious)
                  : "sin dato"}
              </b>
            </span>
            <span>
              Cierre mensual{" "}
              <b
                className={
                  deltas.changeSinceMonthlyClose
                    ? moneySign(deltas.changeSinceMonthlyClose)
                    : undefined
                }
              >
                {deltas.changeSinceMonthlyClose
                  ? formatMoneyMinor(deltas.changeSinceMonthlyClose)
                  : "sin dato"}
              </b>
            </span>
          </div>
        ) : null}
      </section>

      {/* ── 3. Evolution — server-rendered SVG area chart of the headline
             figure; the delta strip above acts as its numeric legend ── */}
      <section className="historyPanel" aria-label="Evolución del patrimonio">
        <div className="panelHeader">
          <h2>Evolución</h2>
          <Link className="panelAction" href="/historico" scroll={false}>
            Ver histórico →
          </Link>
        </div>
        <EvolutionChart framing={selectedView} snapshots={snapshots} />
      </section>

      {/* ── 4. Composition — liquidity breakdown, 5 tiers ── */}
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
            strokeWidth={TIER_DONUT_GEOMETRY.outerRadius - TIER_DONUT_GEOMETRY.innerRadius}
          />
          {donutSegments.map((segment) => {
            const tier = pyramid[segment.index]!;
            return (
              <path
                className={`donutSegment ${tier.tier}`}
                d={segment.path}
                key={tier.tier}
              >
                <title>{`${TIER_LABELS[tier.tier]} · ${segment.share}%`}</title>
              </path>
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
                  <b className={moneySign(tier.netValue)}>
                    {formatMoneyMinor(tier.netValue)}
                  </b>
                  <span className="tierShare">{pct}%</span>
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

      {/* ── 5. FIRE card — read-only, full chrome, link to /ajustes ── */}
      <section className="firePanel" aria-label="FIRE">
        <div className="panelHeader">
          <h2>FIRE</h2>
          <span>Independencia financiera</span>
        </div>
        {fireScopeConfig && fireResult ? (
          <div className="fireResults">
            <div className="fireMetric">
              <span>Número FIRE</span>
              <strong>{formatMoneyMinor(fireResult.fireNumber)}</strong>
            </div>
            <div className="fireMetric">
              <span>Activos elegibles</span>
              <strong>{formatMoneyMinor(fireResult.eligibleAssets)}</strong>
            </div>
            <div className="fireProgress">
              <div className="fireProgressTop">
                <span>% financiado</span>
                <strong>{fireResult.percentFunded.toFixed(1)}%</strong>
              </div>
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

      {/* ── 6. Onboarding checklist — shown while any step is pending ── */}
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
                  <Link href={ONBOARDING_LINKS[step.id] ?? "/"}>
                    ○ {step.label}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </Shell>
  );
}
