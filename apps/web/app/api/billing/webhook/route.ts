/**
 * LA ruta de webhook de billing (PRD #1160 S5, #1165; contrato #1135) — una
 * sola para cualquier proveedor: el adapter configurado verifica la firma
 * sobre el cuerpo CRUDO, normaliza el payload a los cuatro eventos del
 * contrato, y `processBillingEvent` aplica idempotencia + transición sobre el
 * control plane. Un evento fuera del contrato se confirma con 200 para que el
 * MoR no lo reintente; sin proveedor configurado el billing no existe (503).
 */

import { getBillingAdapter } from "@web/billing/get-billing-adapter";
import { processBillingEvent } from "@web/billing/process-billing-event";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const adapter = getBillingAdapter();
  if (!adapter) {
    return Response.json({ error: "billing_not_configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  if (!(await adapter.verifyWebhook(rawBody, request.headers))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = adapter.parseWebhookEvent(rawBody);
  if (!event) {
    return Response.json({ ok: true, outcome: "ignored" });
  }

  const outcome = await processBillingEvent(event);
  return Response.json({ ok: true, outcome });
}
