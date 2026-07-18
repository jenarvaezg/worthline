/**
 * Server actions for the /patrimonio section.
 * Copied and adapted from app/page.tsx server actions — uses intake v2 strict
 * parsers, anchors to row ids, and redirects back to /patrimonio.
 *
 * Split by concern (#1114) into holdings/valuation/debt action modules and a
 * shared non-async helper module (`action-helpers.ts`). This barrel preserves
 * every existing `from "./actions"` / `@web/patrimonio/actions` import.
 */

export * from "./balance-anchor-actions";
export * from "./debt-actions";
export * from "./holdings-actions";
export * from "./valuation-actions";
