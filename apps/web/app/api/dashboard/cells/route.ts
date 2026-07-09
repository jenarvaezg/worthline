import { readMatrixCells } from "@web/dashboard-cells";
import { parseCellsParam } from "@web/dashboard-matrix";
import { parseScopeCookie, SCOPE_COOKIE_NAME } from "@web/intake";
import { readStoreTarget } from "@web/read-store-target";
import { bootstrapHealthcheck, withStore } from "@web/store";
import { listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * `GET /api/dashboard/cells?cells=mode:range,…` — the composition matrix's read
 * API (S4 #520, ADR 0038). Returns the requested cells (chart series /
 * drilldowns) for the SESSION's own workspace and the request's active scope, so
 * the client can prefetch the next cross and keep every toggle instant.
 *
 * Tenant isolation is not a parameter: the workspace is resolved by
 * `readStoreTarget`/`withStore` from the Auth.js session (or demo persona, or
 * local no-auth) — never from the request. The client supplies only matrix
 * COORDINATES; the scope is read from the `wl_scope` cookie server-side. The
 * read is side-effect free (no price refresh, no capture) and never cached.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = parseCellsParam(new URL(request.url).searchParams.get("cells"));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  const target = await readStoreTarget();
  if (target.kind === "unauthenticated") {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: NO_STORE },
    );
  }

  const persistence = await bootstrapHealthcheck(target);
  const today = persistence.checkedAt.slice(0, 10);
  const cookieScopeId = parseScopeCookie((await cookies()).get(SCOPE_COOKIE_NAME)?.value);

  const cells = await withStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) {
      return {};
    }
    // Resolve the active scope exactly as the page does: the cookie's scope, or
    // the first scope as the default — both are the user's own (the workspace is
    // already tenant-resolved), so the scope is never a trust boundary.
    const scopes = listScopeOptions(workspace);
    const selected = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];
    return readMatrixCells(store, selected?.id, parsed.coords, today);
  }, target);

  return NextResponse.json({ cells }, { headers: NO_STORE });
}
