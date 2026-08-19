/**
 * The FIRE panel of /objetivos — the auditable one (#1426).
 *
 * Every derived figure here says where it comes from: the FIRE number carries its
 * division, the funded percentage carries its noun and its fraction, progress
 * toward Coast is the reader's and not the tick's, and the projection's
 * assumptions (rates, contribution, ages, and the weighting behind the rate) open
 * in a fold under the chart. Nothing is re-derived: the numbers arrive from
 * `calculateFireForScope` / `projectFireFromContext` and the pure view modules
 * beside this file only word them.
 *
 * Server-rendered (interaction-patterns §1): the only interaction is native
 * `<details>`, so there is no island and no client rate math.
 */

import FireAchievementBadge from "@web/fire-achievement-badge";
import FireProjectionCard from "@web/fire-projection-card";
import type {
  FireAchievement,
  FireAgeSource,
  FireLevel,
  FireProjection,
  FireScopeConfig,
  SavingsCoherence,
  ScopeFireResult,
} from "@worthline/domain";
import { describeSavingsDivergence, formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import {
  fireAssumptionRows,
  fireReturnMixPrintRows,
  fireReturnMixTotal,
} from "./fire-assumptions-view";
import {
  fireCapitalSplitRows,
  sellableFundedPercent,
  shouldShowCapitalSplit,
} from "./fire-capital-split-view";
import { coastProgressPercent, fireFundedView } from "./fire-funding-view";
import { formatFirePercent, formatRatePercent } from "./fire-percent";
import { fireRentReturnLines } from "./fire-rent-return-view";

export interface FirePanelProps {
  achievement: FireAchievement | null;
  /** Where the reference age came from (#1415), for the assumptions fold. */
  ageSource: FireAgeSource | null;
  coastTickFraction: number | null;
  currency: string;
  fireLevelRail: FireLevel[] | null;
  fireProjection: FireProjection | null;
  fireResult: ScopeFireResult | null;
  privacyMode: boolean;
  savingsCoherence: SavingsCoherence | null;
}

function FireLevelCard({
  level,
  currency,
  privacyMode,
  safeWithdrawalRate,
}: {
  level: FireLevel;
  currency: string;
  privacyMode: boolean;
  /** The withdrawal rate the level was built with, so the card can say what it funds. */
  safeWithdrawalRate: number;
}) {
  const reached = level.eta.kind === "reached";
  const etaLabel =
    level.eta.kind === "reached"
      ? "alcanzado"
      : level.eta.kind === "unreachable"
        ? "—"
        : level.eta.years === 0
          ? "este año"
          : `en ~${level.eta.years.toFixed(1).replace(".", ",")} años`;
  // What the level buys, which is what makes it legible: a capital figure alone
  // says nothing about the life it pays for (#1426).
  const fundsAnnualMinor = Math.round(level.amountMinor * safeWithdrawalRate);

  return (
    <div className={`fireLevelCard${reached ? " fireLevelCard--reached" : ""}`}>
      <span className="fireLevelLabel">{level.label}</span>
      <strong className="fireLevelAmount">
        {formatMoneyMinorPrivacy(
          { amountMinor: level.amountMinor, currency },
          privacyMode,
        )}
      </strong>
      <span className="fireLevelFunds">
        financia{" "}
        {formatMoneyMinorPrivacy(
          { amountMinor: fundsAnnualMinor, currency },
          privacyMode,
        )}
        /año
      </span>
      <span className={`fireLevelEta${reached ? " fireLevelEta--reached" : ""}`}>
        {etaLabel}
      </span>
    </div>
  );
}

export function FirePanel({
  achievement,
  ageSource,
  coastTickFraction,
  currency,
  fireLevelRail,
  fireProjection,
  fireResult,
  privacyMode,
  savingsCoherence,
}: FirePanelProps) {
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);

  // The config the figures were computed FROM, not a second copy of it: the context
  // carries it (#1026), so the assumptions this panel prints cannot be a different
  // spending or withdrawal rate than the ones the number above them came out of.
  const config: FireScopeConfig | null = fireResult?.context.config ?? null;

  // What the sellable side alone funds (#1447): the figure the single
  // "% financiado" hides when most of the pool is brick.
  const sellableFunded = fireResult
    ? sellableFundedPercent(fireResult.capitalSplit, fireResult.fireNumber.amountMinor)
    : null;

  // What the declared rents did to the expected return (#1448): the properties
  // whose net yield replaced their rung's guess, and the rents the rate refused to
  // read as gross. Empty for a portfolio with no declared rent.
  // Gated on the rate actually being the derived one: with a manual
  // `expectedRealReturn` the substitution changes nothing, and a panel promising an
  // effect the override cancels would be worse than silence.
  const rentReturnLines =
    fireResult && config?.expectedRealReturn === undefined
      ? fireRentReturnLines({ formatMoney: fmt, report: fireResult.rentReturns })
      : [];

  const funded = fireResult
    ? fireFundedView({ formatMoney: fmt, result: fireResult })
    : null;
  const coastProgress = fireResult
    ? coastProgressPercent(
        fireResult.eligibleAssets.amountMinor,
        fireResult.coastFireRequired?.amountMinor,
      )
    : null;
  const assumptionRows =
    fireResult && config
      ? fireAssumptionRows({
          ageSource,
          config,
          formatMoney: fmt,
          projection: fireProjection,
          result: fireResult,
        })
      : [];
  // The weighting is only an explanation of the rate in use when the rate IS the
  // weighted one: with a manual override the table would explain a number the
  // projection ignored.
  const mixRows =
    fireResult && config?.expectedRealReturn === undefined
      ? fireReturnMixPrintRows(fireResult.returnMix)
      : [];
  const mixTotal = fireResult ? fireReturnMixTotal(fireResult.returnMix) : null;

  return (
    <section className="firePanel objetivosFirePanel" aria-label="FIRE">
      <div className="panelHeader">
        <h3>Independencia financiera · FIRE</h3>
        <span>objetivo principal</span>
      </div>

      {fireResult && config && funded ? (
        <div className="objetivosHeroGrid">
          {/* Left: % funded + bar + coast + metrics */}
          <div className="objetivosHeroLeft">
            {/* The noun matters: a lone «68,5 %» reads as a probability of
                arriving, not as the share of the target already funded (#1426). */}
            <p className="fireBig">
              {funded.percent} <span className="fireBigNoun">financiado</span>
            </p>
            <p className="fireFundedFraction">{funded.fraction}</p>

            <div className="fireBar">
              {coastTickFraction !== null ? (
                <span
                  aria-hidden="true"
                  className="fireTick"
                  style={{ left: `${coastTickFraction * 100}%` }}
                />
              ) : null}
              <i
                style={{
                  width: `${Math.min(100, Math.max(0, fireResult.percentFunded))}%`,
                }}
              />
            </div>

            {achievement ? (
              <FireAchievementBadge
                achievement={achievement}
                currency={currency}
                privacyMode={privacyMode}
              />
            ) : null}

            {/* Declarado vs medido (#1449): la proyección de arriba corre sobre
                la capacidad de ahorro declarada, y el libro de operaciones es lo
                único que puede contradecirla sin que nadie teclee nada. El aviso
                no dicta cuál de las dos cifras está mal. */}
            {savingsCoherence?.state === "diverged" ? (
              <p className="objetivosSavingsGap" role="status">
                {describeSavingsDivergence(savingsCoherence, currency, privacyMode)}{" "}
                <Link href="/ajustes">Ajustar en Ajustes</Link>
              </p>
            ) : null}

            {/* Coast FIRE explainer */}
            {coastTickFraction !== null ? (
              <p className="objetivosCoastNote">
                El tick <span aria-hidden="true">▏</span> marca{" "}
                <strong>Coast FIRE</strong>: si alcanzas esa cifra hoy y dejas de aportar,
                el interés compuesto hace el resto — el capital crece solo hasta tu número
                FIRE para la jubilación.
              </p>
            ) : null}

            <div className="fireResults objetivosMetrics">
              <div className="fireMetric">
                <span>Número FIRE</span>
                <strong>
                  {formatMoneyMinorPrivacy(fireResult.fireNumber, privacyMode)}
                </strong>
              </div>
              {/* La cifra con su aritmética delante (#1426): los dos insumos son
                  suyos y editables, así que se nombran junto al resultado. */}
              {/* Los dos insumos son suyos y editables, así que llevan a donde se
                  editan: una cifra derivada que no se puede rastrear ni cambiar es
                  la que se lee como constante física. */}
              <p className="fireFormula">
                <Link href="/ajustes">
                  {fmt(config.monthlySpendingMinor * 12)}/año de gasto
                </Link>{" "}
                ÷{" "}
                <Link href="/ajustes">
                  {formatRatePercent(config.safeWithdrawalRate)} de retirada
                </Link>{" "}
                = <strong>{fmt(fireResult.fireNumber.amountMinor)}</strong>
              </p>
              <div className="fireMetric">
                <span>Activos elegibles</span>
                <strong>
                  {formatMoneyMinorPrivacy(fireResult.eligibleAssets, privacyMode)}
                </strong>
              </div>
              {/* Vendible vs inmovilizado (#1447): la misma cifra de arriba,
                  partida por naturaleza. Una tasa de retirada supone capital
                  que se vende a trozos; el ladrillo no lo es. */}
              {shouldShowCapitalSplit(fireResult.capitalSplit) ? (
                <ul
                  aria-label="Desglose de los activos elegibles"
                  className="fireCapitalSplit"
                >
                  {fireCapitalSplitRows(fireResult.capitalSplit).map((row) => (
                    <li className={`fireCapitalRow is-${row.key}`} key={row.key}>
                      <span className="fireCapitalLabel">{row.label}</span>
                      {/* La glosa se recorta en la columna estrecha del hero:
                          el título la devuelve entera sin partir la fila. */}
                      <span className="fireCapitalGloss" title={row.gloss}>
                        {row.gloss}
                      </span>
                      <strong>
                        {formatMoneyMinorPrivacy(
                          { amountMinor: row.amountMinor, currency },
                          privacyMode,
                        )}
                      </strong>
                    </li>
                  ))}
                </ul>
              ) : null}
              {fireResult.coastFireRequired ? (
                <div className="fireMetric">
                  <span>Coast requerido</span>
                  <strong>
                    {formatMoneyMinorPrivacy(fireResult.coastFireRequired, privacyMode)}
                  </strong>
                </div>
              ) : null}
              {/* «Cuánto me falta para poder dejar de aportar» — el progreso del
                  lector hacia Coast, no la posición del tick (#1426). */}
              {coastProgress !== null ? (
                <div className="fireMetric">
                  <span>Hacia Coast llevas</span>
                  <strong>{formatFirePercent(coastProgress)}</strong>
                </div>
              ) : null}
              {config.currentAge !== undefined &&
              fireResult.coastFireAge !== undefined ? (
                <div className="fireMetric">
                  <span>Edad Coast</span>
                  <strong>{fireResult.coastFireAge.toFixed(1).replace(".", ",")}</strong>
                </div>
              ) : null}
            </div>

            {/* «¿Qué cuenta como elegible?» disclosure — derived from the
                  same rule FIRE uses: all scope assets except isPrimaryResidence
                  and manually excluded ones (config.excludedAssetIds). */}
            <details suppressHydrationWarning className="fireEligibleNote">
              <summary>¿Qué cuenta como activo elegible?</summary>
              <p className="fireEligibleRule">
                Cuentan todos los activos del ámbito excepto la{" "}
                <strong>vivienda habitual</strong> y los que hayas excluido manualmente en
                Ajustes. Cash, inversiones y criptos cuentan.
              </p>
              {shouldShowCapitalSplit(fireResult.capitalSplit) ? (
                <p className="fireEligibleRule">
                  La tasa de retirada supone capital que se{" "}
                  <strong>vende a trozos</strong> y se rebalancea. Tu parte{" "}
                  <strong>inmovilizada</strong> (vivienda no habitual, colecciones) es
                  patrimonio, pero no se gasta a plazos: la deuda de cada inmueble se
                  resta dentro de ese mismo lado.
                  {sellableFunded !== null ? (
                    <>
                      {" "}
                      Solo con lo vendible estarías al{" "}
                      <strong>{formatFirePercent(sellableFunded)}</strong> de tu número
                      FIRE.
                    </>
                  ) : null}
                </p>
              ) : null}
              {fireResult.excludedAssets.length > 0 ? (
                <ul className="fireExcludedList">
                  {fireResult.excludedAssets.map((a) => (
                    <li key={a.id}>
                      <span>{a.name}</span>
                      <span className="fireExcludedReason">
                        {a.reason === "primary_residence"
                          ? "vivienda habitual"
                          : "excluido manualmente"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          </div>

          {/* Right: 3 scenarios + large trajectory + the assumptions behind them */}
          <div className="objetivosHeroRight">
            {fireProjection ? (
              <FireProjectionCard
                formatMoney={fmt}
                projection={fireProjection}
                {...(config.currentAge === undefined
                  ? {}
                  : { currentAge: config.currentAge })}
              />
            ) : (
              <p className="objetivosSubNote">
                Añade tu año de nacimiento en Ajustes para ver la proyección.
              </p>
            )}

            {/* Los supuestos de la proyección, visibles (#1426): sin ellos las tres
                tarjetas son una caja negra — nada dice por qué 8, 11 y 18 años. */}
            {assumptionRows.length > 0 ? (
              <details suppressHydrationWarning className="fireAssumptions">
                <summary>¿De dónde salen estos años?</summary>
                <dl className="fireAssumptionList">
                  {assumptionRows.map((row) => (
                    <div className="fireAssumptionRow" key={row.key}>
                      <dt>{row.label}</dt>
                      <dd>
                        <strong>{row.value}</strong>
                        {row.gloss ? (
                          <span className="fireAssumptionGloss">{row.gloss}</span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>

                {mixRows.length > 0 && mixTotal ? (
                  <table className="fireMixTable">
                    <caption>
                      Tu rentabilidad base es la media ponderada de tus tramos — el peso
                      de cada uno es lo que la explica.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Tramo</th>
                        <th scope="col">Peso</th>
                        <th scope="col">Retorno</th>
                        <th scope="col">Aporta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mixRows.map((row) => (
                        <tr
                          className={row.isAsset ? "fireMixRow--asset" : undefined}
                          key={row.key}
                        >
                          <th scope="row">{row.label}</th>
                          <td>{row.weight}</td>
                          <td>{row.rate}</td>
                          <td>{row.contribution}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Total</th>
                        <td>{mixTotal.weight}</td>
                        <td />
                        <td>{mixTotal.contribution}</td>
                      </tr>
                    </tfoot>
                  </table>
                ) : null}
              </details>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="fireEmpty">
          <p className="fireEmptyHint">
            FIRE no está configurado para este ámbito. Añade tus supuestos en Ajustes para
            ver cuándo alcanzas la independencia financiera.
          </p>
          <Link className="panelAction" href="/ajustes">
            Configurar FIRE → Ajustes
          </Link>
        </div>
      )}

      {/* ── Niveles FIRE rail (N1, #513) ──────────────────────── */}
      {fireLevelRail && config ? (
        <section aria-label="Niveles FIRE" className="fireLevelsRail">
          <h4 className="fireLevelsTitle">Niveles FIRE</h4>
          <div className="fireLevelsGrid">
            {fireLevelRail.map((level) => (
              <FireLevelCard
                currency={currency}
                key={level.key}
                level={level}
                privacyMode={privacyMode}
                safeWithdrawalRate={config.safeWithdrawalRate}
              />
            ))}
          </div>
          {/* Los multiplicadores que definen los niveles: sin ellos, «Lean» y
              «Fat» son etiquetas sin aritmética (#1426). */}
          <p className="fireLevelsCoastNote">
            <strong>Lean</strong> y <strong>Fat</strong> son tu mismo gasto al{" "}
            {formatRatePercent(config.leanMultiplier ?? 0.7)} y al{" "}
            {formatRatePercent(config.fatMultiplier ?? 1.5)}; cada nivel es ese gasto
            anual dividido por tu tasa de retirada.
            {fireLevelRail.some((level) => level.key === "coast") ? (
              <>
                {" "}
                <strong>Coast FIRE</strong>: si alcanzas esa cifra hoy y dejas de aportar,
                el interés compuesto te llevará a tu número FIRE para la jubilación.
              </>
            ) : null}
          </p>
        </section>
      ) : null}

      {/* ── El alquiler declarado en la rentabilidad (#1448) ────── */}
      {rentReturnLines.length > 0 ? (
        <section aria-label="Alquiler declarado en la rentabilidad" className="fireRent">
          <h4 className="fireRentTitle">Alquiler declarado en la rentabilidad</h4>
          <p className="fireRentIntro">
            De un inmueble alquilado la app no adivina el rendimiento: usa su{" "}
            <strong>alquiler neto</strong> sobre su valor. Sin gastos declarados no se usa
            el bruto —{" "}
            <span className="fireRentIntroWhy">
              sobreestimaría tanto como el retorno por defecto se queda corto
            </span>
            .
          </p>
          <ul className="fireRentList">
            {rentReturnLines.map((line) => (
              <li
                className={`fireRentRow is-${line.kind}`}
                key={`${line.kind}-${line.key}`}
              >
                <span className="fireRentRowTitle">{line.title}</span>
                <span className="fireRentRowGloss">{line.gloss}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="objetivosFireFoot">
        <span>
          Los supuestos de tu FIRE (gasto, retirada, retorno, edades) → en Ajustes
        </span>
        <Link className="panelAction" href="/ajustes">
          Configurar supuestos
        </Link>
      </div>
    </section>
  );
}
