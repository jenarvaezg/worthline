import type { AgentViewReadStore } from "@worthline/db";

import { resolveInternalScopeId } from "./scope-resolution";

/**
 * A scope-bound agent-view read (PRD #998 S2, decision #892). The principal-bound
 * read store ({@link AgentViewReadStore}, opened through the authorization port)
 * plus the ONE scope the read is narrowed to, travelling together as a single
 * object.
 *
 * Before S2 the scope was a loose `string` re-threaded as a positional argument
 * through every scope builder, and each builder re-derived the internal id with
 * its own `resolveInternalScopeId(store, publicScopeId)` call — a shape where a
 * builder could be handed the wrong string, or forget the narrowing entirely.
 * Now the scope is a PROPERTY of the read object and its internal-id resolution
 * lives on the object ({@link ScopedAgentView.internalScopeId}), so every builder
 * shares the one resolution and cannot be constructed without naming a scope.
 */
export interface ScopedAgentView {
  /** The principal-bound read store this scoped read draws from. */
  readonly store: AgentViewReadStore;
  /** The public scope id (`wl_scp_…`) the read is bound to. */
  readonly scopeId: string;
  /**
   * The bound scope's internal id, resolved through the public-ID registry — a
   * `404` when the scope does not exist (never a silent cross-scope read). This
   * is the single resolution every scoped builder shares.
   */
  internalScopeId(): Promise<string>;
}

/**
 * Bind a scope to a read store. The internal-id resolution is deferred to the
 * first `internalScopeId()` call — builders that validate other preconditions
 * first (e.g. workspace existence) keep resolving in their existing order, so
 * binding changes nothing about which error surfaces when.
 */
export function bindScope(store: AgentViewReadStore, scopeId: string): ScopedAgentView {
  return {
    store,
    scopeId,
    internalScopeId: () => resolveInternalScopeId(store, scopeId),
  };
}
