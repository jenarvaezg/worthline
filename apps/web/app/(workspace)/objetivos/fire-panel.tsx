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
 * Server-rendered (interaction-patterns §1): the only interaction here is native
 * `<details>` and the in-page anchors to «Tus supuestos» (#1450), so there is no
 * island and no client rate math.
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
import {
  describeSavingsDivergence,
  formatMoneyMinorPrivacy,
  isManualFireReturn,
} from "@worthline/domain";
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
import {
  coastFormulaLine,
  coastProgressPercent,
  fireFundedView,
} from "./fire-funding-view";
import {
  formatFirePercent,
  formatMultiplierPercent,
  formatRatePercent,
} from "./fire-percent";
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
  /**
   * Las cifras vienen de unos supuestos tecleados y todavía sin guardar (#1450).
   * Cambia el registro del panel: lo que juzga lo declarado calla, porque aún no
   * hay nada declarado que juzgar.
   */
  previewing: boolean;
  privacyMode: boolean;
  savingsCoherence: SavingsCoherence | null;
}

function FireLevelCard({
  level,
  currency,
  privacyMode,
}: {
  level: FireLevel;
  currency: string;
  privacyMode: boolean;
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
  return (
    <div className={`fireLevelCard${reached ? " fireLevelCard--reached" : ""}`}>
      <span className="fireLevelLabel">{level.label}</span>
      <strong className="fireLevelAmount">
        {formatMoneyMinorPrivacy(
          { amountMinor: level.amountMinor, currency },
          privacyMode,
        )}
      </strong>
      {/* What the level buys, which is what makes it legible: a capital figure alone
          says nothing about the life it pays for (#1426). The figure comes from the
          engine that built the level — Coast has none, and says nothing. */}
      {level.fundsAnnualMinor === undefined ? null : (
        <span className="fireLevelFunds">
          financia{" "}
          {formatMoneyMinorPrivacy(
            { amountMinor: level.fundsAnnualMinor, currency },
            privacyMode,
          )}
          /año
        </span>
      )}
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
  previewing,
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
  // One predicate, asked once: three things hang off «is the rate in use the weighted
  // one?» — the rent-substitution disclosure, the weighting table, and what the
  // assumptions row says about provenance.
  const rateIsWeighted = config !== null && !isManualFireReturn(config);
  const rentReturnLines =
    fireResult && rateIsWeighted
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
  const coastFormula =
    fireResult && config
      ? coastFormulaLine({ config, formatMoney: fmt, result: fireResult })
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
    fireResult && rateIsWeighted ? fireReturnMixPrintRows(fireResult.returnMix) : [];
  const mixTotal = fireResult ? fireReturnMixTotal(fireResult.returnMix) : null;
  // The levels that ARE a multiple of the declared spending, in the rail's own order:
  // «Regular» at 100 % explains nothing, so it stays out of the note.
  const spendingMultiples = (fireLevelRail ?? []).filter(
    (level) => level.spendingMultiplier !== undefined && level.spendingMultiplier !== 1,
  );

  return (
    <section
      aria-label="FIRE"
      className={`firePanel objetivosFirePanel${previewing ? " objetivosFirePanel--previewing" : ""}`}
    >
      <div className="panelHeader">
        <h3>Independencia financiera · FIRE</h3>
        <span>
          {previewing ? "previsualización · sin guardar" : "objetivo principal"}
        </span>
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

            {achievement && !previewing ? (
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
            {savingsCoherence?.state === "diverged" && !previewing ? (
              <p className="objetivosSavingsGap" role="status">
                {describeSavingsDivergence(savingsCoherence, currency, privacyMode)}{" "}
                <a href="#supuestos">Ajusta tu ahorro en tus supuestos</a>
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
                  editan — que desde #1450 es esta misma pantalla: una cifra derivada
                  que no se puede rastrear ni cambiar se lee como constante física. */}
              <p className="fireFormula">
                <a href="#supuestos">
                  {fmt(config.monthlySpendingMinor * 12)}/año de gasto
                </a>{" "}
                ÷{" "}
                <a href="#supuestos">
                  {formatRatePercent(config.safeWithdrawalRate)} de retirada
                </a>{" "}
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
                    <li
                      className={`fireCapitalRow is-${row.key}${
                        row.outOfCalculation ? " is-outOfCalculation" : ""
                      }`}
                      key={row.key}
                    >
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
              {/* El eslabón que le faltaba a la cadena: Coast también es una división,
                  y hasta ahora era la única cifra derivada sin su aritmética. */}
              {coastFormula !== null ? (
                <p className="fireFormula">{coastFormula}</p>
              ) : null}
              {/* «Cuánto me falta para poder dejar de aportar» — el progreso del
                  lector hacia Coast, no la posición del tick (#1426). */}
              {coastProgress !== null && fireResult.coastFireRequired ? (
                <>
                  <div className="fireMetric">
                    <span>Hacia Coast llevas</span>
                    <strong>{formatFirePercent(coastProgress)}</strong>
                  </div>
                  {/* La misma fracción que lleva el % financiado: un porcentaje sin
                      sus dos cifras vuelve a leerse como probabilidad. */}
                  <p className="fireFundedFraction fireFundedFraction--coast">
                    {fmt(fireResult.eligibleAssets.amountMinor)} de{" "}
                    {fmt(fireResult.coastFireRequired.amountMinor)}
                  </p>
                </>
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
                <strong>vivienda habitual</strong> y los que hayas excluido manualmente.
                Cash, inversiones y criptos cuentan.
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
              {/* Lo declarado se dice, no se deduce de una fila gris (#1460): el
                  usuario tiene que poder reconocer su propia decisión y saber que
                  las cifras de arriba ya la obedecen. */}
              {!fireResult.capitalSplit.countsImmobilized ? (
                <p className="fireEligibleRule">
                  Has declarado que tu patrimonio <strong>inmovilizado no cuenta</strong>{" "}
                  como capital FIRE, así que el porcentaje, el Coast y la rentabilidad
                  esperada de arriba se miden <strong>solo con lo vendible</strong>. Se
                  cambia en <a href="#supuestos">tus supuestos</a>.
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
                Añade tu año de nacimiento en Ajustes → Miembros para ver la proyección.
              </p>
            )}

            {/* Los supuestos de la proyección, visibles (#1426): sin ellos las tres
                tarjetas son una caja negra — nada dice por qué 8, 11 y 18 años. */}
            {assumptionRows.length > 0 ? (
              <details suppressHydrationWarning className="fireAssumptions">
                {/* Sin año de nacimiento no hay proyección y no hay años: el pliegue
                    no puede prometer explicar unos que no están en pantalla. */}
                <summary>
                  {fireProjection
                    ? "¿De dónde salen estos años?"
                    : "¿De dónde salen estas cifras?"}
                </summary>
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
                        <td />
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
          {/* El vacío no manda a otra pantalla (#1450): el formulario está al lado,
              así que el CTA lleva al formulario, no a un viaje de ida y vuelta. */}
          <p className="fireEmptyHint">
            FIRE no está configurado para este ámbito. Rellena tus supuestos aquí al lado
            para ver cuándo alcanzas la independencia financiera.
          </p>
          <a className="panelAction" href="#supuestos">
            Rellenar mis supuestos
          </a>
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
              />
            ))}
          </div>
          {/* Los multiplicadores que definen los niveles: sin ellos, «Lean» y
              «Fat» son etiquetas sin aritmética (#1426). Se leen del propio rail, que
              es quien los aplicó — nadie guarda aquí una segunda copia del defecto. */}
          <p className="fireLevelsCoastNote">
            {spendingMultiples.length > 0 ? (
              <>
                {spendingMultiples.map((level, index) => (
                  <span key={level.key}>
                    {index > 0 ? " · " : null}
                    <strong>{level.label}</strong> es tu gasto al{" "}
                    {formatMultiplierPercent(level.spendingMultiplier ?? 1)}
                  </span>
                ))}
                ; cada nivel es ese gasto anual dividido por tu tasa de retirada.
              </>
            ) : null}
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
    </section>
  );
}
