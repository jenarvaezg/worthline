import { cookies } from "next/headers";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { collectWarnings, listScopeOptions } from "@worthline/domain";

import {
  buildCurrentUrl,
  parseScopeParam,
  parseScopeCookie,
  SCOPE_COOKIE_NAME,
} from "./intake";
import Shell from "./shell";
import { bootstrapHealthcheck, openStore } from "@web/store";
import { requireStoreTarget } from "@web/read-store-target";
import DashboardContent from "./dashboard-content";
import DashboardSkeleton from "./dashboard-skeleton";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const target = await requireStoreTarget();
  const persistence = await bootstrapHealthcheck(target);
  const currentUrl = buildCurrentUrl(resolvedSearchParams);

  const jar = await cookies();
  const queryScopeId = parseScopeParam(resolvedSearchParams?.scope);
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
  const scopeId = queryScopeId ?? cookieScopeId;

  // Load only the lightweight data needed to render the shell immediately.
  // The heavy dashboard body streams in via Suspense below.
  const store = await openStore(target);
  let shellData;
  try {
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) {
      redirect("/empezar");
    }
    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
    const [assets, overrides] = await Promise.all([
      store.assets.readAssets(),
      store.readWarningOverrides(),
    ]);
    const warnings = collectWarnings(assets, overrides);
    shellData = {
      persistence: {
        displayPath: persistence.displayPath,
        checkedAt: persistence.checkedAt,
      },
      scopes,
      selectedScopeId: selectedScope?.id,
      warnings: warnings.map((w) => ({
        code: w.code,
        entityId: w.entityId,
        message: w.message,
      })),
    };
  } finally {
    store.close();
  }

  return (
    <Shell
      activeSection="resumen"
      currentPageUrl={currentUrl}
      persistence={shellData.persistence}
      scopes={shellData.scopes}
      selectedScopeId={shellData.selectedScopeId}
      warnings={shellData.warnings}
    >
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent searchParams={resolvedSearchParams} scopeId={scopeId} />
      </Suspense>
    </Shell>
  );
}
