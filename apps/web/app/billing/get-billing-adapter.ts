/**
 * El registro de adapters de billing (PRD #1160 S5, #1165): resuelve el
 * proveedor configurado por env a su {@link BillingAdapter}. En S5 solo existe
 * el adapter de pruebas (`fake`, para sandbox/e2e); S6 (#1166) registra aquí el
 * adapter real de Paddle. Sin proveedor configurado no hay billing: la ruta de
 * webhook responde 503 y las superficies de upgrade lo dicen honestamente.
 */

import type { BillingAdapter } from "./adapter";
import { createFakeBillingAdapter, FAKE_BILLING_PROVIDER } from "./fake-adapter";

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
  return null;
}
