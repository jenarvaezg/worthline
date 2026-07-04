import type { ScreenContext, ScreenSection } from "./screen-context";

/**
 * Screen-aware suggested prompts (#632, S4). App-OWNED definitions keyed by the
 * structured screen section — never free model invention — so starter prompts
 * stay grounded in what each surface is about. Selecting one seeds a read-only
 * conversation (pairs with `runSuggestedAnalysis` from S3, #631). Pure lookup,
 * unit-tested in the node env; the client island resolves the section on every
 * navigation via `deriveScreenContext`.
 */

export interface SuggestedPrompt {
  /** Stable id — the screen→prompt contract tests assert on, not the copy. */
  id: string;
  /** Short chip label. */
  label: string;
  /** The full prompt seeded into the conversation when chosen. */
  prompt: string;
}

/** Sensible starter set for surfaces without their own catalog. */
const DEFAULT_PROMPTS: readonly SuggestedPrompt[] = [
  {
    id: "default-position",
    label: "¿Cómo va mi patrimonio?",
    prompt:
      "Dame una lectura de mi posición patrimonial: qué está holgado y qué está justo.",
  },
  {
    id: "default-liquidity",
    label: "¿Tengo colchón de liquidez?",
    prompt: "¿Mi colchón de liquidez es suficiente frente a mis gastos y deudas?",
  },
];

/** Per-section catalogs. Sections not listed here use DEFAULT_PROMPTS. */
const BY_SECTION: Partial<Record<ScreenSection, readonly SuggestedPrompt[]>> = {
  patrimonio: [
    {
      id: "patrimonio-imbalance",
      label: "¿Está desequilibrada mi cartera?",
      prompt:
        "¿Está desequilibrada la composición de mi patrimonio? Señala qué pesa de más o de menos.",
    },
    {
      id: "patrimonio-stale",
      label: "¿Qué datos están obsoletos?",
      prompt: "¿Qué posiciones o precios están obsoletos y convendría actualizar?",
    },
    {
      id: "patrimonio-concentration",
      label: "¿Estoy demasiado concentrado?",
      prompt: "¿Tengo demasiada concentración en algún activo, emisor o clase? ¿Cuánto?",
    },
  ],
  historico: [
    {
      id: "historico-changes",
      label: "¿Qué ha cambiado?",
      prompt: "¿Qué ha cambiado más en mi patrimonio en el rango que estoy viendo?",
    },
    {
      id: "historico-outliers",
      label: "¿Hay movimientos raros?",
      prompt: "¿Hay saltos o movimientos atípicos en mi histórico que deba revisar?",
    },
  ],
  objetivos: [
    {
      id: "objetivos-contributions",
      label: "¿Qué aportación me acerca a FIRE?",
      prompt:
        "¿Cómo influye mi aportación mensual en alcanzar mi objetivo FIRE? ¿Qué palanca mueve más?",
    },
    {
      id: "objetivos-eligible",
      label: "¿Qué activos cuentan para FIRE?",
      prompt: "¿Qué activos son elegibles para mi objetivo FIRE y cuáles quedan fuera?",
    },
    {
      id: "objetivos-assumptions",
      label: "¿En qué supuestos me apoyo?",
      prompt:
        "¿Sobre qué supuestos (rentabilidad, inflación, retirada) se construye mi proyección FIRE?",
    },
  ],
};

/**
 * The starter prompts for the current screen. Falls back to the default set for
 * unknown sections and when there is no screen context yet.
 */
export function suggestedPrompts(context: ScreenContext | null): SuggestedPrompt[] {
  const catalog = context ? BY_SECTION[context.section] : undefined;
  return [...(catalog ?? DEFAULT_PROMPTS)];
}
