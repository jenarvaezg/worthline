import { CHECKOUT_TIER_PARAM, CHECKOUT_TRANSACTION_PARAM } from "@web/billing/adapter";
import { getBillingAdapter } from "@web/billing/get-billing-adapter";
import { resolvePageShell } from "@web/page-shell";
import { readStoreTarget } from "@web/read-store-target";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import PaddleCheckout from "./paddle-checkout";
import PagarSkeleton from "./pagar-skeleton";
import { buildPagarPlan } from "./pagar-view";

/**
 * La ruta donde se paga (#1221) — y el **default payment link** que la cuenta
 * de Paddle declara, porque Paddle Billing no tiene página de pago propia a la
 * que enlazar (runbook `docs/agents/paddle-billing-sandbox.md`).
 *
 * Dos entradas:
 *
 *  - `?tier=…` — el clic de un carril en `/premium`. Se crea la transacción
 *    server-side (el workspace viaja en su custom data, #1135) y se vuelve aquí
 *    con su `_ptxn`. Crear la transacción al pulsar y no al pintar `/premium`
 *    es deliberado: antes cada visita a la página abría tres transacciones.
 *  - `?_ptxn=…` — una transacción que ya existe. Es el enlace que Paddle
 *    reparte en sus correos de impago y de «actualiza tu método de pago», así
 *    que esta rama tiene que funcionar para transacciones que no creamos.
 */
export default function PagarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<PagarSkeleton />}>
      <PagarContent searchParams={searchParams} />
    </Suspense>
  );
}

async function PagarContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  await resolvePageShell({ searchParams: resolvedSearchParams });

  const adapter = getBillingAdapter();
  const plan = buildPagarPlan({
    transactionParam: resolvedSearchParams[CHECKOUT_TRANSACTION_PARAM],
    tierParam: resolvedSearchParams[CHECKOUT_TIER_PARAM],
    offersTier: (tier) => adapter?.offersTier(tier) ?? false,
  });

  // El plan solo llega a `start` si el adapter ofertó el tier, así que aquí
  // existe; lo que puede faltar es el workspace (una sesión de demo o local).
  if (plan.kind === "start" && adapter) {
    const target = await readStoreTarget();
    const workspaceId = target.kind === "authenticated" ? target.workspaceId : null;
    const url = workspaceId
      ? await adapter.checkoutUrl({ workspaceId, tier: plan.tier })
      : null;
    // `redirect` lanza, así que el null cae al mensaje honesto de abajo.
    if (url) redirect(url);
  }

  return (
    <section className="section" aria-label="Pago">
      <div className="panelHeader">
        <h2>Pagar</h2>
      </div>

      {plan.kind === "checkout" ? (
        <PaddleCheckout transactionId={plan.transactionId} />
      ) : (
        <p className="muted">
          El pago no está disponible ahora mismo. Tu plan y tus datos no cambian.
        </p>
      )}

      <p>
        <a href="/premium">Volver a Premium</a>
      </p>
    </section>
  );
}
