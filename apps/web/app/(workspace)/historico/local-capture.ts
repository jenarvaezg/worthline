/**
 * Who may run a manual daily capture from /historico, and why not.
 *
 * The once-twice-daily capture (ADR 0037) reaches a hosted workspace through
 * Vercel Cron → `/api/cron/snapshot` → the control plane → `runDailyCapture`.
 * That whole path is fleet infrastructure: it enumerates workspaces from the
 * control plane, so it needs `WORTHLINE_CONTROL_PLANE_DB_URL` and it simply has
 * nothing to enumerate in local no-auth mode (ADR 0030). Nothing else calls
 * `captureDailySnapshotForWorkspace` — since #895 the render stopped writing a
 * snapshot — so a local workspace collects ZERO captures and /historico stays
 * permanently empty. This is the seam that gives a local developer the one thing
 * the cron cannot: a button.
 *
 * The rule is deliberately LOCAL-ONLY, not "also in demo": hosted workspaces have
 * a real writer, and a second on-demand path would silently fight the cron's
 * cadence (ADR 0005 latest-wins), stamping whatever the price cache held at the
 * moment of the click. The demo has no store to write at all, and it is read-only
 * besides — `blockedWriteMessage` (`app/demo/write-guard.ts`) refuses it in every
 * mutating action already.
 *
 * Pure over an already-resolved {@link StoreTarget}, and shaped exactly like
 * `blockedWriteMessage`: the reason as the Spanish message the blocked user
 * should see, or null when the request may proceed. The page asks it to decide
 * whether to RENDER the button; the action asks it again to decide whether to RUN
 * it — the render gate is a convenience, this is the enforcement, so a crafted
 * POST against a hosted deploy is refused with the same words the page would have
 * shown.
 */

import type { StoreTarget } from "@web/store-resolver";

/** Shown when a request that is not the local no-auth store tries to capture. */
export const LOCAL_CAPTURE_ONLY_MESSAGE =
  "La captura manual solo existe en el modo local, donde no hay captura programada.";

/**
 * Why this request may not run a manual capture, as the message to show — or
 * null when it may. The ONE classifier behind both the button's visibility and
 * the action's guard, so the two can never disagree about who may write.
 */
export function localCaptureRefusal(target: StoreTarget): string | null {
  return target.kind === "local" ? null : LOCAL_CAPTURE_ONLY_MESSAGE;
}

/** Whether the manual-capture control belongs on this request's /historico. */
export function localCaptureAllowed(target: StoreTarget): boolean {
  return localCaptureRefusal(target) === null;
}
