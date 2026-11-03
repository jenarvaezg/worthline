/**
 * PROTOTIPO DESECHABLE de #1866: el mismo ciclo que `api/run.ts`, pero desde el Mac de Jose (su IP de casa),
 * para separar «la IP de Vercel» de «el port a TS manda algo distinto». Solo imprime metadatos.
 * Las credenciales llegan por env desde el llavero (ver el comando en el comentario de cierre de #1866).
 */
import { login, reads, refresh, type Step } from "./lib/myinvestor.js";

const {
  MYINVESTOR_CUSTOMER_ID: customerId,
  MYINVESTOR_PASSWORD: password,
  MYINVESTOR_DEVICE_ID: deviceId,
} = process.env;
if (!customerId || !password || !deviceId) throw new Error("faltan variables");

const steps: Step[] = [];
const first = await login(customerId, password, deviceId);
steps.push(first.step);
if (first.kind === "tokens") {
  const renewed = await refresh(first.tokens, deviceId);
  steps.push(renewed.step);
  steps.push(...(await reads(renewed.tokens ?? first.tokens, deviceId)));
}
console.log(JSON.stringify({ where: "local", outcome: first.kind, steps }, null, 2));
