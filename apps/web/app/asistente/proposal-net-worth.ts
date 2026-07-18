/**
 * Shared "patrimonio neto antes" read for the impact-header proposal cards
 * (#1105 alta, #1106 baja/restauración; superficie B, #1088). Both builders lead
 * with the household net worth before the change, read the same honest way — the
 * default scope's `get_financial_context` — and degrade the SAME way: a failed
 * read returns `null` so the card shows "impacto no disponible" rather than
 * fabricate a total it never read (ADR 0048). One home so the two never drift.
 */

import { createAgentViewCatalog } from "@web/agent-view/catalog";
import { isAgentViewErrorEnvelope, runCatalogRead } from "@web/agent-view/read-backend";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import type { AgentViewReadStore } from "@worthline/db";

/**
 * The default scope's net worth before the change, in minor units, or `null`
 * when there is no scope or the canonical read errors/degrades (ADR 0048).
 */
export async function readScopeNetWorthBeforeMinor(
  agentView: AgentViewReadStore,
  today: string,
): Promise<number | null> {
  const scopes = await listAgentViewScopes(agentView);
  const scopeId = (scopes.find((scope) => scope.isDefault) ?? scopes[0])?.id;
  if (!scopeId) return null;
  const context = await runCatalogRead(
    createAgentViewCatalog().get_financial_context,
    { scopeId, holdingLimit: 1 },
    agentView,
    { asOf: today },
  );
  return isAgentViewErrorEnvelope(context)
    ? null
    : context.data.summary.netWorth.amountMinor;
}
