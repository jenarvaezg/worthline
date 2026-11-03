/**
 * PROTOTIPO DESECHABLE de #1866, punto 3: el login con SMS en dos pasos, cada paso en una invocación
 * distinta (y quizá en otra máquina e IP de Vercel).
 *
 * - `POST /api/sms?step=start`: login con un `device_id` NUEVO (`?device=<uuid>`), que MyInvestor no
 *   conoce. Si pide firma, manda el SMS y devuelve `{requestId, signatureId}` para el segundo paso.
 * - `POST /api/sms?step=finish&device=<uuid>&requestId=…&signatureId=…&code=123456`: valida el código y
 *   repite el login firmado. Si entra, ese `device_id` pasa a ser «conocido».
 *
 * Los ids de la firma solo vuelven a quien llama (con el CRON_SECRET), nunca a la BD de resultados.
 */
import {
  login,
  type Step,
  signedLogin,
  startCode,
  submitCode,
} from "../lib/myinvestor.js";
import { guard, record } from "../lib/record.js";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;

  const { MYINVESTOR_CUSTOMER_ID: customerId, MYINVESTOR_PASSWORD: password } =
    process.env;
  const url = new URL(request.url);
  const device = url.searchParams.get("device");
  if (!customerId || !password || !device)
    return new Response("faltan variables o ?device", { status: 400 });

  const steps: Step[] = [];
  if (url.searchParams.get("step") === "start") {
    const first = await login(customerId, password, device);
    steps.push(first.step);
    if (first.kind !== "signature") {
      const outcome =
        first.kind === "tokens"
          ? "entra sin SMS con dispositivo nuevo"
          : "login rechazado";
      return Response.json(await record("sms-start", outcome, steps));
    }
    const sent = await startCode(first.requestId, first.methods, device);
    steps.push(sent.step);
    const result = await record(
      "sms-start",
      sent.signatureId ? "código enviado" : "no se pudo enviar",
      steps,
    );
    return Response.json({
      ...result,
      next: { requestId: first.requestId, signatureId: sent.signatureId },
    });
  }

  const requestId = url.searchParams.get("requestId");
  const signatureId = url.searchParams.get("signatureId");
  const code = url.searchParams.get("code");
  if (!requestId || !signatureId || !code)
    return new Response("faltan requestId, signatureId o code", { status: 400 });
  const validated = await submitCode(requestId, signatureId, code, device);
  steps.push(validated);
  const signed = await signedLogin(customerId, password, device, requestId);
  steps.push(signed.step);
  const outcome =
    signed.kind === "tokens"
      ? "entra: dispositivo verificado"
      : "no entra tras el código";
  return Response.json(await record("sms-finish", outcome, steps));
}
