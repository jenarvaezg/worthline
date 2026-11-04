/**
 * PROTOTIPO #1879 — desechable. El flujo de conectar MyInvestor (S4 del PRD #1876)
 * como máquina de estados en memoria: no llama a MyInvestor ni escribe en la BD.
 * Lo que sí hace es decir, tras cada paso, QUÉ quedaría guardado (el paso pendiente
 * y `credentials_json`), que es parte de lo que hay que decidir con cada variante.
 *
 * Pregunta: ¿dónde vive la decisión de guardar la contraseña dentro del alta?
 *   A · en el mismo pliegue que el login (la casilla junto a la contraseña);
 *   B · en una página por pasos, como último paso tras verificar el móvil;
 *   C · fuera del alta: se conecta sin guardarla y se ofrece en la fila ya conectada.
 */

export const VARIANTS = [
  { key: "A", name: "Casilla en el pliegue del login" },
  { key: "B", name: "Página por pasos, la casilla al final" },
  { key: "C", name: "Conectar sin guardar; la casilla en la fila" },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];

export function prototypeVariantFor(
  params: Record<string, string | string[] | undefined> | undefined,
): VariantKey | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = params?.variante;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return VARIANTS.some((variant) => variant.key === value) ? (value as VariantKey) : null;
}

/** El texto literal de ADR 0114, decisión 1. No se edita aquí: se copia. */
export const RISK_TEXT =
  "Guardar la contraseña permite que worthline ponga tus datos al día cada día sin " +
  "pedírtela. worthline solo la usa para leer, pero quien la obtenga puede entrar en " +
  "tu cuenta de MyInvestor y verlo todo. MyInvestor exige que tus claves sean " +
  "personales e intransferibles: si alguien las usa para un fraude, el banco puede " +
  "alegar que no las protegiste y dejarte a ti la pérdida entera. Las órdenes y las " +
  "transferencias siguen necesitando tu firma en el móvil: no apruebes nunca una " +
  "notificación que no hayas pedido tú.";

/** La frase que se acepta al marcar la casilla (ADR 0114, decisión 1). */
export const ACCEPTANCE_TEXT =
  "Entiendo el riesgo y lo asumo. worthline no se hace responsable de las pérdidas " +
  "que puedan derivarse de guardar o usar esta contraseña.";

// ── Los mandos del escenario ───────────────────────────────────────────────

export type Plan = "premium" | "free";
export type Role = "editor" | "viewer";
/** `known`: el dispositivo ya pasó el SMS una vez; `sms`: MyInvestor lo pide. */
export type Device = "sms" | "known";
export type LoginOutcome =
  | "ok"
  | "password_rejected"
  | "rejected_no_reason"
  | "network_or_waf";
export type CodeOutcome = "ok" | "code_rejected";

export interface Scenario {
  plan: Plan;
  role: Role;
  device: Device;
  login: LoginOutcome;
  code: CodeOutcome;
}

export const DEFAULT_SCENARIO: Scenario = {
  code: "ok",
  device: "sms",
  login: "ok",
  plan: "premium",
  role: "editor",
};

// ── El flujo ───────────────────────────────────────────────────────────────

/** Minutos de vida del paso pendiente (ADR 0114, decisión 6). */
export const PENDING_TTL_MIN = 5;

export interface Pending {
  /** Minuto simulado en que nació el paso pendiente. */
  since: number;
  /** Si el paso pendiente guarda, sellados, el usuario y la contraseña. */
  holdsPassword: boolean;
  /** Lo que se marcó en el paso 1 (A); en B se decide después. */
  save: boolean;
}

export type Flow =
  | { step: "credentials"; error: string | null }
  | { step: "sms"; pending: Pending; error: string | null }
  /** Solo B: el paso de «¿cada día o a mano?», con la verificación ya hecha. */
  | { step: "choose"; pending: Pending; error: string | null }
  | { step: "connected"; savedAt: number | null; justConnected: boolean };

export const INITIAL_FLOW: Flow = { error: null, step: "credentials" };

export const LOGIN_ERRORS: Record<Exclude<LoginOutcome, "ok">, string> = {
  network_or_waf:
    "No hemos podido hablar con MyInvestor. No se ha guardado nada; vuelve a intentarlo en unos minutos.",
  password_rejected:
    "MyInvestor no acepta ese usuario o esa contraseña. No se ha guardado nada.",
  rejected_no_reason:
    "MyInvestor ha rechazado el acceso sin decir por qué. Suele pasar tras varios intentos seguidos: vuelve a probar mañana.",
};

export const CODE_REJECTED =
  "Ese código no es el que ha mandado MyInvestor. Revisa el SMS y vuelve a escribirlo.";

export const PENDING_EXPIRED =
  "El código ha caducado: pasaron más de 5 minutos. Vuelve a escribir la contraseña y MyInvestor te mandará otro.";

export function isExpired(pending: Pending, now: number): boolean {
  return now - pending.since > PENDING_TTL_MIN;
}

/** El paso 1: usuario y contraseña. `save` es la casilla (solo A la tiene aquí). */
export function submitCredentials(
  variant: VariantKey,
  scenario: Scenario,
  save: boolean,
  now: number,
): Flow {
  if (scenario.login !== "ok")
    return { error: LOGIN_ERRORS[scenario.login], step: "credentials" };
  // Lo que el paso pendiente tiene que guardar para poder terminar sin volver a
  // pedir la contraseña: en A, solo si se marcó la casilla; en B, siempre, porque
  // la decisión llega después; en C, nunca.
  const pending: Pending = {
    holdsPassword: variant === "A" ? save : variant === "B",
    save,
    since: now,
  };
  if (scenario.device === "sms") return { error: null, pending, step: "sms" };
  if (variant === "B") return { error: null, pending, step: "choose" };
  return {
    justConnected: true,
    savedAt: variant === "A" && save ? now : null,
    step: "connected",
  };
}

/** El paso 2: el código del SMS. */
export function submitCode(
  variant: VariantKey,
  scenario: Scenario,
  pending: Pending,
  now: number,
): Flow {
  if (isExpired(pending, now)) return { error: PENDING_EXPIRED, step: "credentials" };
  if (scenario.code === "code_rejected")
    return { error: CODE_REJECTED, pending, step: "sms" };
  if (variant === "B") return { error: null, pending, step: "choose" };
  return {
    justConnected: true,
    savedAt: variant === "A" && pending.save ? now : null,
    step: "connected",
  };
}

/** Solo B: el último paso. */
export function submitChoice(pending: Pending, save: boolean, now: number): Flow {
  if (isExpired(pending, now)) return { error: PENDING_EXPIRED, step: "credentials" };
  return { justConnected: true, savedAt: save ? now : null, step: "connected" };
}

// ── Lo que quedaría en la BD ───────────────────────────────────────────────

export interface StoredState {
  pendingRow: string;
  credentials: string;
  acceptance: string;
}

export function storedStateOf(
  flow: Flow,
  now: number,
  clockLabel: (min: number) => string,
): StoredState {
  if (flow.step === "credentials") {
    return { acceptance: "—", credentials: "— (no hay conexión)", pendingRow: "—" };
  }
  if (flow.step === "sms" || flow.step === "choose") {
    const left = PENDING_TTL_MIN - (now - flow.pending.since);
    const fields = flow.step === "sms" ? ["request_id"] : ["device_id"];
    if (flow.pending.holdsPassword) fields.push("usuario", "contraseña");
    return {
      acceptance: "—",
      credentials: "— (la conexión está a medias)",
      pendingRow: `sellado {${fields.join(", ")}} · caduca a las ${clockLabel(
        flow.pending.since + PENDING_TTL_MIN,
      )} (${left > 0 ? `quedan ${left} min` : "CADUCADO"})`,
    };
  }
  return {
    acceptance:
      flow.savedAt === null ? "—" : `aceptada por ti a las ${clockLabel(flow.savedAt)}`,
    credentials:
      flow.savedAt === null
        ? "sellado {device_id}"
        : "sellado {device_id, usuario, contraseña}",
    pendingRow: "— (borrado al terminar)",
  };
}
