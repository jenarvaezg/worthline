import { createAgentViewCatalog } from "@web/agent-view/catalog";
import { AgentViewHttpError, errorEnvelope } from "@web/agent-view/contract";
import { runCatalogRead } from "@web/agent-view/read-backend";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import type { AgentViewReadStore } from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";
import type { ChatToolsInput } from "./input";
import type { ChatReadStore } from "./stores";

/**
 * How ONE chat read reaches the agent-view read catalog (#629/#630, ADR 0047).
 *
 * Two chat-specific concerns wrap every read: money is pre-formatted to es-ES
 * strings so the model can't recite céntimos as euros (the #629 smoke bug), and a
 * missing/unknown fact surfaces as an error envelope instead of throwing —
 * visible uncertainty, never a guess (ADR 0048). Calculation logic stays in
 * agent-view; the model never defines its own net-worth formula, only
 * summarizes/compares what these reads return.
 */

/** The agent-view read catalog every chat read goes through. */
export const catalog = createAgentViewCatalog();
/** The empty-workspace answer for scope-defaulting tools (ADR 0048). */
export const EMPTY_WORKSPACE = { error: "empty_workspace" } as const;
/**
 * Recursively replace every agent-view money object (`{amountMinor, currency}`,
 * the ONLY shape carrying `amountMinor` in the contract) with its formatted
 * es-ES string. The model then cites `"12.585 €"`, never `1258500` céntimos.
 */
export function formatChatMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatChatMoney);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (
    typeof record["amountMinor"] === "number" &&
    typeof record["currency"] === "string"
  ) {
    return formatMoneyMinor({
      amountMinor: record["amountMinor"],
      currency: record["currency"],
    });
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, val]) => [key, formatChatMoney(val)]),
  );
}

/**
 * Run one agent-view read for the chat: format its money and turn any
 * `AgentViewHttpError` (unknown id, unsupported figure, bad selector) into the
 * standard error envelope so the assistant states uncertainty instead of the
 * stream dying. A non-agent-view error is a real bug and still throws.
 */
export async function chatRead(
  { runWithStore }: ChatToolsInput,
  run: (store: ChatReadStore) => Promise<unknown>,
): Promise<unknown> {
  try {
    return formatChatMoney(await runWithStore(run));
  } catch (error) {
    if (error instanceof AgentViewHttpError) {
      return errorEnvelope(error);
    }
    throw error;
  }
}

/** Resolve the caller's scope, defaulting to the household scope, or null if empty. */
export async function resolveScopeId(
  store: ChatReadStore,
  scopeId: string | undefined,
): Promise<string | null> {
  if (scopeId !== undefined) return scopeId;
  const scopes = await listAgentViewScopes(store.agentView);
  return (scopes.find((s) => s.isDefault) ?? scopes[0])?.id ?? null;
}

/** How a chat read reaches the agent-view catalog, with this turn's `asOf` bound. */
export type CatalogReader = <Input, Output>(
  tool: Parameters<typeof runCatalogRead<Input, Output>>[0],
  catalogInput: Input,
  agentView: AgentViewReadStore,
) => Promise<Output>;
