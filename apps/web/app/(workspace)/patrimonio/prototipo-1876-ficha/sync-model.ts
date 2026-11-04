/**
 * PROTOTIPO #1884/#1885 — desechable. «Poner al día» en la ficha de un holding
 * enlazado con MyInvestor (S9) y las señales de salud de la conexión (S10).
 *
 * Pregunta: ¿dónde vive «Poner al día» en la ficha y dónde se ven su estado y sus
 * errores?
 *   A · el botón de la cabecera abre el panel lateral: contraseña si hace falta, los
 *       pasos de la pasada y su resultado; los errores, en la banda de avisos;
 *   B · el botón actúa en el sitio, sin panel: con contraseña guardada pone al día ya;
 *       sin ella, el campo aparece junto al botón; el resultado, en el aviso de la ficha;
 *   C · una franja de la conexión sobre las pestañas («MyInvestor · al día hoy 07:12»)
 *       con su botón: es de la conexión entera, no del holding, y ahí van sus señales.
 */

export const S9_VARIANTS = [
  { key: "A", name: "Botón → panel lateral; errores en la banda" },
  { key: "B", name: "Botón en el sitio, sin panel" },
  { key: "C", name: "Franja de la conexión sobre las pestañas" },
] as const;

export type S9VariantKey = (typeof S9_VARIANTS)[number]["key"];

export type Outcome =
  | "ok"
  | "mismatch"
  | "password_rejected"
  | "sms_required"
  | "rejected_no_reason"
  | "network"
  | "locked"
  | "limit"
  | "in_progress";

export const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: "ok", label: "Bien" },
  { key: "mismatch", label: "Participaciones no cuadran" },
  { key: "password_rejected", label: "Contraseña rechazada" },
  { key: "sms_required", label: "Pide SMS" },
  { key: "rejected_no_reason", label: "Rechazo sin motivo" },
  { key: "network", label: "Red / WAF" },
  { key: "locked", label: "3 rechazos hoy" },
  { key: "limit", label: "10 logins hoy" },
  { key: "in_progress", label: "Ya hay una en curso (cron)" },
];

export const STEPS = [
  "Entrando en MyInvestor",
  "Posiciones y saldo",
  "Órdenes desde la última buena",
  "Planes y aportaciones",
  "Comprobando participaciones",
] as const;

export type Tone = "ok" | "warn" | "error";

export interface Result {
  tone: Tone;
  /** La frase del resultado, en el aviso o en la banda. */
  text: string;
  /** El remedio, si lo hay. */
  action?: { label: string; kind: "resync" | "password" | "sms" };
  /** Si para la puesta al día diaria. */
  stopsDaily?: boolean;
  /** Si deja el botón inutilizable hasta una hora. */
  blockedUntil?: string;
}

export const RESULTS: Record<Outcome, Result> = {
  in_progress: {
    text: "Al día: 1 operación nueva. Ya se estaba poniendo al día (la pasada de las 07:10) y has esperado a que terminara.",
    tone: "ok",
  },
  limit: {
    blockedUntil: "mañana",
    text: "Hoy ya se ha entrado 10 veces en MyInvestor, el máximo. Vuelve a intentarlo mañana.",
    tone: "warn",
  },
  locked: {
    blockedUntil: "mañana",
    stopsDaily: true,
    text: "MyInvestor ha rechazado la contraseña tres veces hoy. La conexión queda bloqueada hasta mañana para no bloquearte la cuenta.",
    tone: "error",
  },
  mismatch: {
    action: { kind: "resync", label: "Resincronizar todo" },
    text: "Las participaciones no cuadran: el libro dice 401,77 y MyInvestor 402,10 (+0,33). Las operaciones nuevas están aplicadas; worthline no crea ningún ajuste.",
    tone: "warn",
  },
  network: {
    text: "No hemos podido hablar con MyInvestor tras tres intentos. No ha cambiado nada; vuelve a intentarlo en unos minutos.",
    tone: "error",
  },
  ok: {
    text: "Al día: 2 operaciones nuevas.",
    tone: "ok",
  },
  password_rejected: {
    action: { kind: "password", label: "Escribir la contraseña" },
    stopsDaily: true,
    text: "MyInvestor no acepta la contraseña guardada, así que worthline la ha borrado. La puesta al día diaria está parada.",
    tone: "error",
  },
  rejected_no_reason: {
    blockedUntil: "mañana a las 12:04",
    text: "MyInvestor ha rechazado la entrada sin decir por qué. worthline espera 24 horas antes de volver a intentarlo.",
    tone: "warn",
  },
  sms_required: {
    action: { kind: "sms", label: "Verificar el móvil" },
    stopsDaily: true,
    text: "MyInvestor pide verificar el móvil otra vez. La puesta al día diaria está parada hasta que lo hagas; worthline nunca manda un SMS solo.",
    tone: "error",
  },
};

/** Las señales de S10 que no salen de una pasada concreta. */
export type Signal = "none" | "failing" | "stale";

export const SIGNALS: { key: Signal; label: string }[] = [
  { key: "none", label: "Ninguna" },
  { key: "failing", label: "Falla 3 días seguidos (órdenes)" },
  { key: "stale", label: "Sin contraseña, 45 días sin poner al día" },
];

export const SIGNAL_TEXT: Record<Exclude<Signal, "none">, string> = {
  failing:
    "El conector falla al leer las órdenes desde hace 3 días. Las posiciones sí se leen; las operaciones nuevas pueden faltar.",
  stale:
    "Llevas 45 días sin poner al día MyInvestor. Sin la contraseña guardada, solo se pone al día cuando pulsas.",
};
