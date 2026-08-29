/**
 * The `stored` ficha: a holding whose value is what somebody typed — a current
 * account, a term deposit, a vehicle, a metal bar.
 *
 * It has no sub-detail to load: «Lo básico» already edits its value, and the only
 * advanced surface it carries is the shared Cobros panel (the interest a deposit
 * pays is an attribution record like any other, PRD #652 S1). The family exists
 * so that "this holding needs nothing" is a stated answer with a name, rather
 * than the gap left by every other branch failing to match.
 */

import type { AssetFamilyContext, HoldingSurface } from "./family-contract";
import { holdingSurface } from "./family-contract";

export function loadStoredSurface(ctx: AssetFamilyContext): HoldingSurface {
  return holdingSurface("stored", { body: ctx.payoutsPanel });
}
