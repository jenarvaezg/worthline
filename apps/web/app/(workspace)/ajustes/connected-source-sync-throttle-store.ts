import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import type { UsageLimits } from "@worthline/db";

export async function countConnectedSourceSync(
  rateKey: string,
  windowKey: string,
): Promise<number | null> {
  return withOptionalControlPlaneStore<
    number,
    Pick<UsageLimits, "recordConnectedSourceSync">
  >((controlPlane) => controlPlane.recordConnectedSourceSync(rateKey, windowKey));
}
