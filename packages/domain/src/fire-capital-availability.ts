/**
 * La fecha de disponibilidad declarada, y lo único que hace con ella el motor
 * (#1528, ADR 0100).
 *
 * El escalón `term-locked` de la escalera de liquidez (ADR 0013) se define como
 * «bloqueado hasta una fecha o una edad» — y esa fecha **no existía en el modelo**:
 * el peldaño decía que había un plazo y nunca decía cuál. De ahí que un plan de
 * pensiones se tratara como un bloque todo-o-nada, con las dos únicas salidas
 * posibles igual de falsas: contarlo entero como capital vendible (promete dinero
 * encerrado) o sacarlo entero (esconde dinero que ya se puede rescatar).
 *
 * Lo que se declara es **una fecha**, nunca un importe. Un «disponible hoy: 4.979 €»
 * caduca cada año y nadie lo revalida — la forma de fallo de #1415 y justo lo que
 * ADR 0074 prohíbe. Una fecha no caduca; el importe disponible se **deriva en
 * lectura**, contra el día que el llamador trae (ADR 0024: el dominio no lee el reloj).
 *
 * Y la fecha nunca se deriva del libro. Una entrada por movilización externa (#1518)
 * o una apertura (#1490) llevan la fecha del trámite, no la de las aportaciones que
 * la generaron: leer la antigüedad de esa fila diría «bloqueado hasta 2035» sobre
 * dinero rescatable hoy. Sin declaración no hay tramo, y sin tramo no se mueve nada.
 *
 * **Qué cambia de respuesta y qué no.** Solo el gasto sostenible **de agotamiento**
 * (`fire-sustainable-spending`, ADR 0081): es el único que reparte el capital de hoy
 * en un calendario, así que es el único al que se le puede preguntar «¿de dónde sale
 * el dinero del año 3?». La versión perpetua no toca el principal y el número FIRE no
 * tiene calendario; meterles la fecha sería inventar una tercera columna de la
 * partición que #1523 rechaza explícitamente.
 */

/** Una declaración de disponibilidad: la fecha, y el capital que espera detrás. */
export interface DeclaredAvailability {
  /** Desde cuándo se puede tocar (YYYY-MM-DD), tal y como el usuario la declaró. */
  availableFrom: string;
  /** Lo que el ámbito posee de ese holding, elegible y bruto de deuda y reserva. */
  amountMinor: number;
}

/** Una declaración ya resuelta contra el día de lectura: en cuántos años se libera. */
export interface AvailabilityTranche {
  /** Años enteros hasta que el capital se puede tocar. Siempre ≥ 1. */
  yearsUntil: number;
  amountMinor: number;
}

/** El calendario del capital vendible, resuelto contra un día concreto. */
export interface FireCapitalAvailability {
  /**
   * Los tramos con fecha futura, agrupados por año y ordenados de antes a después.
   * Vacío cuando nadie ha declarado nada — que es el estado por defecto y el que
   * deja el reparto exactamente como estaba.
   */
  tranches: AvailabilityTranche[];
  /** Σ `tranches`, ya topado al capital vendible neto. */
  lockedMinor: number;
  /**
   * Lo declarado ANTES de resolverlo contra ningún día. Sin reloj es lo único que se
   * sabe, y por eso existe: es la cifra con la que la pantalla puede decir «hay esto
   * declarado y no lo he podido situar en el calendario» en vez de callar.
   */
  declaredMinor: number;
  /**
   * Capital a plazo que el ámbito posee y que **no** ha declarado fecha. No es cero
   * ni es bloqueo: es un hueco, y la pantalla lo nombra en vez de repartirlo en
   * silencio como si estuviera disponible hoy.
   *
   * Topado igual que `lockedMinor`, contra lo que queda del vendible neto una vez
   * descontado el bloqueo: las dos cifras salen en la MISMA tarjeta, y con bases
   * distintas un ámbito endeudado podría leer más «a plazo sin fecha» que todo su
   * lado vendible (ADR 0077).
   */
  undeclaredMinor: number;
  /**
   * `false` cuando el llamador no trajo día de lectura: entonces no se resolvió
   * ninguna fecha y el reparto es el de siempre. Existe para que una pantalla no
   * pueda imprimir «sin bloqueos» cuando lo que pasa es que nadie miró el reloj —
   * y lo que hace posible decirlo es `declaredMinor`, que no necesita reloj.
   */
  resolved: boolean;
}

/**
 * Los años enteros que faltan para `availableFrom` desde `todayISO`: el menor `y`
 * tal que `hoy + y años ≥ la fecha`. `0` cuando ya se puede tocar.
 *
 * Por calendario y no por días: dividir días entre 365 (o entre 365,25) desplaza un
 * año entero en cuanto un bisiesto cae dentro del tramo, y el reparto de abajo pone
 * sus pagos en aniversarios, no en múltiplos de 365 días.
 */
export function yearsUntilAvailable(availableFrom: string, todayISO: string): number {
  const years = Number(availableFrom.slice(0, 4)) - Number(todayISO.slice(0, 4));
  // `MM-DD` con ceros a la izquierda ordena lexicográficamente igual que en el
  // calendario, así que la comparación de cadenas es la comparación de fechas.
  const needsOneMore = availableFrom.slice(5) > todayISO.slice(5);

  return Math.max(0, years + (needsOneMore ? 1 : 0));
}

export interface ResolveCapitalAvailabilityInput {
  /** Las declaraciones del ámbito, tal y como el pool elegible las recogió. */
  declared: readonly DeclaredAvailability[];
  /** Capital a plazo elegible del ámbito SIN fecha declarada. */
  undeclaredMinor: number;
  /** El vendible NETO de deuda y reserva — el techo de lo que puede estar bloqueado. */
  sellableMinor: number;
  /** El día de lectura. `undefined` = el llamador no trajo reloj: no se resuelve nada. */
  todayISO: string | undefined;
}

/**
 * Resolver las declaraciones contra un día: agrupar por año, tirar lo que ya está
 * disponible y topar el total al vendible neto.
 *
 * **Por qué se topa, y por qué recortando el tramo que antes se libera.** El vendible
 * de la pantalla ya viene neto de su deuda y de la reserva por metas (#1447), y esas
 * dos cosas se pagan con lo que se puede tocar. Cuando no llega, lo que falta sale del
 * PRIMER dinero que se libere — no del último — así que el recorte muerde por delante.
 * Recortar por detrás dejaría el bloqueo más corto de lo que es y volvería a prometer
 * dinero encerrado, que es exactamente lo que este módulo viene a evitar.
 */
export function resolveCapitalAvailability(
  input: ResolveCapitalAvailabilityInput,
): FireCapitalAvailability {
  const { declared, sellableMinor, todayISO, undeclaredMinor } = input;

  const cap = Math.max(0, sellableMinor);
  const declaredMinor = declared.reduce(
    (sum, declaration) => sum + Math.max(0, declaration.amountMinor),
    0,
  );

  if (todayISO === undefined) {
    return {
      declaredMinor,
      lockedMinor: 0,
      resolved: false,
      tranches: [],
      undeclaredMinor: Math.min(undeclaredMinor, cap),
    };
  }

  const byYear = new Map<number, number>();
  for (const declaration of declared) {
    const yearsUntil = yearsUntilAvailable(declaration.availableFrom, todayISO);
    // `0` = ya se puede tocar: no es un tramo, es capital disponible como el resto.
    if (yearsUntil === 0 || declaration.amountMinor <= 0) {
      continue;
    }
    byYear.set(yearsUntil, (byYear.get(yearsUntil) ?? 0) + declaration.amountMinor);
  }

  const ordered = [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([yearsUntil, amountMinor]) => ({ amountMinor, yearsUntil }));

  const total = ordered.reduce((sum, tranche) => sum + tranche.amountMinor, 0);
  let excess = Math.max(0, total - cap);

  const tranches: AvailabilityTranche[] = [];
  for (const tranche of ordered) {
    const trimmed = Math.min(excess, tranche.amountMinor);
    excess -= trimmed;
    const amountMinor = tranche.amountMinor - trimmed;
    if (amountMinor > 0) {
      tranches.push({ amountMinor, yearsUntil: tranche.yearsUntil });
    }
  }

  const lockedMinor = tranches.reduce((sum, tranche) => sum + tranche.amountMinor, 0);

  return {
    declaredMinor,
    lockedMinor,
    resolved: true,
    tranches,
    // Contra lo que queda del vendible neto después del bloqueo: las dos cifras se
    // imprimen juntas y no pueden estar en bases distintas.
    undeclaredMinor: Math.min(undeclaredMinor, Math.max(0, cap - lockedMinor)),
  };
}

export interface AvailabilityAwareAnnuityInput {
  /** El capital que hay que repartir (minor units) — el vendible neto. */
  principalMinor: number;
  /** El retorno real con el que se anualiza. */
  realReturn: number;
  /** Los años que tiene que durar. > 0. */
  years: number;
  /** Los tramos bloqueados, cuya suma no puede exceder `principalMinor`. */
  tranches: readonly AvailabilityTranche[];
}

export interface AvailabilityAwareAnnuity {
  annualMinor: number;
  /** Si la cifra la fijó un bloqueo y no el horizonte completo. */
  limitedByAvailability: boolean;
}

/**
 * Lo que un capital soporta al año si tiene que durar exactamente `years` y acabarse,
 * **sin repartir en ningún año dinero que ese año todavía no se puede tocar**.
 *
 * Sin tramos es la anualidad de siempre, `P · r / (1 − (1+r)^−n)`, con la misma
 * aritmética y el mismo redondeo: la cifra de quien no ha declarado nada no se mueve
 * ni en un céntimo.
 *
 * Con tramos, el nivel de gasto es el MENOR que cumple todas las restricciones a la
 * vez: para cada horizonte `k`, lo retirado en los primeros `k` años tiene que caber
 * en el capital ya liberado a esa altura. Como el capital disponible es una escalera,
 * basta mirar el año anterior a cada liberación (donde la restricción más aprieta) y
 * el horizonte completo. El capital que no se libera dentro del horizonte no entra en
 * ninguna restricción: no se reparte, y la cifra lo refleja bajando.
 */
export function availabilityAwareAnnuity(
  input: AvailabilityAwareAnnuityInput,
): AvailabilityAwareAnnuity {
  const { principalMinor, realReturn, tranches, years } = input;

  /**
   * La anualidad `P · r / (1 − (1+r)^−n)`, en términos reales porque la tasa lo es.
   * Con retorno cero (o por debajo de −100 %, que no compone) es el reparto lineal
   * `P / n`: el mismo resultado al que la fórmula tiende, sin dividir por cero.
   */
  const paymentFor = (capitalMinor: number, horizon: number): number =>
    realReturn === 0 || realReturn <= -1
      ? capitalMinor / horizon
      : (capitalMinor * realReturn) / (1 - (1 + realReturn) ** -horizon);

  const ordered = [...tranches]
    .filter((tranche) => tranche.amountMinor > 0 && tranche.yearsUntil >= 1)
    .sort((a, b) => a.yearsUntil - b.yearsUntil);
  const lockedMinor = ordered.reduce((sum, tranche) => sum + tranche.amountMinor, 0);

  const full = paymentFor(principalMinor, years);
  let best = full;

  // Lo que se puede tocar hoy. Va subiendo escalón a escalón según se liberan tramos.
  let availableMinor = principalMinor - lockedMinor;

  for (const tranche of ordered) {
    // El año anterior a la liberación: donde este escalón aprieta más. Un tramo que
    // se libera después del horizonte no abre ninguna ventana intermedia — su
    // restricción es la del horizonte completo, que se comprueba al salir del bucle.
    const horizon = Math.min(tranche.yearsUntil - 1, years);
    if (horizon >= 1) {
      best = Math.min(best, paymentFor(availableMinor, horizon));
    }
    if (tranche.yearsUntil <= years) {
      availableMinor += tranche.amountMinor;
    }
  }

  // El horizonte completo, con lo que de verdad se ha liberado a esa altura: el
  // capital que nunca se libera se queda fuera del reparto en vez de prometerse.
  best = Math.min(best, paymentFor(availableMinor, years));

  return {
    annualMinor: Math.round(best),
    // Estricto: una restricción que empata con el horizonte completo no ha cambiado
    // la cifra, y decir que sí haría que la pantalla explicara un recorte inexistente.
    limitedByAvailability: best < full,
  };
}
