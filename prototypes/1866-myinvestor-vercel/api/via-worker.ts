/**
 * PROTOTIPO DESECHABLE de #1866: el camino realista. Vercel (`dub1`) llama al Worker de Cloudflare, que corre
 * en el nodo más cercano (Dublín) y hace el ciclo saliendo por IPs de Cloudflare. El Worker guarda la fila.
 */
import { guard } from "../lib/record.js";

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  const res = await fetch(
    `https://proto-1866-myinvestor.jenarvaezg.workers.dev/${new URL(request.url).searchParams.get("path") ?? "run"}`,
    {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    },
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
