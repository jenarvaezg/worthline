import DashboardContent from "@web/dashboard-content";
import DashboardSkeleton from "@web/dashboard-skeleton";
import {
  buildCurrentUrl,
  PRIVACY_COOKIE_NAME,
  parsePrivacyCookie,
  parseScopeCookie,
  parseScopeParam,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import { perfEnd, perfStart } from "@web/perf-log";
import { requireStoreTarget } from "@web/read-store-target";
import Shell from "@web/shell";
import { bootstrapHealthcheck, getRequestStore } from "@web/store";
import { listScopeOptions } from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

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
  const privacyMode = parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);

  // Load only the lightweight data needed to render the shell immediately.
  // The heavy dashboard body streams in via Suspense below.
  const perfStartedAt = perfStart();
  const store = await getRequestStore();
  const workspace = await store.workspace.readWorkspace();
  if (!workspace) {
    redirect("/empezar");
  }
  const scopes = listScopeOptions(workspace);
  const selectedScope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  const shellData = {
    persistence: {
      displayPath: persistence.displayPath,
      checkedAt: persistence.checkedAt,
    },
    scopes,
    selectedScopeId: selectedScope?.id,
  };
  perfEnd("home-shell", perfStartedAt);

  return (
    <Shell
      activeSection="resumen"
      currentPageUrl={currentUrl}
      persistence={shellData.persistence}
      scopes={shellData.scopes}
      selectedScopeId={shellData.selectedScopeId}
    >
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent
          privacyMode={privacyMode}
          returnTo={currentUrl}
          searchParams={resolvedSearchParams}
          scopeId={scopeId}
        />
      </Suspense>
    </Shell>
  );
}
