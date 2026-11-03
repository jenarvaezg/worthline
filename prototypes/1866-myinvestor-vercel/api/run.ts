/**
 * PROTOTIPO DESECHABLE de #1866. Un ciclo completo como el que haría el cron diario de worthline:
 * login directo con la contraseña guardada → refresh → lecturas. El cron de Vercel lo llama cada día;
 * también se puede llamar a mano con `Authorization: Bearer $CRON_SECRET`.
 */
import { login, reads, refresh, type Step } from "../lib/myinvestor.js";
import { guard, record } from "../lib/record.js";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;

  const {
    MYINVESTOR_CUSTOMER_ID: customerId,
    MYINVESTOR_PASSWORD: password,
    MYINVESTOR_DEVICE_ID: deviceId,
  } = process.env;
  if (!customerId || !password || !deviceId)
    return new Response("faltan variables", { status: 500 });

  const trigger = request.headers.get("user-agent")?.includes("vercel-cron")
    ? "cron"
    : "manual";
  const steps: Step[] = [];
  const first = await login(customerId, password, deviceId);
  steps.push(first.step);
  if (first.kind !== "tokens") {
    const outcome =
      first.kind === "signature"
        ? "pide firma (dispositivo no conocido)"
        : "login rechazado";
    return Response.json(await record(trigger, outcome, steps));
  }

  const renewed = await refresh(first.tokens, deviceId);
  steps.push(renewed.step);
  steps.push(...(await reads(renewed.tokens ?? first.tokens, deviceId)));

  const failed = steps.some(
    (s) => s.waf || s.status === null || (s.status ?? 0) >= 400 || s.status === 202,
  );
  return Response.json(await record(trigger, failed ? "con fallos" : "ok", steps));
}
