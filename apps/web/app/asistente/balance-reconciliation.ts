/**
 * La ley de reconciliación de una curva de deuda reconstruida (#1422).
 *
 * Antes de este módulo la puerta era `resultingMinor === ctx.currentBalanceMinor`:
 * igualdad **al céntimo** entre una curva calculada a partir de ~49 puntos de un
 * cuadro de amortización y una cifra **tecleada a mano** meses atrás. Para un
 * documento real eso no se cumple casi nunca, y la puerta estaba DOS veces (el
 * `canConfirm` de la tarjeta y la revalidación del servidor), así que editar un
 * punto para «hacerle caso» al mensaje solo movía el fallo un clic más tarde.
 *
 * Tres cambios, todos aquí para que cliente y servidor no puedan divergir:
 *
 * 1. **Tolerancia en vez de `===`.** Un euro de suelo o el 0,1 % del saldo, lo
 *    que sea mayor. Absorbe el redondeo y la deriva ordinaria entre dos cuadros
 *    de amortización; los 494 € de un ancla vieja (≈1 %) siguen sonando.
 * 2. **El ancla deja de ser el juez.** Cuando el documento y el ancla discrepan
 *    hay TRES candidatos a estar mal —el documento, el ancla o el modelo— y
 *    asumir siempre el primero es lo que dejó a Jorge sin salida. Se mide contra
 *    dos testigos: el saldo declarado y la curva que la propia app ya calcula.
 *    Cuadrar con UNO basta; si el ancla no la reproduce ni su propia curva, se
 *    dice con las tres cifras en vez de acusar al banco.
 * 3. **Un descuadre es confirmable**, diciendo lo que va a pasar. La decisión de
 *    quién manda es del usuario, no de un campo que el motor ni siquiera lee
 *    para una deuda amortizable con curva (`storedBalanceGovernsDebtFigure`).
 *
 * Módulo puro y síncrono: sin I/O, sin reloj, sin formato de moneda propio (las
 * frases reciben el formateador). Ver ADR 0070.
 */

import { balancesAgree, balanceToleranceMinor } from "@worthline/domain";

/**
 * La tolerancia y su predicado viven en el dominio desde #1406, donde el import
 * del cuadro de amortización mide la MISMA clase de cosa (una curva reconstruida
 * contra una cifra conocida). Se re-exportan aquí porque este módulo es el que
 * nombra la ley para las superficies del asistente.
 */
export { balancesAgree, balanceToleranceMinor };

export type BalanceReconciliationStatus = "exact" | "within-tolerance" | "mismatch";

/** Contra cuál de los dos testigos se midió el extremo de la serie. */
export type BalanceWitness = "declared" | "model";

export interface BalanceReconciliationWitnesses {
  /** El `current_balance_minor` guardado: declarado a mano, nunca verificado. */
  declaredMinor: number;
  /**
   * Lo que dice HOY la curva de la propia app, antes de esta reconstrucción.
   *
   * Ojo: cuando la deuda no tiene curva que andar, el motor devuelve justamente el
   * saldo declarado, y entonces los dos testigos son UNO disfrazado de dos. Degrada
   * bien (empate → `declared`, `stale: false`), pero un `against: "declared"` de ese
   * caso no es corroboración independiente de nada.
   */
  modelMinor: number;
}

export interface BalanceReconciliation {
  /** El testigo contra el que se midió (el más cercano al extremo). */
  expectedMinor: number;
  /** Extremo de la curva reconstruida, hoy. */
  resultingMinor: number;
  /** `resultingMinor - expectedMinor`, con signo. */
  deltaMinor: number;
  /** El margen aplicado, en céntimos. */
  toleranceMinor: number;
  status: BalanceReconciliationStatus;
  /**
   * `status !== "mismatch"`. Se conserva como booleano porque es lo que leen las
   * dos superficies; ya NO es lo que decide si se puede confirmar.
   */
  matches: boolean;
  against: BalanceWitness;
  /** La auditoría del ancla: el campo tecleado frente a la curva de la app. */
  anchor: {
    declaredMinor: number;
    modelMinor: number;
    /** `declaredMinor - modelMinor`, con signo. */
    driftMinor: number;
    /** El ancla no la reproduce ni la propia curva de la deuda. */
    stale: boolean;
  };
}

export function reconcileReconstructedBalance(
  input: BalanceReconciliationWitnesses & { resultingMinor: number },
): BalanceReconciliation {
  const { declaredMinor, modelMinor, resultingMinor } = input;
  // El testigo más cercano manda: es el que menos culpa al documento, y el
  // empate cae del lado del ancla para conservar el significado anterior.
  const against: BalanceWitness =
    Math.abs(resultingMinor - modelMinor) < Math.abs(resultingMinor - declaredMinor)
      ? "model"
      : "declared";
  const expectedMinor = against === "model" ? modelMinor : declaredMinor;
  const deltaMinor = resultingMinor - expectedMinor;
  const toleranceMinor = balanceToleranceMinor(expectedMinor);
  const status: BalanceReconciliationStatus =
    deltaMinor === 0
      ? "exact"
      : Math.abs(deltaMinor) <= toleranceMinor
        ? "within-tolerance"
        : "mismatch";

  return {
    against,
    anchor: {
      declaredMinor,
      driftMinor: declaredMinor - modelMinor,
      modelMinor,
      stale: !balancesAgree(modelMinor, declaredMinor),
    },
    deltaMinor,
    expectedMinor,
    matches: status !== "mismatch",
    resultingMinor,
    status,
    toleranceMinor,
  };
}

/** Formateador de dinero que inyecta la superficie que pinta la frase. */
export type MinorFormatter = (minor: number) => string;

function witnessLabel(against: BalanceWitness): string {
  return against === "model" ? "tu curva actual" : "tu saldo declarado";
}

/** La frase de garantía de la superficie C, por estado. */
export function reconciliationSentence(
  reconciliation: BalanceReconciliation,
  format: MinorFormatter,
): string {
  const { against, expectedMinor, resultingMinor, status, toleranceMinor } =
    reconciliation;
  if (status === "exact") {
    return "Reconciliado con el saldo conocido.";
  }
  if (status === "within-tolerance") {
    return `Cuadra dentro del margen (±${format(toleranceMinor)}): ${format(
      resultingMinor,
    )} frente a ${format(expectedMinor)}.`;
  }
  return `No cuadra: el documento deja ${format(resultingMinor)} y ${witnessLabel(
    against,
  )} dice ${format(expectedMinor)}. Puedes aplicarlo igualmente — mandará el documento.`;
}

/**
 * La frase que faltaba: el ancla que ni la propia curva de la deuda reproduce.
 * Es un diagnóstico que no depende de ningún documento, y en el caso medido daba
 * la respuesta correcta de entrada. `null` cuando el ancla está sana.
 */
export function anchorDriftSentence(
  reconciliation: BalanceReconciliation,
  format: MinorFormatter,
): string | null {
  if (!reconciliation.anchor.stale) return null;
  return `Tu saldo declarado (${format(
    reconciliation.anchor.declaredMinor,
  )}) no coincide ni con tu propia curva (${format(
    reconciliation.anchor.modelMinor,
  )}); el documento dice ${format(reconciliation.resultingMinor)}.`;
}

/**
 * Lo que la confirmación va a hacerle al saldo declarado, dicho ANTES de pulsar
 * («el documento tiene razón, actualiza el saldo declarado» era literalmente lo
 * que el usuario escribió en el chat y no tenía botón en ninguna parte).
 */
export function redeclarationSentence(
  reconciliation: BalanceReconciliation,
  format: MinorFormatter,
): string | null {
  const { declaredMinor } = reconciliation.anchor;
  if (declaredMinor === reconciliation.resultingMinor) return null;
  return `Al confirmar, tu saldo declarado pasará de ${format(declaredMinor)} a ${format(
    reconciliation.resultingMinor,
  )}.`;
}
