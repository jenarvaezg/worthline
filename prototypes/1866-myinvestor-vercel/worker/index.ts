/**
 * PROTOTIPO DESECHABLE de #1866: el mismo ciclo que `api/run.ts`, pero en un Cloudflare Worker, para ver si
 * el login pasa saliendo por IPs de Cloudflare (desde Vercel/AWS, MyInvestor pide «Captcha required»).
 * `GET /run` (con `Authorization: Bearer CRON_SECRET`) o el cron diario. Solo guarda metadatos.
 */
import { createClient } from "@libsql/client/web";
import { login, reads, refresh, type Step } from "../lib/myinvestor.js";

type Env = {
  CRON_SECRET: string;
  MYINVESTOR_CUSTOMER_ID: string;
  MYINVESTOR_PASSWORD: string;
  MYINVESTOR_DEVICE_ID: string;
  PROTO_DB_URL: string;
  PROTO_DB_TOKEN: string;
};

async function cycle(
  env: Env,
  trigger: string,
  colo: string | null,
): Promise<Record<string, unknown>> {
  const steps: Step[] = [];
  const first = await login(
    env.MYINVESTOR_CUSTOMER_ID,
    env.MYINVESTOR_PASSWORD,
    env.MYINVESTOR_DEVICE_ID,
  );
  steps.push(first.step);
  let outcome = first.kind === "signature" ? "pide firma" : "login rechazado";
  if (first.kind === "tokens") {
    const renewed = await refresh(first.tokens, env.MYINVESTOR_DEVICE_ID);
    steps.push(renewed.step);
    steps.push(
      ...(await reads(renewed.tokens ?? first.tokens, env.MYINVESTOR_DEVICE_ID)),
    );
    const failed = steps.some(
      (s) => s.waf || s.status === null || s.status >= 400 || s.status === 202,
    );
    outcome = failed ? "con fallos" : "ok";
  }
  let ip: string | null = null;
  try {
    ip =
      (
        (await (await fetch("https://api.ipify.org?format=json")).json()) as {
          ip?: string;
        }
      ).ip ?? null;
  } catch {}
  const row = {
    at: new Date().toISOString(),
    region: `cloudflare:${colo ?? "?"}`,
    trigger,
    outcome,
    ip,
    totalMs: steps.reduce((sum, s) => sum + s.ms, 0),
    steps,
  };
  const db = createClient({ url: env.PROTO_DB_URL, authToken: env.PROTO_DB_TOKEN });
  await db.execute({
    sql: "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [row.at, row.region, trigger, outcome, ip, row.totalMs, JSON.stringify(steps)],
  });
  return row;
}

/** El nodo de Cloudflare que ejecuta el Worker (en el cron no hay `request.cf`). */
async function traceColo(): Promise<string | null> {
  try {
    const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    return trace.match(/^colo=(\w+)$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/ip") {
      if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
        return new Response("no", { status: 401 });
      }
      const ip4 = await traceColo();
      const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? null;
      return Response.json({ colo, ip4 });
    }
    if (new URL(request.url).pathname !== "/run")
      return new Response("no", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
      return new Response("no", { status: 401 });
    }
    const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? null;
    return Response.json(await cycle(env, "manual", colo));
  },
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<void> {
    ctx.waitUntil(traceColo().then((colo) => cycle(env, "cron", colo)));
  },
};
