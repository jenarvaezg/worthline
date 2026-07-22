/**
 * The assistant's `data-paywall` stream part (PRD #1160 S2, #1162): the honest
 * paywall the chat route streams instead of an error when a free workspace hits
 * a premium ingestion surface (attachment upload) or runs out of its monthly
 * courtesy turns. Rendered by the assistant panel as a {@link PremiumNotice},
 * so the reminder reads as a normal assistant turn — never a scary failure.
 */

export interface PaywallPartData {
  /** One of the `PAYWALL_*` copy constants (already localized). */
  message: string;
}

/** Trust boundary: validate the streamed part before rendering it. */
export function parsePaywallPartData(value: unknown): PaywallPartData | null {
  if (value === null || typeof value !== "object") return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? { message } : null;
}
