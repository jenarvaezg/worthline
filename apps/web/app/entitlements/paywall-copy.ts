/**
 * The honest paywall copy (PRD #1160 S2, #1162). One place for every premium
 * reminder so the tone stays identical across the assistant and the settings
 * surfaces: a permanent, non-blocking reminder that names what is premium AND
 * reaffirms that manual tracking and every read stay free — never a wall in
 * front of the user's own data (#1127).
 */

/** Where the reminder's call-to-action points. S5 (#1165) wires the real checkout here. */
export const PREMIUM_CTA = { href: "/ajustes", label: "Gestionar premium" } as const;

/** A free workspace tried to upload a document / attachment to the assistant. */
export const PAYWALL_ATTACHMENT_MESSAGE =
  "La lectura de documentos y los adjuntos son premium. Tu seguimiento manual y " +
  "todas las lentes siguen siendo gratis; activa premium para que la IA lea tus " +
  "extractos y documentos por ti.";

/** A free workspace ran out of its monthly courtesy assistant turns. */
export const PAYWALL_COURTESY_MESSAGE =
  "Has agotado los mensajes de cortesía del asistente de este mes. Tu patrimonio y " +
  "todas las lentes siguen a mano gratis; con premium el asistente vuelve sin " +
  "límite razonable.";

/** A free workspace tried to import a broker statement (assistant tool or manual surface). */
export const PAYWALL_STATEMENT_MESSAGE =
  "Importar extractos de broker es premium. Puedes seguir añadiendo y editando " +
  "posiciones a mano gratis; premium deja que la máquina lea los extractos por ti.";

/** A free workspace tried to reconcile a portfolio from a document. */
export const PAYWALL_RECONCILE_MESSAGE =
  "Reconciliar tu cartera desde un documento es premium. El seguimiento manual sigue " +
  "gratis; premium deja que la IA concilie posiciones y movimientos desde tus documentos.";

/** A free workspace tried to connect a data source (Binance, Numista, …). */
export const PAYWALL_CONNECT_SOURCE_MESSAGE =
  "Conectar fuentes de datos es premium. Tus datos manuales siguen siendo gratis; " +
  "premium mantiene tus fuentes sincronizando solas.";

/**
 * A paid workspace (trial/premium) spent its generous daily AI token budget
 * (PRD #1160 S3, #1163). Honest and never a wall in front of the user's data:
 * the assistant pauses for the day, everything else stays a tap away.
 */
export const PAYWALL_TOKEN_BUDGET_MESSAGE =
  "El asistente ha alcanzado su presupuesto de IA de hoy para tu cuenta. Vuelve " +
  "mañana; tu patrimonio y todas las lentes siguen a mano ahora mismo.";

/**
 * The shared daily AI fuse blew — the whole deployment's assistant is paused for
 * the day (#1163). Honest capacity limit, not a per-user paywall: reads and
 * manual tracking are untouched.
 */
export const PAYWALL_GLOBAL_FUSE_MESSAGE =
  "El asistente comparte un presupuesto de IA diario que hoy se ha agotado. " +
  "Vuelve más tarde; tus datos y todas las lentes siguen disponibles.";

/** A free workspace has connected sources that are now paused (premium lapsed). */
export const PAYWALL_SOURCES_PAUSED_MESSAGE =
  "Tus fuentes conectadas están en pausa: dejaron de sincronizar al terminar premium. " +
  "Todo lo que ya se importó se queda; reactiva premium para volver a sincronizar.";

/** The typed envelope a gated assistant tool returns so the model relays the reason honestly. */
export function premiumRequired(message: string): {
  error: "premium_required";
  message: string;
} {
  return { error: "premium_required", message };
}
