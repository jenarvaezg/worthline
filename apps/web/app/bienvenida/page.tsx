import AssistantLayer from "@web/asistente/assistant-layer";
import { ONBOARDING_PATH } from "@web/asistente/screen-context";
import { readOnboardingEntryRedirect } from "@web/onboarding-redirect";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";
import { redirect } from "next/navigation";

import { skipOnboardingAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /bienvenida — the full-screen onboarding surface (PRD #1167 S1, #1168): the
 * assistant in a dedicated «estreno» presentation where a freshly-provisioned
 * workspace lands (redirect gate in `/app`). It IS the assistant, so it reuses
 * the whole conversation engine via the layer's `onboarding` variant — dominant
 * drop-zone, welcome first turn, and two discreet escapes.
 *
 * Server gate:
 *  - unauthenticated (auth enabled, not signed in) → the sign-in page, returning
 *    here afterwards.
 *  - an authenticated workspace with no record yet → `/empezar`, to declare who
 *    it is (solo/hogar) before onboarding can populate it.
 *  - an authenticated workspace that has already onboarded — or an impersonating
 *    admin — has nothing to do here (the reader returns null in both cases) → the
 *    dashboard. `local`/`demo` may view the surface directly (building/showcase).
 */
export default async function BienvenidaPage() {
  const target = await readStoreTarget();

  if (target.kind === "unauthenticated") {
    redirect(`/login?returnTo=${encodeURIComponent(ONBOARDING_PATH)}`);
  }

  if (target.kind === "authenticated") {
    const workspace = await withStore((store) => store.workspace.readWorkspace());
    if (!workspace) {
      redirect("/empezar");
    }
    if (!(await readOnboardingEntryRedirect(target))) {
      redirect("/app");
    }
  }

  const mutationsDisabled =
    target.kind === "demo" ||
    (target.kind === "authenticated" && target.impersonatedEmail !== undefined);

  return (
    <AssistantLayer
      mutationsDisabled={mutationsDisabled}
      onboardingSkipAction={skipOnboardingAction}
      variant="onboarding"
    />
  );
}
