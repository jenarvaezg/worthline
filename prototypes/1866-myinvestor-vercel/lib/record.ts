/**
 * PROTOTIPO DESECHABLE de #1866. Guarda cada ejecución (solo metadatos) en una BD de Turso de usar y tirar
 * (`proto-1866`), para tener la tabla de 5 días sin depender de los logs de Vercel, que caducan en una hora.
 */
import { createClient } from "@libsql/client";
import type { Step } from "./myinvestor.js";

export function guard(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("no", { status: 401 });
  }
  return null;
}

async function egressIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    return ((await res.json()) as { ip?: string }).ip ?? null;
  } catch {
    return null;
  }
}

export async function record(
  trigger: string,
  outcome: string,
  steps: Step[],
): Promise<Record<string, unknown>> {
  const row = {
    at: new Date().toISOString(),
    region: process.env.VERCEL_REGION ?? null,
    trigger,
    outcome,
    ip: await egressIp(),
    totalMs: steps.reduce((sum, s) => sum + s.ms, 0),
    steps,
  };
  const url = process.env.PROTO_DB_URL;
  if (url) {
    const db = createClient({ url, authToken: process.env.PROTO_DB_TOKEN });
    await db.execute(
      "CREATE TABLE IF NOT EXISTS runs (at TEXT, region TEXT, trigger TEXT, outcome TEXT, ip TEXT, total_ms INTEGER, steps TEXT)",
    );
    await db.execute({
      sql: "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [
        row.at,
        row.region,
        trigger,
        outcome,
        row.ip,
        row.totalMs,
        JSON.stringify(steps),
      ],
    });
  }
  return row;
}
