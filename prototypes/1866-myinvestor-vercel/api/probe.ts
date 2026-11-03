/**
 * PROTOTIPO DESECHABLE de #1866. Sondas SIN credenciales, para separar «la IP de Vercel está vetada» de
 * «el port manda algo distinto»: una lectura pública del catálogo y un login con el cuerpo vacío (no apunta
 * a ninguna cuenta). Se compara con lo mismo lanzado desde el Mac (`bun probe-local.ts`).
 */

import { probes } from "../lib/probes.js";
import { guard, record } from "../lib/record.js";

export async function GET(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  return Response.json(await record("probe", "sondas", await probes()));
}
