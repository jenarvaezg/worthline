/**
 * PROTOTIPO DESECHABLE de #1866: un port mínimo de `myinvestor-cli/src/myinvestor/auth.py` para medir si
 * el login y las lecturas de MyInvestor pasan desde una función de Vercel. No se mergea nunca.
 *
 * Regla de oro: lo que sale de aquí son METADATOS (pasos, códigos HTTP, latencias, si respondió Imperva,
 * número de filas). Nunca importes, ISIN, ids de cuenta ni tokens: el repo es público.
 */

// biome-ignore lint/suspicious/noExplicitAny: prototipo desechable, JSON de MyInvestor sin esquema.
type Loose = any;

const API = "https://api.myinvestor.es";
const CPERF = "/cperf-server/api";
const LOGIN_PATH = "/login/api/v2/auth/token";
const REFRESH_PATH = "/login/api/v1/auth/token/refresh";
const SIGNATURE_BASE = "/signature/api/v3/public/signature";
const OTP_METHODS = ["OTP_SMS", "OTP_EMAIL", "OTP_PUSH"];

const HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  origin: "https://newapp.myinvestor.es",
  referer: "https://newapp.myinvestor.es/",
  "x-myinvestor-app": "version=3.134.0,platform=web",
};

export type Step = {
  step: string;
  status: number | null;
  ms: number;
  waf: boolean;
  rows?: number;
  note?: string;
};

type Raw = {
  status: number | null;
  ms: number;
  waf: boolean;
  body: Loose;
  error?: string;
};

async function send(
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Raw> {
  const started = performance.now();
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...HEADERS,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const html = (res.headers.get("content-type") ?? "").includes("text/html");
    const waf = html || text.slice(0, 2000).includes("_Incapsula_Resource");
    let parsed: Loose = null;
    if (!html && text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return {
      status: res.status,
      ms: Math.round(performance.now() - started),
      waf,
      body: parsed,
    };
  } catch (error) {
    return {
      status: null,
      ms: Math.round(performance.now() - started),
      waf: false,
      body: null,
      error: (error as Error).name,
    };
  }
}

const data = (body: Loose): Loose => body?.payload?.data;

function signatureOf(body: Loose): { requestId: string; methods: string[] } | null {
  let d = data(body);
  if (Array.isArray(d) && d.length === 1) d = d[0];
  if (!d || typeof d.signatureRequestId !== "string" || d.status !== "PENDING")
    return null;
  const methods = (d.pendingSignatureMethods ?? []).flat().map(String);
  return { requestId: d.signatureRequestId, methods };
}

export type Tokens = { access: string; refresh: string | null };

export type LoginResult =
  | { kind: "tokens"; tokens: Tokens; step: Step }
  | { kind: "signature"; requestId: string; methods: string[]; step: Step }
  | { kind: "rejected"; step: Step };

function loginResult(name: string, raw: Raw): LoginResult {
  const base: Step = {
    step: name,
    status: raw.status,
    ms: raw.ms,
    waf: raw.waf,
    note: raw.error,
  };
  const signature = signatureOf(raw.body);
  if (signature) {
    return {
      kind: "signature",
      ...signature,
      step: { ...base, note: `firma pedida: ${signature.methods.join("/")}` },
    };
  }
  const d = data(raw.body);
  if (raw.status === 200 && d?.accessToken) {
    const note = d.isPasswordChangeRequired ? "pide cambio de contraseña" : undefined;
    return {
      kind: "tokens",
      tokens: { access: d.accessToken, refresh: d.refreshToken ?? null },
      step: { ...base, note },
    };
  }
  const errCode = d?.errCode ? `errCode ${d.errCode}` : (raw.error ?? "sin errCode");
  return { kind: "rejected", step: { ...base, note: errCode } };
}

/** `login_direct`: sin reCAPTCHA, aceptado desde un dispositivo conocido. */
export async function login(
  customerId: string,
  password: string,
  deviceId: string,
): Promise<LoginResult> {
  const raw = await send(
    "POST",
    LOGIN_PATH,
    { "x-device-id": deviceId },
    { customerId, password },
  );
  return loginResult("login", raw);
}

/** El login repetido con `x-signature-id` una vez que la firma está COMPLETE. */
export async function signedLogin(
  customerId: string,
  password: string,
  deviceId: string,
  requestId: string,
): Promise<LoginResult> {
  const raw = await send(
    "POST",
    LOGIN_PATH,
    { "x-device-id": deviceId, "x-signature-id": requestId },
    { customerId, password },
  );
  return loginResult("login firmado", raw);
}

export async function refresh(
  tokens: Tokens,
  deviceId: string,
): Promise<{ tokens: Tokens | null; step: Step }> {
  if (!tokens.refresh) {
    return {
      tokens: null,
      step: {
        step: "refresh",
        status: null,
        ms: 0,
        waf: false,
        note: "sin refreshToken",
      },
    };
  }
  const raw = await send(
    "POST",
    REFRESH_PATH,
    { "x-device-id": deviceId },
    { refreshToken: tokens.refresh },
  );
  const d = data(raw.body);
  const ok = raw.status === 200 && d?.accessToken;
  return {
    tokens: ok ? { access: d.accessToken, refresh: d.refreshToken ?? null } : null,
    step: {
      step: "refresh",
      status: raw.status,
      ms: raw.ms,
      waf: raw.waf,
      note: raw.error,
    },
  };
}

/** Manda el código (SMS…) del primer método de código pendiente. Devuelve el `signatureId`. */
export async function startCode(
  requestId: string,
  methods: string[],
  deviceId: string,
): Promise<{ signatureId: string | null; method: string | null; step: Step }> {
  const method = methods.find((m) => OTP_METHODS.includes(m)) ?? null;
  if (!method) {
    return {
      signatureId: null,
      method,
      step: {
        step: "enviar código",
        status: null,
        ms: 0,
        waf: false,
        note: `sin método de código: ${methods.join("/")}`,
      },
    };
  }
  const raw = await send(
    "POST",
    `${SIGNATURE_BASE}/${encodeURIComponent(requestId)}?method=${method}`,
    { "x-device-id": deviceId },
  );
  const id = data(raw.body)?.signatureId;
  return {
    signatureId: typeof id === "string" ? id : null,
    method,
    step: {
      step: "enviar código",
      status: raw.status,
      ms: raw.ms,
      waf: raw.waf,
      note: method,
    },
  };
}

export async function submitCode(
  requestId: string,
  signatureId: string,
  code: string,
  deviceId: string,
): Promise<Step> {
  const raw = await send(
    "POST",
    `${SIGNATURE_BASE}/${encodeURIComponent(requestId)}/validate/${encodeURIComponent(signatureId)}`,
    { "x-device-id": deviceId },
    { code: code.trim() },
  );
  const d = data(raw.body);
  const status = Array.isArray(d) ? d[0]?.status : d?.status;
  return {
    step: "validar código",
    status: raw.status,
    ms: raw.ms,
    waf: raw.waf,
    note: status ?? raw.error,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function read(
  name: string,
  path: string,
  tokens: Tokens,
  deviceId: string,
): Promise<{ step: Step; rows: Loose[] }> {
  const raw = await send("GET", path, {
    authorization: `Bearer ${tokens.access}`,
    "x-device-id": deviceId,
  });
  const d = data(raw.body);
  const rows = Array.isArray(d) ? d : [];
  const note = raw.status === 202 ? "pide firma" : raw.error;
  return {
    step: {
      step: name,
      status: raw.status,
      ms: raw.ms,
      waf: raw.waf,
      rows: rows.length,
      note,
    },
    rows,
  };
}

/** Las lecturas de #1866: cuentas de valores y sus órdenes completas; cuentas de planes y sus órdenes. */
export async function reads(tokens: Tokens, deviceId: string): Promise<Step[]> {
  const today = new Date();
  const steps: Step[] = [];

  const securities = await read(
    "cuentas de valores",
    `${CPERF}/v2/securities-accounts/self-basic`,
    tokens,
    deviceId,
  );
  steps.push(securities.step);
  for (const [i, account] of securities.rows.entries()) {
    const id = encodeURIComponent(String(account.accountId ?? account.id));
    const params = `dateFrom=2000-01-01&dateTo=${ymd(today)}`;
    const orders = await read(
      `órdenes de valores (cuenta ${i + 1})`,
      `${CPERF}/v3/securities-accounts/${id}/orders?${params}`,
      tokens,
      deviceId,
    );
    steps.push(orders.step);
  }

  const pensions = await read(
    "cuentas de planes",
    `${CPERF}/v2/pension-accounts/self`,
    tokens,
    deviceId,
  );
  steps.push(pensions.step);
  for (const [i, account] of pensions.rows.entries()) {
    const id = encodeURIComponent(String(account.accountId));
    const params = `dateFrom=20000101&dateTo=${ymd(today).replaceAll("-", "")}`;
    const orders = await read(
      `órdenes de planes (cuenta ${i + 1})`,
      `${CPERF}/v2/pension-accounts/${id}/orders?${params}`,
      tokens,
      deviceId,
    );
    steps.push(orders.step);
  }
  return steps;
}
