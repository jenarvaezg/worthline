/**
 * The pageShell seam (#1118, arch review 2026-07-17): the ONE preamble every
 * workspace RSC page runs before its own reads. Ten pages used to repeat the
 * same ~30 lines — store target → healthcheck → cookies → open store →
 * workspace (onboarding redirect) → scope options → selected scope → privacy —
 * and did not even open the store the same way (`withStore` vs
 * `getRequestStore`). This module owns that choreography behind a single call,
 * and fixes the canonical way a page opens its store: {@link getRequestStore}
 * — one libSQL connection per RSC request, closed by `after()` (#1025, #1109).
 *
 * Scope resolution is uniform: `?scope=` in the URL wins over the `wl_scope`
 * cookie, then the first scope option is the default. (Before this seam only
 * the dashboard and /patrimonio honored the URL param; no internal link carries
 * `?scope=` to the other pages, so unifying is invisible in practice.)
 *
 * Pages keep what genuinely varies: form-feedback parsing, `currentUrl`
 * building, demo detection, and every page-specific read (done directly on the
 * returned `store`).
 */

import {
  PRIVACY_COOKIE_NAME,
  parsePrivacyCookie,
  parseScopeCookie,
  parseScopeParam,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { type ReachableStoreTarget, requireStoreTarget } from "@web/read-store-target";
import { bootstrapHealthcheck, getRequestStore, type WorthlineStore } from "@web/store";
import type { LocalPersistenceStatus, Workspace } from "@worthline/domain";
import { listScopeOptions, type ScopeOption } from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

export interface PageShellInput {
  /**
   * The page's already-resolved search params — only `scope` is read here (the
   * URL half of scope resolution). Everything else stays the page's business.
   */
  searchParams?: Record<string, string | string[] | undefined> | undefined;
}

export interface PageShell {
  /** The request's resolved principal (redirected to /login when absent). */
  target: ReachableStoreTarget;
  /** Persistence status for the shell footer, pinned to `target`. */
  persistence: LocalPersistenceStatus;
  /** The request-scoped store — the canonical opener for pages (#1025). */
  store: WorthlineStore;
  /** The workspace; a store without one redirects to /empezar instead. */
  workspace: Workspace;
  scopes: ScopeOption[];
  /** The requested scope when it exists, else the first option. */
  selectedScope: ScopeOption | undefined;
  /**
   * The raw requested scope id (`?scope=` ?? cookie), before falling back to
   * the first option — the dashboard threads it into its streamed body.
   */
  requestedScopeId: string | undefined;
  privacyMode: boolean;
}

/**
 * The session-independent half of the preamble: target → healthcheck → store →
 * workspace (onboarding redirect) → scope options. Memoized per request with
 * React `cache()` so the shared `(workspace)` layout (chrome, scope bar, footer)
 * and the page underneath resolve it exactly once between them (#1190) — no
 * duplicated reads even though both call in. Scope selection and privacy are
 * request-cheap and stay in {@link resolvePageShell}, which layers them on top.
 */
export const resolveWorkspaceContext = cache(
  async (): Promise<
    Pick<PageShell, "target" | "persistence" | "store" | "workspace" | "scopes">
  > => {
    const target = await requireStoreTarget();
    const persistence = await bootstrapHealthcheck(target);

    const store = await getRequestStore();
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) {
      redirect("/empezar");
    }

    return {
      persistence,
      scopes: listScopeOptions(workspace),
      store,
      target,
      workspace,
    };
  },
);

/** Run the shared page preamble. See the module doc for what it owns. */
export async function resolvePageShell(input: PageShellInput = {}): Promise<PageShell> {
  const { persistence, scopes, store, target, workspace } =
    await resolveWorkspaceContext();

  const jar = await cookies();
  const queryScopeId = parseScopeParam(input.searchParams?.scope);
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
  const requestedScopeId = queryScopeId ?? cookieScopeId;
  const privacyMode = parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);

  const selectedScope =
    scopes.find((scope) => scope.id === requestedScopeId) ?? scopes[0];

  return {
    persistence,
    privacyMode,
    requestedScopeId,
    scopes,
    selectedScope,
    store,
    target,
    workspace,
  };
}
