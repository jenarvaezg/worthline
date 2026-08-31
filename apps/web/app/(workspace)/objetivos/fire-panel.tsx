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
 * Coast has one home, beside its tick on the bar (#1425): the requirement, the
 * progress toward it, the age its contributions reach it at, and — with its premise
 * spelled out in the label — the age the capital alone would reach the full FIRE
 * number at. It is no longer a card on the «Niveles FIRE» rail, which answers a
 * different question («¿qué nivel de vida quiero financiar?») and used to need a
 * paragraph underneath admitting it.
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
  FireCoastArrival,
  FireLevel,
  FireProjection,
  FireRetirementProfile,
  FireScopeConfig,
  FireSustainableSpending,
  SavingsCoherence,
  ScopeFireResult,
  SpendingDebtServiceCoherence,
} from "@worthline/domain";
import {
  describeSavingsDivergence,
  formatMoneyMinorPrivacy,
  isManualFireReturn,
  monthlySavingsCapacityForFire,
  spendingDebtServiceSustainableNote,
} from "@worthline/domain";
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
import {
  coastAbsenceNote,
  coastArrivalMetric,
  coastFormulaLine,
  coastProgressPercent,
  contributionsStopMetric,
  etaYearsLabel,
  fireFundedView,
} from "./fire-funding-view";
import {
  formatFirePercent,
  formatMultiplierPercent,
  formatRatePercent,
} from "./fire-percent";
import { fireRentReturnLines } from "./fire-rent-return-view";
import { FireRetirementPlanForm } from "./fire-retirement-plan-form";
import {
  fireOrdinaryPlanNote,
  firePanelHeading,
  fireRetirementOfferLine,
  fireSustainableSpendingCopy,
} from "./fire-sustainable-spending-view";

export interface FirePanelProps {
  achievement: FireAchievement | null;
  /** Where the reference age came from (#1415), for the assumptions fold. */
  ageSource: FireAgeSource | null;
  /**
   * Cuándo se llega a Coast aportando lo declarado (#1425). Lo calcula el servidor —
   * y la isla lo recalcula al teclear — porque sale de una trayectoria, no de una
   * división: el panel solo lo pone en palabras.
   */
  coastArrival: FireCoastArrival | null;
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
  /**
   * ¿El plan de este ámbito es FIRE o una jubilación ordinaria? (#1428.) Decide qué
   * pregunta lidera el panel — y nada más: todas las cifras se siguen calculando.
   */
  retirementProfile: FireRetirementProfile | null;
  savingsCoherence: SavingsCoherence | null;
  /**
   * El gasto declarado contra las cuotas vigentes (#1520), ya recalculado con la
   * declaración que el borrador dice. La tarjeta de gasto sostenible nombra con esto el
   * supuesto bajo el que habla; no mueve ninguna cifra.
   */
  debtServiceCoherence: SpendingDebtServiceCoherence | null;
  /** El ámbito y la URL que los botones del ofrecimiento necesitan para escribir. */
  scopeId: string | null;
  currentUrl: string;
  /**
   * Public `wl_hld_…` ids keyed by internal asset id, so a withheld rent can
   * link to its ficha without putting `asset_…` in a URL (#1510, #1318).
   */
  publicIdByAssetId: Readonly<Record<string, string>>;
  /** «¿Cuánto puedo gastar sin mermar mi patrimonio?» (#1428). */
  sustainableSpending: FireSustainableSpending | null;
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
  // El mismo «cuándo» que la fila de llegada a Coast (#1425): dos formateos separados
  // eran dos umbrales para «este año» a tres líneas de distancia.
  const etaLabel =
    level.eta.kind === "reached"
      ? "alcanzado"
      : level.eta.kind === "unreachable"
        ? "—"
        : etaYearsLabel(level.eta.years);
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
          engine that built the level — Barista's is the gap its income leaves. Every
          level on this rail has one since Coast stopped riding it (#1425). */}
      <span className="fireLevelFunds">
        financia{" "}
        {formatMoneyMinorPrivacy(
          { amountMinor: level.fundsAnnualMinor, currency },
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
  coastArrival,
  coastTickFraction,
  currency,
  currentUrl,
  debtServiceCoherence,
  fireLevelRail,
  fireProjection,
  fireResult,
  previewing,
  privacyMode,
  publicIdByAssetId,
  retirementProfile,
  savingsCoherence,
  scopeId,
  sustainableSpending,
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
      ? fireRentReturnLines({
          formatMoney: fmt,
          publicIdByAssetId,
          report: fireResult.rentReturns,
        })
      : [];

  const funded = fireResult
    ? fireFundedView({ formatMoney: fmt, result: fireResult })
    : null;

  // La capa de #1428: el mismo panel con otra pregunta al frente. Se llega aquí solo
  // porque el usuario lo declaró — la señal como mucho ofrece.
  const declaredOrdinary = retirementProfile?.state === "ordinary";
  // El ofrecimiento calla mientras hay supuestos sin guardar: sus botones ESCRIBEN, y
  // pulsarlos a media edición se llevaría el borrador por delante.
  const offerLine =
    retirementProfile && !previewing ? fireRetirementOfferLine(retirementProfile) : null;
  const sustainableCopy =
    declaredOrdinary && sustainableSpending && fireResult
      ? fireSustainableSpendingCopy({
          formatMoney: fmt,
          immobilizedMinor: fireResult.capitalSplit.immobilized.amountMinor,
          // Los MISMOS avisos que la sección de alquileres de abajo (#1448): un
          // alquiler que no suma en el gasto sostenible lo dice con su razón, y las
          // razones son tres, no solo la de los gastos sin declarar.
          rentNotices: fireResult.rentReturns.notices,
          spending: sustainableSpending,
        })
      : null;
  // El titular solo se troca si hay una respuesta con la que trocarlo: sin tasa de
  // retirada no hay gasto sostenible, y un encabezado que promete «cuánto puedes
  // gastar» sobre una tarjeta ausente es peor que no cambiar nada.
  // El supuesto bajo el que habla el gasto sostenible (#1520). NO calla al previsualizar,
  // al contrario que el ofrecimiento de arriba: aquel ESCRIBE al pulsarlo y por eso se
  // esconde a media edición, mientras que esto es una glosa de la cifra de al lado, y el
  // careo que recibe ya viene recalculado con lo tecleado. Esconderla mientras se edita
  // era el «lo toco y desaparece» que #1473 vino a matar.
  const debtServiceNote = debtServiceCoherence
    ? spendingDebtServiceSustainableNote(debtServiceCoherence, currency, privacyMode)
    : null;
  const heading = firePanelHeading({ ordinary: sustainableCopy !== null, previewing });
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
  // Las dos edades del bloque de Coast, cada una con su premisa en la etiqueta (#1425):
  // la de llegada (aportando lo declarado) y la de aportación cero, que es la que se
  // llamaba «Edad Coast» y respondía otra pregunta. Se leen de módulos puros: el panel
  // no vuelve a decidir cuándo una edad es un sello.
  const coastAgeMetrics = [
    coastArrivalMetric(coastArrival, config ? monthlySavingsCapacityForFire(config) : 0),
    fireResult ? contributionsStopMetric({ formatMoney: fmt, result: fireResult }) : null,
  ].filter((metric) => metric !== null);
  // Y si no hay Coast, por qué (#1425): sin margen de composición hasta la edad objetivo
  // el motor no emite el requisito, y una cifra que se va sin decir nada se lee como un
  // fallo de la app.
  const coastAbsence =
    fireResult && config
      ? coastAbsenceNote({
          config,
          realReturnUsed: fireResult.context.realReturnUsed,
          result: fireResult,
        })
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
        <h3>{heading.title}</h3>
        <span>{heading.eyebrow}</span>
      </div>

      {/* Detectar y OFRECER, nunca imponer (#1428). Se nombra el hecho que disparó la
          sospecha —«tu edad objetivo son 67 años»— y no la conclusión sobre su vida;
          decirle a alguien «no vas a hacer FIRE» sienta fatal en cuanto la detección
          se equivoca, y aquí se equivoca con solo tocar la edad objetivo. La respuesta
          se guarda en las DOS direcciones: un «no» que no se persistiera volvería a
          preguntarse en cada carga. */}
      {offerLine !== null && scopeId !== null ? (
        <div className="fireRetirementOffer">
          {/* El aviso es el párrafo, no el envoltorio: `role="status"` sobre algo que
              contiene los botones los metería dentro de una región viva. */}
          <p role="status">
            {offerLine} ¿Quieres ver esta pantalla como plan de jubilación —cuánto puedes
            gastar— en vez de FIRE?
          </p>
          <div className="fireRetirementOfferActions">
            <FireRetirementPlanForm
              currentUrl={currentUrl}
              label="Verlo así"
              plan="ordinary"
              scopeId={scopeId}
            />
            <FireRetirementPlanForm
              buttonClassName="btnSmall fireRetirementOfferDismiss"
              currentUrl={currentUrl}
              label="No, sigo con FIRE"
              plan="early"
              scopeId={scopeId}
            />
          </div>
        </div>
      ) : null}

      {fireResult && config && funded ? (
        <div className="objetivosHeroGrid">
          {/* Left: % funded + bar + coast + metrics */}
          <div className="objetivosHeroLeft">
            {/* El titular del perfil de jubilación ordinaria (#1428): la inversa de
                la fórmula FIRE, con los mismos insumos. Va ARRIBA porque es la
                respuesta a la pregunta que este usuario tiene de verdad; el % de
                abajo sigue ahí, calculado y cierto, solo deja de ser el titular. */}
            {sustainableCopy ? (
              <section aria-label="Gasto sostenible" className="fireSustainable">
                <p className="fireBig">
                  {sustainableCopy.headline}{" "}
                  <span className="fireBigNoun">sin mermar tu patrimonio</span>
                </p>
                <p className="fireFundedFraction">{sustainableCopy.headlineAnnual}</p>

                <ul className="fireSustainableRows">
                  {sustainableCopy.rows.map((row) => (
                    <li className={`fireSustainableRow is-${row.key}`} key={row.key}>
                      <span className="fireSustainableLabel">{row.label}</span>
                      <span className="fireSustainableGloss">{row.gloss}</span>
                      <strong>{row.value}</strong>
                    </li>
                  ))}
                </ul>

                {/* La segunda versión, cuando el usuario ha dicho hasta cuándo: este
                    perfil no necesita preservar el principal a perpetuidad, así que
                    «agotándolo a los N» es la pregunta honesta — y la única que
                    necesita una edad final, que es un dato suyo. */}
                {sustainableCopy.depletion ? (
                  <div className="fireMetric fireSustainableDepletion">
                    <span>Agotando el capital</span>
                    <strong>{sustainableCopy.depletion.value}</strong>
                  </div>
                ) : null}
                {sustainableCopy.depletion ? (
                  <p className="fireCoastGloss">{sustainableCopy.depletion.gloss}</p>
                ) : null}
                {/* Y si no hay segunda cifra, qué falta exactamente: la edad final se
                    pide en los supuestos, la fecha de nacimiento en Ajustes, y una edad
                    final ya alcanzada no se pide en ninguna parte. */}
                {sustainableCopy.depletionAbsence !== null ? (
                  <p className="fireCoastGloss">
                    {sustainableCopy.depletionAbsence}{" "}
                    <a href="#supuestos">Tus supuestos</a>
                  </p>
                ) : null}

                {/* Lo que la fecha de disponibilidad declarada le hizo al reparto, o el
                    hueco de no haberla declarado (#1528). Va pegada a la cifra de
                    agotamiento porque es la única que cambia: si la segunda cifra baja
                    y nadie dice por qué, se lee como un fallo de la app. */}
                {sustainableCopy.availabilityNote ? (
                  <p className="fireCoastGloss">{sustainableCopy.availabilityNote}</p>
                ) : null}

                {/* El supuesto del servicio de deuda (#1520): la cuota sale de esta
                    cifra y no se ha restado. Antes de la nota de exclusiones porque
                    habla de la cifra grande, no de lo que se quedó fuera de ella.

                    La frase la escribe el dominio, como la del ahorro medido de más
                    abajo: la tarjeta de renta pasiva dice lo mismo sobre el mismo
                    hecho, y dos redacciones acabarían discrepando. */}
                {debtServiceNote ? (
                  <p className="objetivosSubNote">{debtServiceNote}</p>
                ) : null}

                {sustainableCopy.exclusionNote ? (
                  <p className="objetivosSubNote">{sustainableCopy.exclusionNote}</p>
                ) : null}
              </section>
            ) : null}

            {/* The noun matters: a lone «68,5 %» reads as a probability of
                arriving, not as the share of the target already funded (#1426). */}
            <p className={sustainableCopy !== null ? "fireFundedDemoted" : "fireBig"}>
              {funded.percent} <span className="fireBigNoun">financiado</span>
            </p>
            <p className="fireFundedFraction">{funded.fraction}</p>

            {/* La vuelta atrás vive junto a la cifra que se degradó, no escondida en
                un formulario: quien dijo «así» tiene que poder desdecirse donde lo ve
                (y el desplegable de supuestos lo ofrece igual). */}
            {declaredOrdinary && scopeId !== null && !previewing ? (
              <div className="fireRetirementRevert">
                <span>{fireOrdinaryPlanNote(funded.percent)}</span>
                <FireRetirementPlanForm
                  currentUrl={currentUrl}
                  label="Ver como FIRE"
                  plan="early"
                  scopeId={scopeId}
                />
              </div>
            ) : null}

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
            </div>

            {/* ── Coast, en la columna de la barra que lo dibuja (#1425) ─────
                El tick marca un punto del camino, así que su cifra, su progreso y
                sus dos fechas viven aquí y no en el rail de niveles: allí Coast era
                una tarjeta más que necesitaba un párrafo debajo avisando de que no
                significaba lo mismo que las otras. Va DESPUÉS del número FIRE y del
                capital elegible porque su fórmula los cita: la cadena de #1426 se lee
                en orden. Las cuatro filas responden a cuatro preguntas distintas y
                cada etiqueta dice a cuál. */}
            {fireResult.coastFireRequired ? (
              <section aria-label="Coast FIRE" className="fireCoast">
                <p className="objetivosCoastNote">
                  {coastTickFraction !== null ? (
                    <>
                      El tick <span aria-hidden="true">▏</span> marca{" "}
                    </>
                  ) : null}
                  <strong>Coast FIRE</strong>: si alcanzas esa cifra y dejas de aportar,
                  el interés compuesto hace el resto — el capital crece solo hasta tu
                  número FIRE para la jubilación.
                </p>

                <div className="fireMetric">
                  <span>Coast requerido</span>
                  <strong>
                    {formatMoneyMinorPrivacy(fireResult.coastFireRequired, privacyMode)}
                  </strong>
                </div>
                {/* El eslabón que le faltaba a la cadena: Coast también es una división,
                    y hasta #1426 era la única cifra derivada sin su aritmética. */}
                {coastFormula !== null ? (
                  <p className="fireFormula">{coastFormula}</p>
                ) : null}

                {/* «Cuánto me falta para poder dejar de aportar» — el progreso del
                    lector hacia Coast, no la posición del tick (#1426). */}
                {coastProgress !== null ? (
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

                {coastAgeMetrics.map((metric) => (
                  <div key={metric.label}>
                    <div className="fireMetric">
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                    </div>
                    {/* La premisa, pegada a la cifra: sin ella las dos edades se leen
                        como la misma familia y una contradice a la otra. */}
                    <p className="fireCoastGloss">{metric.gloss}</p>
                  </div>
                ))}
              </section>
            ) : coastAbsence !== null ? (
              <p className="objetivosCoastNote">{coastAbsence}</p>
            ) : null}

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
              es quien los aplicó — nadie guarda aquí una segunda copia del defecto.
              Ya no hay nada que desmentir debajo: este rail es un solo eje desde que
              Coast dejó de viajar en él (#1425). */}
          <p className="fireLevelsNote">
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
                {line.href ? (
                  <Link className="fireRentRowTitle" href={line.href}>
                    {line.title}
                  </Link>
                ) : (
                  <span className="fireRentRowTitle">{line.title}</span>
                )}
                <span className="fireRentRowGloss">{line.gloss}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
