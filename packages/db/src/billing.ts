/**
 * Billing → entitlements (PRD #1160 S5, #1165; contrato #1135): las
 * transiciones PURAS que un evento normalizado del merchant-of-record aplica
 * sobre la fila de entitlements. El control plane sigue siendo la única fuente
 * de verdad — el MoR solo la alimenta: cada transición ASERTA `plan='premium'`
 * y deja que las fechas lo acoten, de modo que `deriveEffectivePlan` (y ningún
 * job de expiración) es quien deja caer el workspace a free.
 *
 * El adapter por proveedor (S6) traduce su webhook/API a {@link BillingEvent} /
 * {@link BillingSubscriptionState}; nada aquí conoce a Paddle ni a Stripe.
 */

import type { WorkspaceEntitlement } from "./entitlements";

/**
 * Gracia corta tras un impago (#1135): premium se sostiene estos días desde el
 * evento para que el dunning del MoR pueda cobrar el reintento; si no llega la
 * activación que lo resuelva, la fecha pasa y el workspace cae a free solo.
 */
export const PAYMENT_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

interface BillingEventBase {
  /** Id del evento del proveedor — la clave de idempotencia del webhook. */
  eventId: string;
  /** Proveedor que emitió el evento (`fake` en S5; `paddle` llega en S6). */
  provider: string;
  /** El workspace del checkout — viaja en la custom data del MoR (#1135). */
  workspaceId: string;
  /** Cuándo ocurrió (ISO), según el proveedor. */
  occurredAt: string;
  /** Referencia del cliente en el MoR, si el evento la trae. */
  customerId: string | null;
}

/**
 * Los cuatro eventos mínimos del contrato (#1135), ya normalizados por el
 * adapter. `subscription_activated` cubre alta Y renovación (cada periodo
 * pagado llega con su nuevo `paidUntil`); `lifetime_purchased` es la compra
 * one-time que aplica el grant indefinido — el mismo carril que la palanca
 * manual de admin (S4), cero código especial.
 */
export type BillingEvent =
  | (BillingEventBase & {
      type: "subscription_activated";
      subscriptionId: string;
      /** Fin del periodo pagado (ISO). El adapter DEBE calcularlo. */
      paidUntil: string;
    })
  | (BillingEventBase & {
      type: "subscription_canceled";
      subscriptionId: string;
      /** Hasta cuándo llega lo ya pagado, o null si el proveedor no lo informa. */
      paidUntil: string | null;
    })
  | (BillingEventBase & {
      type: "payment_failed";
      subscriptionId: string;
    })
  | (BillingEventBase & {
      type: "lifetime_purchased";
    });

/**
 * El estado de una suscripción consultado a la API del MoR (el re-sync manual
 * de /admin), normalizado por el adapter a los tres estados que el contrato
 * distingue.
 */
export interface BillingSubscriptionState {
  status: "active" | "past_due" | "canceled";
  customerId: string | null;
  /** Fin del periodo pagado en curso (ISO), si la API lo informa. */
  paidUntil: string | null;
}

/**
 * Lo que una transición de billing escribe en la fila de entitlements: la
 * ventana y las referencias del MoR. El plan declarado es SIEMPRE `premium` —
 * quien decide el estado efectivo es `deriveEffectivePlan` sobre las fechas.
 */
export interface WorkspaceBillingState {
  premiumUntil: string | null;
  billingProvider: string;
  billingCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
}

type CurrentEntitlement = Pick<
  WorkspaceEntitlement,
  "plan" | "premiumUntil" | "billingCustomerId" | "subscriptionId"
>;

/** Un grant indefinido ya vigente (lifetime o palanca admin, #1133). */
function isIndefinitePremium(current: CurrentEntitlement | null): boolean {
  return current?.plan === "premium" && current.premiumUntil === null;
}

function laterOf(a: string | null, b: string): string {
  return a !== null && Date.parse(a) > Date.parse(b) ? a : b;
}

/**
 * La transición del contrato #1135: fila actual (o null) + evento normalizado →
 * estado de billing a escribir. Pura y determinista, así el webhook puede
 * re-aplicarse sin miedo.
 *
 *  - alta/renovación → premium hasta el fin del periodo pagado;
 *  - cancelación → premium hasta el fin de lo pagado, luego free por derivación;
 *  - impago → gracia corta ({@link PAYMENT_GRACE_DAYS}) que nunca ACORTA un
 *    periodo ya pagado más largo;
 *  - lifetime → grant indefinido (`premiumUntil: null`).
 *
 * Un grant indefinido vigente nunca se acorta por eventos de suscripción: el
 * lifetime (o la palanca admin) domina, y esos eventos solo actualizan las
 * referencias/estado del MoR.
 */
export function applyBillingEvent(
  current: CurrentEntitlement | null,
  event: BillingEvent,
): WorkspaceBillingState {
  const customerId = event.customerId ?? current?.billingCustomerId ?? null;

  if (event.type === "lifetime_purchased") {
    return {
      premiumUntil: null,
      billingProvider: event.provider,
      billingCustomerId: customerId,
      subscriptionId: current?.subscriptionId ?? null,
      subscriptionStatus: null,
    };
  }

  const subscriptionId = event.subscriptionId ?? current?.subscriptionId ?? null;
  const status =
    event.type === "subscription_activated"
      ? "active"
      : event.type === "subscription_canceled"
        ? "canceled"
        : "past_due";

  const refs = {
    billingProvider: event.provider,
    billingCustomerId: customerId,
    subscriptionId,
    subscriptionStatus: status,
  };

  if (isIndefinitePremium(current)) {
    return { premiumUntil: null, ...refs };
  }

  if (event.type === "subscription_activated") {
    return { premiumUntil: event.paidUntil, ...refs };
  }
  if (event.type === "subscription_canceled") {
    return {
      premiumUntil: event.paidUntil ?? current?.premiumUntil ?? event.occurredAt,
      ...refs,
    };
  }
  const graceEnd = new Date(
    Date.parse(event.occurredAt) + PAYMENT_GRACE_DAYS * DAY_MS,
  ).toISOString();
  return { premiumUntil: laterOf(current?.premiumUntil ?? null, graceEnd), ...refs };
}

/**
 * El re-sync manual de /admin (#1165): estado consultado a la API del MoR →
 * mismo estado a escribir que el webhook equivalente. Reutiliza
 * {@link applyBillingEvent} vía un evento sintético para que webhook y re-sync
 * no puedan divergir; una suscripción activa cuyo fin de periodo la API no
 * informe conserva la ventana ya almacenada antes que inventar una.
 */
export function billingStateFromSubscription(
  current: CurrentEntitlement | null,
  input: {
    provider: string;
    subscriptionId: string;
    state: BillingSubscriptionState;
    nowIso: string;
  },
): WorkspaceBillingState {
  const base = {
    eventId: "resync",
    provider: input.provider,
    workspaceId: "",
    occurredAt: input.nowIso,
    customerId: input.state.customerId,
    subscriptionId: input.subscriptionId,
  };

  if (input.state.status === "active") {
    return applyBillingEvent(current, {
      ...base,
      type: "subscription_activated",
      paidUntil: input.state.paidUntil ?? current?.premiumUntil ?? input.nowIso,
    });
  }
  if (input.state.status === "canceled") {
    return applyBillingEvent(current, {
      ...base,
      type: "subscription_canceled",
      paidUntil: input.state.paidUntil,
    });
  }
  return applyBillingEvent(current, { ...base, type: "payment_failed" });
}
