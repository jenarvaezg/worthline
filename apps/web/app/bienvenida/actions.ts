"use server";

import { markOnboardedBestEffort } from "@web/activation-marks";
import { redirect } from "next/navigation";

/**
 * «Lo haré luego» (PRD #1167 S1, #1168): the explicit skip out of onboarding.
 * Completing by jumping — stamp the set-once `onboarded_at` mark (#1131) so the
 * post-registration gate never forces this workspace back into onboarding, then
 * drop onto the dashboard. The re-runnable AI wizard stays available from the
 * ordinary assistant; skipping does not disable it.
 *
 * Best-effort like the `/empezar` marks: on the local/no-control-plane build the
 * stamp is a no-op and the user still lands on `/app`.
 */
export async function skipOnboardingAction(): Promise<never> {
  await markOnboardedBestEffort();
  redirect("/app");
}
