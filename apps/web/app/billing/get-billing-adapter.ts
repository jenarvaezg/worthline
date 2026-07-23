/**
 * El registro de adapters de billing (PRD #1160 S5, #1165; S6, #1166): resuelve
 * el proveedor configurado por env a su {@link BillingAdapter}. Existen el
 * adapter de pruebas (`fake`, para sandbox/e2e) y el real de Paddle (`paddle`).
 * Sin proveedor configurado —o con su config incompleta— no hay billing: la
 * ruta de webhook responde 503 y las superficies de upgrade lo dicen
 * honestamente.
 */

import { Environment } from "@paddle/paddle-node-sdk";

import type { BillingAdapter } from "./adapter";
import { createFakeBillingAdapter, FAKE_BILLING_PROVIDER } from "./fake-adapter";
import { createPaddleBillingAdapter, PADDLE_BILLING_PROVIDER } from "./paddle-adapter";

export function getBillingAdapter(
  env: Record<string, string | undefined> = process.env,
): BillingAdapter | null {
  if (env.WORTHLINE_BILLING_PROVIDER === FAKE_BILLING_PROVIDER) {
    const secret = env.WORTHLINE_BILLING_FAKE_SECRET;
    if (!secret) return null;
    return createFakeBillingAdapter({
      secret,
      checkoutBaseUrl: env.WORTHLINE_BILLING_FAKE_CHECKOUT_URL ?? null,
      portalUrl: env.WORTHLINE_BILLING_FAKE_PORTAL_URL ?? null,
    });
  }

  if (env.WORTHLINE_BILLING_PROVIDER === PADDLE_BILLING_PROVIDER) {
    const apiKey = env.WORTHLINE_PADDLE_API_KEY;
    const webhookSecret = env.WORTHLINE_PADDLE_WEBHOOK_SECRET;
    // Sin API key y secreto no se puede ni cobrar ni verificar webhooks: mejor
    // "billing no configurado" que un adapter a medias que finge un checkout.
    if (!apiKey || !webhookSecret) return null;
    return createPaddleBillingAdapter({
      apiKey,
      webhookSecret,
      environment:
        env.WORTHLINE_PADDLE_ENV === "production"
          ? Environment.production
          : Environment.sandbox,
      // Cada price id es opcional: un tier sin configurar no se ofrece (así se
      // despublica el lifetime al agotarse el cupo, #1126).
      priceIds: {
        monthly: env.WORTHLINE_PADDLE_PRICE_MONTHLY,
        annual: env.WORTHLINE_PADDLE_PRICE_ANNUAL,
        lifetime: env.WORTHLINE_PADDLE_PRICE_LIFETIME,
      },
    });
  }

  return null;
}
