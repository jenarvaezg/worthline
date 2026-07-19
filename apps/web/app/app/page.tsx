import DashboardContent from "@web/dashboard-content";
import DashboardSkeleton from "@web/dashboard-skeleton";
import { buildCurrentUrl } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { perfEnd, perfStart } from "@web/perf-log";
import Shell from "@web/shell";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const currentUrl = buildCurrentUrl(resolvedSearchParams);

  // The shell preamble loads only the lightweight data needed to render the
  // frame immediately; the heavy dashboard body streams in via Suspense below.
  const perfStartedAt = perfStart();
  const { persistence, privacyMode, requestedScopeId, scopes, selectedScope } =
    await resolvePageShell({ searchParams: resolvedSearchParams });
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
          scopeId={requestedScopeId}
        />
      </Suspense>
    </Shell>
  );
}
