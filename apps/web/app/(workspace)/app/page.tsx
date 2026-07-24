import DashboardContent from "@web/dashboard-content";
import DashboardSkeleton from "@web/dashboard-skeleton";
import { buildCurrentUrl } from "@web/intake";
import { readOnboardingEntryRedirect } from "@web/onboarding-redirect";
import { resolvePageShell } from "@web/page-shell";
import { perfEnd, perfStart } from "@web/perf-log";
import { readStoreTarget } from "@web/read-store-target";
import { redirect } from "next/navigation";
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
  // It also redirects to /empezar when the workspace has no record yet, so a
  // freshly-provisioned hosted workspace declares who it is (solo/hogar) first.
  const perfStartedAt = perfStart();
  const { privacyMode, requestedScopeId } = await resolvePageShell({
    searchParams: resolvedSearchParams,
  });

  // Post-registration gate (#1168): once the workspace exists but has not yet
  // onboarded, land on the full-screen onboarding instead of the empty
  // dashboard. Runs AFTER the shell so it never fires on an uninitialized
  // workspace (that goes to /empezar first). Fail-open (local/demo/errors → no
  // redirect); skipped entirely without a control plane, so local never pays.
  const onboardingRedirect = await readOnboardingEntryRedirect(await readStoreTarget());
  if (onboardingRedirect) {
    redirect(onboardingRedirect);
  }
  perfEnd("home-shell", perfStartedAt);

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent
        privacyMode={privacyMode}
        returnTo={currentUrl}
        searchParams={resolvedSearchParams}
        scopeId={requestedScopeId}
      />
    </Suspense>
  );
}
