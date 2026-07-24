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

/**
 * Onboarding completed by DOING (PRD #1167 S2, #1169): the assistant confirmed
 * the workspace's first proposal from the onboarding surface, so stamp the
 * set-once `onboarded_at` mark (#1131) — the post-registration gate must never
 * force this now-live workspace back into onboarding.
 *
 * Fired mid-conversation from the client (once, guarded there), so unlike the
 * explicit skip it does NOT navigate: the user stays in the flow, free to keep
 * composing their patrimonio or leave via the always-visible escapes. Best-effort
 * like every other activation mark — a no-op on the local/no-control-plane build.
 * Confirming a holding-creating proposal already stamps `first_holding_at` in its
 * own persist seam; this is the explicit onboarding-complete signal on top.
 */
export async function markOnboardingCompleteAction(): Promise<void> {
  await markOnboardedBestEffort();
}
