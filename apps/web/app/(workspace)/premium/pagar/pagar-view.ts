/**
 * La decisión pura de la ruta de pago (#1221): dado lo que trae la query y qué
 * carriles ofrece el proveedor, QUÉ hace la página — abrir el checkout de una
 * transacción, arrancar una nueva para un tier, o decir honestamente que el
 * pago no está disponible. Sin `await`, sin adapter y sin React, para que las
 * tres ramas se prueben sin navegador (ADR 0036).
 */

import { type BillingTier, parseBillingTier } from "@web/billing/adapter";

export type PagarPlan =
  /** Abrir el checkout del proveedor sobre una transacción que ya existe. */
  | { kind: "checkout"; transactionId: string }
  /** Crear la transacción de ese tier y volver aquí con su `_ptxn`. */
  | { kind: "start"; tier: BillingTier }
  /** Ni transacción válida ni tier ofertable: no hay pago que abrir. */
  | { kind: "unavailable" };

/**
 * Los ids de transacción de Paddle (`txn_` + base32 del ULID). Se valida la
 * FORMA porque este valor llega por la query —de un enlace nuestro, pero
 * también de los correos de impago y de «actualiza tu método de pago» que
 * manda Paddle— y de aquí va derecho a Paddle.js.
 */
const TRANSACTION_ID = /^txn_[0-9a-z]{20,30}$/;

function firstValue(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildPagarPlan({
  transactionParam,
  tierParam,
  offersTier,
}: {
  /** El `_ptxn` de la query, tal cual llega. */
  transactionParam: string | string[] | undefined;
  /** El `tier` de la query — el carril que se pulsó en /premium. */
  tierParam: string | string[] | undefined;
  /** Si el proveedor ofrece ese tier hoy (#1126: el cupo se despublica). */
  offersTier: (tier: BillingTier) => boolean;
}): PagarPlan {
  // Una transacción ya creada manda sobre el tier: es el caso del enlace que
  // Paddle reparte, y repetirlo no debe abrir una compra nueva.
  const transactionId = firstValue(transactionParam);
  if (transactionId) {
    return TRANSACTION_ID.test(transactionId)
      ? { kind: "checkout", transactionId }
      : { kind: "unavailable" };
  }

  const tier = parseBillingTier(firstValue(tierParam));
  if (tier && offersTier(tier)) return { kind: "start", tier };
  return { kind: "unavailable" };
}
