/** PROTOTIPO DESECHABLE de #1866: sondas sin credenciales. Devuelven código, tipo de respuesta y el `status` del sobre. */
import type { Step } from "./myinvestor.js";

const HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  origin: "https://newapp.myinvestor.es",
  referer: "https://newapp.myinvestor.es/",
  "x-myinvestor-app": "version=3.134.0,platform=web",
};

async function probe(step: string, url: string, init: RequestInit = {}): Promise<Step> {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...HEADERS, ...(init.headers as Record<string, string>) },
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    let status = "";
    try {
      const body = JSON.parse(text);
      status = JSON.stringify(
        body?.status ?? body?.payload?.data?.errCode ?? Object.keys(body ?? {}),
      ).slice(0, 160);
    } catch {
      status = type.includes("html") ? "html" : text.slice(0, 80);
    }
    return {
      step,
      status: res.status,
      ms: Math.round(performance.now() - started),
      waf: type.includes("html") || text.includes("_Incapsula_Resource"),
      note: `${type.split(";")[0]} ${status}`,
    };
  } catch (error) {
    return {
      step,
      status: null,
      ms: Math.round(performance.now() - started),
      waf: false,
      note: (error as Error).name,
    };
  }
}

export async function probes(): Promise<Step[]> {
  return [
    await probe(
      "catálogo público",
      "https://api.myinvestor.es/cperf-server/api/v2/funds/IE00B03HD191",
    ),
    await probe("flags públicas", "https://config.myinvestor.es/flags/settings.json"),
    await probe(
      "login con cuerpo vacío",
      "https://api.myinvestor.es/login/api/v2/auth/token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": crypto.randomUUID(),
        },
        body: "{}",
      },
    ),
  ];
}
