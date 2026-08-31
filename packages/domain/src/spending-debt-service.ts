/**
 * El gasto declarado contra el servicio de deuda que la app ya conoce (#1520,
 * ADR 0099) — el testigo que le faltaba a la única cifra con la que se mide «¿de
 * cuánto puedo vivir?».
 *
 * Dos superficies contestan esa pregunta en €/mes: la cobertura del gasto (los cobros
 * netos contra el gasto declarado) y el gasto sostenible (rentas netas + vendible ×
 * tasa). Ninguna restaba la cuota, y ninguna decía si el gasto declarado la incluía —
 * así que el mismo 114,9 % de cobertura significa «ya vives de tus activos» o «te
 * falta un tercio» según algo que nadie había preguntado nunca.
 *
 * Este módulo hace dos cosas y **no mueve ninguna cifra**:
 *
 * 1. **Nombra el supuesto.** `monthlySpendingIncludesDebtService` es una declaración
 *    de tres estados (ADR 0074): sin declarar es un estado de primera clase, y en él
 *    el motor se comporta como siempre **y lo dice**.
 * 2. **Mide la cuota y la cruza** (la forma de ADR 0075 con el ahorro medido): la suma
 *    de cuotas vigentes es un dato medido que contradice o completa la declaración, y
 *    emite señal de calidad de dato. No entra en ninguna aritmética.
 *
 * Restar la cuota del gasto sostenible se decidió DEJAR FUERA: sin fecha de
 * vencimiento sería una cifra pesimista para siempre, y con ella haría falta el motor
 * de flujos que ADR 0081 no construyó a propósito. El tratamiento de **stock** se queda
 * quieto: el saldo vivo se sigue neteando contra el capital en su tramo, y restar
 * además la cuota del capital sería doble conteo.
 */

import type { FireScopeConfig } from "./fire";
import { type CurrencyCode, formatMoneyMinorExact, maskMoneyString } from "./money";
import { allocateScopedHolding } from "./scope-allocation";
import type { Liability } from "./workspace-types";

/**
 * Qué dice el usuario de su propio gasto mensual. `undeclared` NO es un `false`
 * disfrazado: es el estado en el que la app no sabe qué significa el porcentaje que
 * está imprimiendo, y decirlo en voz alta es la mitad de este ticket.
 */
export type SpendingDebtServiceDeclaration = "included" | "excluded" | "undeclared";

/**
 * La única puerta por la que se lee la declaración, como
 * `fireCountsImmobilizedCapital` con el inmovilizado: el campo es opcional y
 * `undefined` significa «sin declarar», nunca «no incluye». Leerlo a pelo con un
 * `=== true` convertiría el silencio en una respuesta.
 */
export function spendingDebtServiceDeclaration(
  config: FireScopeConfig,
): SpendingDebtServiceDeclaration {
  const declared = config.monthlySpendingIncludesDebtService;
  return declared === undefined ? "undeclared" : declared ? "included" : "excluded";
}

/** Lo que las cuotas vigentes del ámbito suman al mes, y de cuántas deudas sale. */
export interface ScopeDebtService {
  /** Suma de cuotas vigentes escalada a la participación del ámbito. */
  monthlyMinor: number;
  /** Cuántas deudas del ámbito aportan cuota (0 = no hay servicio de deuda). */
  liabilityCount: number;
  /**
   * Deudas con cuota conocida que se han dejado fuera por estar en otra divisa.
   * Sumar dólares como euros es el fallo de #1401; aquí el silencio se declara para
   * que la glosa pueda decir que la medida está incompleta.
   */
  skippedForeignCount: number;
}

export interface ScopeMonthlyDebtServiceInput {
  /** Las deudas vivas del espacio (con su participación y su divisa). */
  liabilities: readonly Liability[];
  /**
   * La cuota vigente de cada deuda al 100 %, en unidades menores — derivada por
   * `debtServiceAtDate`. Una deuda ausente del mapa no tiene cuota que worthline
   * conozca (revolving, informal, o un plan ya vencido) y no entra.
   */
  debtServiceByLiabilityId: ReadonlyMap<string, number>;
  /** Los miembros que constituyen el ámbito (`resolveScopeMemberIds`). */
  scopeMemberIds: ReadonlySet<string>;
  /** La divisa base: una cuota en otra divisa no es medida, es un hueco. */
  currency: CurrencyCode;
}

/**
 * La cuota del ámbito: la suma de las vigentes, **escalada por participación** con la
 * misma regla con la que el pool FIRE netea el saldo de esas mismas deudas
 * (`allocateScopedHolding`). Media hipoteca es media cuota; contarla entera en el
 * ámbito de un solo miembro diría que paga lo que paga la pareja.
 */
export function scopeMonthlyDebtService(
  input: ScopeMonthlyDebtServiceInput,
): ScopeDebtService {
  const scopeMemberIds = new Set(input.scopeMemberIds);
  let monthlyMinor = 0;
  let liabilityCount = 0;
  let skippedForeignCount = 0;

  for (const liability of input.liabilities) {
    const paymentMinor = input.debtServiceByLiabilityId.get(liability.id);
    if (paymentMinor === undefined || paymentMinor <= 0) continue;

    const { ownedMinor } = allocateScopedHolding(paymentMinor, {
      ownership: liability.ownership,
      scopeMemberIds,
    });
    if (ownedMinor <= 0) continue;

    if (liability.currency !== input.currency) {
      skippedForeignCount += 1;
      continue;
    }

    monthlyMinor += ownedMinor;
    liabilityCount += 1;
  }

  return { liabilityCount, monthlyMinor, skippedForeignCount };
}

/**
 * A partir de qué peso la respuesta cambia la lectura de las dos tarjetas. Se lee
 * «sospechosamente cercano» como «material»: la misma cuarta parte con la que ADR 0075
 * decide que una divergencia de ahorro es noticia.
 *
 * El caso real que abrió el ticket está justo aquí: 883,66 € de cuotas contra 2.000 €
 * de gasto declarado es el 44 %, así que si ese gasto no incluía la hipoteca la
 * cobertura pasa del 114,9 % al 63 %. Por debajo del umbral la pregunta no vale la
 * interrupción: un préstamo de 40 €/mes sobre 2.000 € de gasto mueve la lectura dos
 * puntos, y worthline no está para dar la lata con eso.
 */
export const SPENDING_DEBT_SERVICE_MATERIAL_RATIO = 0.25;

export type SpendingDebtServiceState =
  /** El ámbito no tiene ninguna cuota vigente: no hay supuesto que nombrar. */
  | "no_debt_service"
  /**
   * Hay servicio de deuda, pero la medida no vale para hablar de él: alguna cuota
   * está en otra divisa (parte del dinero falta de la suma, #1401/ADR 0072) o no hay
   * gasto declarado positivo contra el que cruzarla. La misma regla que ADR 0075 dio
   * a la ventana con divisas mezcladas: sin medida no hay glosa **ni aviso**, porque
   * una suma incompleta puede caer bajo el umbral y callar por la razón equivocada.
   */
  | "no_measurement"
  /** Declaración y cuota conviven sin contradicción, o la cuota es inmaterial. */
  | "aligned"
  /**
   * Declara que el gasto incluye el servicio de deuda, y la cuota no cabe dentro de
   * ese gasto. Las dos no pueden ser verdad.
   */
  | "impossible"
  /** Hay una cuota que cambia la lectura y nadie ha dicho si el gasto la incluye. */
  | "undeclared";

export interface SpendingDebtServiceCoherence {
  state: SpendingDebtServiceState;
  declaration: SpendingDebtServiceDeclaration;
  /** El gasto mensual declarado del ámbito (`monthlySpendingMinor`). */
  declaredSpendingMinor: number;
  /** Lo que las cuotas vigentes suman al mes en este ámbito. */
  debtServiceMonthlyMinor: number;
  /** `cuota / gasto declarado`, o `null` sin gasto declarado positivo. */
  ratio: number | null;
  /** La medida completa, para que un consumidor pueda decir qué se quedó fuera. */
  debtService: ScopeDebtService;
}

export function assessSpendingDebtService(input: {
  config: FireScopeConfig;
  debtService: ScopeDebtService;
}): SpendingDebtServiceCoherence {
  return assess({
    debtService: input.debtService,
    declaration: spendingDebtServiceDeclaration(input.config),
    declaredSpendingMinor: input.config.monthlySpendingMinor,
  });
}

/**
 * El mismo careo con otra declaración, sobre la MISMA medida (#1520). Lo pide la isla
 * de supuestos: el `select` está en la cara visible, así que tocarlo tiene que mover su
 * glosa en el momento (ADR 0078, enmienda #1473) — y la única forma de que la
 * previsualización y el guardado no discrepen es que las dos salgan de aquí.
 *
 * El gasto declarado que usa es el GUARDADO, no el tecleado: ninguna de las dos glosas
 * lo cita, y lo único que decide es el umbral de materialidad, que no se pinta.
 */
export function previewSpendingDebtService(
  coherence: SpendingDebtServiceCoherence,
  declaredIncludesDebtService: boolean | undefined,
): SpendingDebtServiceCoherence {
  return assess({
    debtService: coherence.debtService,
    declaration:
      declaredIncludesDebtService === undefined
        ? "undeclared"
        : declaredIncludesDebtService
          ? "included"
          : "excluded",
    declaredSpendingMinor: coherence.declaredSpendingMinor,
  });
}

function assess(input: {
  declaration: SpendingDebtServiceDeclaration;
  declaredSpendingMinor: number;
  debtService: ScopeDebtService;
}): SpendingDebtServiceCoherence {
  const { debtService, declaration, declaredSpendingMinor } = input;
  const debtServiceMonthlyMinor = debtService.monthlyMinor;
  const ratio =
    declaredSpendingMinor > 0 ? debtServiceMonthlyMinor / declaredSpendingMinor : null;

  const base = {
    debtService,
    debtServiceMonthlyMinor,
    declaration,
    declaredSpendingMinor,
    ratio,
  };

  // Sin cuota conocida NI descartada no hay supuesto que nombrar. Con alguna cuota
  // descartada por divisa la hay, pero la suma está incompleta; y sin gasto declarado
  // positivo no hay con qué cruzarla (el formulario lo exige, un import no).
  if (debtService.skippedForeignCount > 0 || declaredSpendingMinor <= 0) {
    return { ...base, state: "no_measurement" };
  }

  if (debtServiceMonthlyMinor <= 0) {
    return { ...base, state: "no_debt_service" };
  }

  // La señal fuerte: lo declarado y lo medido no pueden ser las dos verdad. Se mide
  // en estricto, porque un gasto declarado IGUAL a la cuota es coherente (alguien
  // que solo tiene la hipoteca) aunque sea raro — y este módulo no está para juzgar
  // vidas ajenas, solo aritmética.
  if (declaration === "included" && debtServiceMonthlyMinor > declaredSpendingMinor) {
    return { ...base, state: "impossible" };
  }

  if (
    declaration === "undeclared" &&
    ratio !== null &&
    ratio >= SPENDING_DEBT_SERVICE_MATERIAL_RATIO
  ) {
    return { ...base, state: "undeclared" };
  }

  return { ...base, state: "aligned" };
}

export interface ScopeSpendingDebtServiceInput extends ScopeMonthlyDebtServiceInput {
  /** La config FIRE del ámbito; la declaración se lee por su única puerta. */
  config: FireScopeConfig;
}

/**
 * La lectura de ámbito: medir las cuotas del ámbito y cruzarlas contra su gasto
 * declarado, de una vez (#1520). **La única puerta** — la usan la señal de salud (#654)
 * y la pantalla que pinta las dos glosas, así que no pueden acabar midiendo deudas
 * distintas ni aplicando umbrales distintos al mismo ámbito. Es la misma forma que
 * `scopeSavingsCoherence` le dio al testigo del ahorro.
 */
export function scopeSpendingDebtService(
  input: ScopeSpendingDebtServiceInput,
): SpendingDebtServiceCoherence {
  return assessSpendingDebtService({
    config: input.config,
    debtService: scopeMonthlyDebtService(input),
  });
}

/**
 * La frase que enuncia el desajuste (#1520) — la comparte el inventario de salud
 * (#654) con cualquier superficie que quiera repetirla, así que las palabras no pueden
 * divergir entre donde se levanta la duda y donde se pintan las cifras que pone en
 * duda (misma regla que `describeSavingsDivergence`).
 *
 * `null` en los estados sin noticia, como sus dos hermanas de abajo: no hay frase que
 * decir, y una cadena vacía se pinta como un párrafo en blanco.
 */
export function describeSpendingDebtServiceGap(
  coherence: SpendingDebtServiceCoherence,
  currency: CurrencyCode,
  privacyMode = false,
): string | null {
  const spending = amountOf(coherence.declaredSpendingMinor, currency, privacyMode);
  const cuota = amountOf(coherence.debtServiceMonthlyMinor, currency, privacyMode);

  switch (coherence.state) {
    case "impossible":
      return (
        `Declaras que tu gasto mensual (${spending}) incluye el servicio de deuda, pero ` +
        `tus cuotas vigentes suman ${cuota} al mes: no caben dentro. Revisa el gasto ` +
        `declarado o la declaración — las dos cifras deciden de cuánto puedes vivir.`
      );
    case "undeclared":
      return (
        `Tus cuotas de deuda vigentes suman ${cuota} al mes y tu gasto declarado es ` +
        `${spending}, así que la respuesta cambia la lectura: declara si ese gasto ya ` +
        `incluye las cuotas. Sin ella, la cobertura de tu gasto y tu gasto sostenible ` +
        `admiten dos lecturas distintas.`
      );
    default:
      return null;
  }
}

/**
 * Con céntimos, no con la voz de lectura de euros redondos: la cuota es una cifra que
 * el usuario va a cotejar con su banco, y «884 €» no se reconoce como los 883,66 € de
 * su recibo (la misma razón por la que el careo de traspasos usa este formato).
 */
function amountOf(
  amountMinor: number,
  currency: CurrencyCode,
  privacyMode: boolean,
): string {
  const formatted = formatMoneyMinorExact({ amountMinor, currency });
  return privacyMode ? maskMoneyString(formatted) : formatted;
}

/** La mitad compartida de las dos glosas: qué dice la declaración de la cuota medida. */
function declarationClause(
  coherence: SpendingDebtServiceCoherence,
  cuota: string,
): string {
  switch (coherence.declaration) {
    case "included":
      return `tu gasto declarado ya incluye tus cuotas de deuda (${cuota} al mes)`;
    case "excluded":
      return `tu gasto declarado NO incluye tus cuotas de deuda (${cuota} al mes)`;
    case "undeclared":
      return `no has declarado si tu gasto incluye tus cuotas de deuda (${cuota} al mes)`;
  }
}

/**
 * La glosa de la tarjeta de renta pasiva: contra qué gasto se está midiendo la
 * cobertura. `null` sin cuotas vigentes — nombrar un supuesto sobre una deuda que no
 * existe es ruido, no honestidad.
 */
export function spendingDebtServiceCoverageNote(
  coherence: SpendingDebtServiceCoherence,
  currency: CurrencyCode,
  privacyMode = false,
): string | null {
  if (coherence.state === "no_debt_service" || coherence.state === "no_measurement") {
    return null;
  }

  const cuota = amountOf(coherence.debtServiceMonthlyMinor, currency, privacyMode);
  const clause = declarationClause(coherence, cuota);

  switch (coherence.declaration) {
    case "included":
      return `La cobertura compara tus cobros con tu gasto declarado, y ${clause}.`;
    case "excluded":
      return `La cobertura compara tus cobros con tu gasto declarado, y ${clause}: súmalas antes de leer este porcentaje como «vivo de mis activos».`;
    case "undeclared":
      return `La cobertura compara tus cobros con tu gasto declarado, y ${clause}. Decláralo en tus supuestos: cambia lo que significa este porcentaje.`;
  }
}

/**
 * La glosa de la tarjeta de gasto sostenible: la cuota sale de esta cifra y no se ha
 * restado (la opción de restarla se dejó fuera a propósito, ADR 0099). `null` sin
 * cuotas vigentes.
 */
export function spendingDebtServiceSustainableNote(
  coherence: SpendingDebtServiceCoherence,
  currency: CurrencyCode,
  privacyMode = false,
): string | null {
  if (coherence.state === "no_debt_service" || coherence.state === "no_measurement") {
    return null;
  }

  const cuota = amountOf(coherence.debtServiceMonthlyMinor, currency, privacyMode);
  const head = `De esta cifra salen tus cuotas de deuda vigentes (${cuota} al mes): no se han restado.`;

  switch (coherence.declaration) {
    case "included":
      return `${head} Tu gasto declarado ya las incluye, así que las dos cifras se comparan directamente.`;
    case "excluded":
      return `${head} Tu gasto declarado no las incluye, así que súmaselas antes de comparar.`;
    case "undeclared":
      return `${head} No has declarado si tu gasto mensual las incluye; dilo en tus supuestos y sabrás con qué comparar esta cifra.`;
  }
}
