import { type BillingTier, CHECKOUT_PATH } from "@web/billing/adapter";
import { getBillingAdapter } from "@web/billing/get-billing-adapter";
import { readBillingEntitlement } from "@web/billing/read-billing-entitlement";
import { resolvePageShell } from "@web/page-shell";
import { readStoreTarget } from "@web/read-store-target";
import { Suspense } from "react";
import PremiumSkeleton from "./premium-skeleton";
import { buildPremiumView } from "./premium-view";

/**
 * Los tres carriles de compra (#1126) con su copy — SIN cifras: los precios
 * viven en el checkout hospedado del MoR, nunca en el repo (plan local).
 */
const TIERS: { tier: BillingTier; label: string; detail: string }[] = [
  {
    tier: "monthly",
    label: "Mensual",
    detail: "Suscripción mes a mes, cancelas cuando quieras.",
  },
  {
    tier: "annual",
    label: "Anual",
    detail: "Un pago al año, más barato que doce meses.",
  },
  {
    tier: "lifetime",
    label: "Lifetime",
    detail: "Un solo pago, premium para siempre. Cupo limitado de lanzamiento.",
  },
];

/**
 * La página de upgrade (PRD #1160 S5, #1165): el destino del CTA «Gestionar
 * premium» de todo paywall. Cero UI de facturación propia (#1135): los botones
 * son ENLACES —a {@link CHECKOUT_PATH}, que abre el checkout del MoR sobre una
 * transacción creada al pulsar (#1221)— y al portal del cliente para
 * cancelar/facturas. Enlaces y no form actions a propósito: la CSP
 * `form-action 'self'` bloquearía el salto al dominio del MoR tras un POST
 * nativo.
 *
 * Esta página NO habla con el MoR al renderizarse: solo pregunta al adapter qué
 * carriles ofrece hoy. Antes abría una transacción por tier en cada visita.
 *
 * Sin proveedor de billing configurado (el estado hasta S6) la página lo dice
 * honestamente en vez de fingir un checkout.
 */
export default function PremiumPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<PremiumSkeleton />}>
      <PremiumContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function PremiumContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  // Preserve the workspace guard (redirect to /empezar when uninitialized) that
  // the shared layout also enforces; the read is request-cached (#1190).
  await resolvePageShell({ searchParams: resolvedSearchParams });

  const target = await readStoreTarget();
  const entitlement = await readBillingEntitlement(target);
  const view = buildPremiumView({
    targetKind: target.kind,
    entitlement,
    now: new Date().toISOString(),
  });

  const adapter = getBillingAdapter();
  const workspaceId = target.kind === "authenticated" ? target.workspaceId : null;

  const checkoutLinks =
    view.showCheckout && adapter && workspaceId
      ? TIERS.filter((entry) => adapter.offersTier(entry.tier)).map((entry) => ({
          ...entry,
          url: `${CHECKOUT_PATH}?tier=${entry.tier}`,
        }))
      : [];

  const portalUrl =
    view.showPortal && adapter
      ? await adapter.portalUrl(entitlement?.billingCustomerId ?? null)
      : null;

  return (
    <section className="section" aria-label="Premium">
      <div className="panelHeader">
        <h2>Premium</h2>
      </div>
      <p>{view.statusLine}</p>

      {view.showCheckout ? (
        checkoutLinks.length > 0 ? (
          <ul className="premiumTierList">
            {checkoutLinks.map((entry) => (
              <li key={entry.tier}>
                <a className="btn" href={entry.url}>
                  {entry.label}
                </a>
                <p className="muted">{entry.detail}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            El pago todavía no está disponible en esta instalación. Tu plan y tus datos no
            cambian; vuelve a intentarlo más adelante.
          </p>
        )
      ) : null}

      {portalUrl ? (
        <p>
          <a href={portalUrl}>Portal de facturación</a> — cancelar la suscripción, cambiar
          el método de pago y descargar facturas, directamente con el proveedor de pago.
        </p>
      ) : null}

      <p className="muted">
        Lo que tecleas tú es gratis para siempre: posiciones manuales, lentes, histórico y
        export. Premium cubre lo que la máquina ingiere por ti — documentos, extractos y
        fuentes conectadas.
      </p>
    </section>
  );
}
