/**
 * El view-model puro de /premium (PRD #1160 S5, #1165): fila de entitlements +
 * clase de target → qué se dice y qué se ofrece. Reglas honestas:
 *
 *  - checkout solo cuando comprar tiene sentido (free, trial, o una
 *    suscripción cancelada que aún corre) — nunca doble compra;
 *  - un impago se arregla en el portal del MoR, no comprando otra vez;
 *  - un grant indefinido (lifetime/beta) no vende nada;
 *  - demo/local no tienen planes (`effectivePlanForTarget` ya los trata como
 *    premium para el gating; aquí simplemente no hay nada que gestionar).
 */

import type { StoreTarget } from "@web/store-resolver";
import {
  deriveEffectivePlan,
  type EntitlementPlan,
  type WorkspaceEntitlement,
} from "@worthline/db";

export interface PremiumView {
  plan: EntitlementPlan;
  /** Una frase de estado honesta para la cabecera de la página. */
  statusLine: string;
  /** Si se ofrecen los enlaces al checkout hospedado. */
  showCheckout: boolean;
  /** Si se enlaza el portal del cliente del MoR (cancelar, facturas). */
  showPortal: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const FREE_STATUS =
  "Tu plan es free: el seguimiento manual y todas las lentes, gratis para siempre. " +
  "Premium añade lo que la máquina ingiere por ti.";

export function buildPremiumView(input: {
  targetKind: StoreTarget["kind"];
  entitlement: WorkspaceEntitlement | null;
  now: string;
}): PremiumView {
  if (input.targetKind !== "authenticated") {
    return {
      plan: "premium",
      statusLine: "Esta edición no tiene planes: todo está disponible.",
      showCheckout: false,
      showPortal: false,
    };
  }

  const { entitlement, now } = input;
  const plan = deriveEffectivePlan(entitlement, now);
  const showPortal = Boolean(entitlement?.billingCustomerId);
  const status = entitlement?.subscriptionStatus ?? null;

  if (plan === "premium") {
    if (entitlement?.premiumUntil === null || entitlement === null) {
      return {
        plan,
        statusLine: "Tu cuenta es premium — para siempre.",
        showCheckout: false,
        showPortal,
      };
    }
    const until = formatDate(entitlement.premiumUntil!);
    if (status === "canceled") {
      return {
        plan,
        statusLine: `Premium hasta el ${until}: la suscripción está cancelada y no se renovará.`,
        showCheckout: true,
        showPortal,
      };
    }
    if (status === "past_due") {
      return {
        plan,
        statusLine:
          `Hay un pago pendiente: premium se mantiene hasta el ${until} mientras ` +
          "el proveedor reintenta el cobro. Puedes revisarlo en el portal de facturación.",
        showCheckout: false,
        showPortal,
      };
    }
    return {
      plan,
      statusLine: `Premium activo hasta el ${until}.`,
      showCheckout: false,
      showPortal,
    };
  }

  if (plan === "trial") {
    return {
      plan,
      statusLine: `Estás probando premium completo hasta el ${formatDate(
        entitlement!.trialEndsAt!,
      )}. Si no sigues, tus datos se quedan y lo manual sigue gratis.`,
      showCheckout: true,
      showPortal,
    };
  }

  return { plan, statusLine: FREE_STATUS, showCheckout: true, showPortal };
}
