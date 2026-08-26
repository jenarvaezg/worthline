import { DEFAULT_HOLDING_MATCH_LIMIT } from "@web/agent-view/holding-search";
import { isAgentViewErrorEnvelope } from "@web/agent-view/read-backend";
import { resolveInternalHoldingId } from "@web/agent-view/scope-resolution";
import {
  parseQuickActions,
  type QuickAction,
  sourceHref,
} from "@web/asistente/assistant-actions";
import {
  type CatalogReader,
  catalog,
  resolveScopeId,
} from "@web/asistente/chat-tools/reading";
import {
  type ProposedAction,
  SUGGEST_ACTIONS_SCHEMA,
} from "@web/asistente/chat-tools/schemas/reads";
import type { ChatReadStore } from "@web/asistente/chat-tools/stores";
import type { ChatToolTurn } from "@web/asistente/chat-tools/turn";
import { holdingLookupQuery, pickNamedHolding } from "@web/asistente/named-holding";
import { isPublicHoldingId } from "@web/asistente/public-holding-id";
import { type ToolSet, tool } from "ai";

/**
 * Follow-up chips (ADR 0053): read-only actions the model proposes AFTER its
 * answer, resolved by the app to internal destinations. The model names a holding,
 * a section or a figure — never a URL (#1289).
 */

/**
 * What ONE `suggest_actions` call may not pay for twice. Naming a holding costs a
 * whole-scope projection (`find_holdings`), the call may carry eight actions, and a
 * set of chips usually names the SAME holding — so the scope resolves once per call
 * and each distinct name is looked up once.
 */
interface NamedHoldingLookups {
  scopeId?: Promise<string | null>;
  byName: Map<string, Promise<string | null>>;
}

/** Anything WEARING the id prefix is an id, well-formed or not — never a name. */
const HOLDING_ID_PREFIX = /^wl_hld_/i;

/**
 * The public holding id a chip's `holding` field points at, or null when it points
 * at nothing we can navigate to.
 *
 * Two vias, one destination. A PUBLIC id (`wl_hld_…`) resolves by existence check:
 * since #1318 it is also what the product route takes, so a hallucinated id throws
 * and the action is dropped. Anything else is read as the holding's NAME (#1375) —
 * what the model sends over and over — and resolved through the same lookup
 * `find_holdings` exposes, unambiguous or not at all.
 *
 * A malformed id (`wl_hld_mortgage_id_placeholder_need_to_find_it`, #1263) is neither:
 * it is dropped without a lookup rather than searched as if it were a label.
 */
async function resolveActionHolding(
  store: ChatReadStore,
  reference: string,
  read: CatalogReader,
  lookups: NamedHoldingLookups,
): Promise<string | null> {
  if (HOLDING_ID_PREFIX.test(reference)) {
    if (!isPublicHoldingId(reference)) return null;
    try {
      await resolveInternalHoldingId(store.agentView, reference);
      return reference;
    } catch {
      return null;
    }
  }

  const query = holdingLookupQuery(reference);
  if (query === null) return null;

  const cached = lookups.byName.get(query);
  if (cached !== undefined) return cached;
  const resolving = lookupNamedHolding(store, query, read, lookups);
  lookups.byName.set(query, resolving);
  return resolving;
}

async function lookupNamedHolding(
  store: ChatReadStore,
  query: string,
  read: CatalogReader,
  lookups: NamedHoldingLookups,
): Promise<string | null> {
  // A chip is a garnish on an answer that is already written: a lookup that cannot
  // run (empty workspace, unresolvable scope) costs the turn nothing but this chip.
  try {
    lookups.scopeId ??= resolveScopeId(store, undefined);
    const scopeId = await lookups.scopeId;
    if (scopeId === null) return null;
    const found = await read(
      catalog.find_holdings,
      { limit: DEFAULT_HOLDING_MATCH_LIMIT, query, scopeId },
      store.agentView,
    );
    if (isAgentViewErrorEnvelope(found)) return null;
    return pickNamedHolding(query, found.data, {
      truncated: found.meta?.["truncated"] === true,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve one proposed `openInternalSource` reference to an internal href, or
 * null if it points nowhere we can navigate. The app decides every destination
 * (#1289): the model names a holding, a section or a figure, never a URL.
 */
async function resolveActionHref(
  store: ChatReadStore,
  action: ProposedAction,
  read: CatalogReader,
  lookups: NamedHoldingLookups,
): Promise<string | null> {
  if (action.holding !== undefined) {
    const publicId = await resolveActionHolding(store, action.holding, read, lookups);
    return publicId === null ? null : sourceHref({ kind: "holding", publicId });
  }
  if (action.section !== undefined) {
    return sourceHref({ kind: "section", section: action.section });
  }
  if (action.figure !== undefined) {
    return sourceHref({ kind: "figure", figure: action.figure });
  }
  return null;
}

export function actionReadTools(turn: ChatToolTurn): ToolSet {
  const { catalogRead, input } = turn;

  return {
    suggest_actions: tool({
      description:
        "Propón acciones de seguimiento SOLO-LECTURA para el usuario (ADR 0053), tras " +
        "responder. Dos tipos: `openInternalSource` abre una superficie de worthline citada " +
        "— indica `holding` (id `wl_hld_…` que ya has leído, o el NOMBRE de la posición " +
        "si no tienes el id), `section` " +
        "(patrimonio/historico/objetivos) o `figure` (p.ej. net_worth); NO pases URLs. " +
        "`runSuggestedAnalysis` sugiere una pregunta de seguimiento con su `prompt`. La app " +
        "descarta lo que no resuelva a una superficie interna. No modifica nada.",
      inputSchema: SUGGEST_ACTIONS_SCHEMA,
      execute: (args) =>
        input.runWithStore(async (store) => {
          const built: unknown[] = [];
          const lookups: NamedHoldingLookups = { byName: new Map() };
          for (const action of args.actions ?? []) {
            if (action.type === "runSuggestedAnalysis") {
              built.push({
                type: "runSuggestedAnalysis",
                label: action.label,
                prompt: action.prompt,
              });
            } else if (action.type === "openInternalSource") {
              const href = await resolveActionHref(store, action, catalogRead, lookups);
              if (href !== null) {
                built.push({ type: "openInternalSource", label: action.label, href });
              }
            }
          }
          // Final trust boundary: only the typed, bounded, internal-href set renders.
          return { actions: parseQuickActions(built) satisfies QuickAction[] };
        }),
    }),
  };
}
