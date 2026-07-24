/**
 * WorkspaceScopeBar (#1190) — the scope selector, lifted out of the per-page
 * `Shell` into the shared `(workspace)` layout. It reads workspace data, so the
 * layout renders it inside its own `<Suspense>`: the chrome frame (masthead,
 * nav, footer structure) stays synchronous and session-independent, and only
 * this bar suspends on the store read. Hidden entirely for single-member
 * workspaces. The scope switch is a native POST to /scope that sets a cookie
 * then redirects to `returnTo` (built client-side from the live URL).
 */

import { resolvePageShell } from "@web/page-shell";

import { PendingSubmit } from "./pending-submit";
import ScopeReturnInput from "./scope-return-input";

export default async function WorkspaceScopeBar() {
  const { scopes, selectedScope } = await resolvePageShell();

  if (scopes.length <= 1) {
    return null;
  }

  return (
    <div className="tabsBar">
      <nav aria-label="Selector de ámbito" className="scopeTabs segmented">
        {scopes.map((scope) => (
          <form action="/scope" key={scope.id} method="post">
            <ScopeReturnInput />
            <input name="scopeId" type="hidden" value={scope.id} />
            <PendingSubmit
              className={`scopeTabBtn${scope.id === selectedScope?.id ? " active" : ""}`}
            >
              {scope.label}
            </PendingSubmit>
          </form>
        ))}
      </nav>
    </div>
  );
}
