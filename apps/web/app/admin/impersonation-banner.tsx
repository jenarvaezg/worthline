import { stopImpersonationAction } from "@web/admin/actions";
import { readStoreTarget } from "@web/read-store-target";

import { ImpersonationBand } from "./impersonation-band";

/**
 * The persistent impersonation strip (#697, ADR 0030), rendered on every page
 * while an admin is impersonating a workspace (from the root layout, gated by
 * `isImpersonating()`). A session band like `DemoBanner`, but the caution tone
 * (`data-tone="warning"`, canon §2/#910): impersonation is a state to notice, so
 * the band goes gold rather than the neutral demo tone.
 *
 * This half answers WHETHER there is an impersonation and WHOSE; what the band
 * says depends on the route standing under it, which only the client half can
 * read (#1732 — inside `/admin` the band was claiming to be viewing a workspace
 * that is not the screen it stands on).
 *
 * "Salir" POSTs to `stopImpersonationAction`, which re-verifies `guardAdmin`,
 * clears the cookie, and redirects to /admin.
 */
export default async function ImpersonationBanner() {
  const target = await readStoreTarget();
  if (target.kind !== "authenticated" || target.impersonatedEmail === undefined) {
    return null;
  }

  return (
    <ImpersonationBand
      email={target.impersonatedEmail}
      stopAction={stopImpersonationAction}
    />
  );
}
