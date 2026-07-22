import { readStoreTarget } from "@web/read-store-target";

import { isPremiumIngestionAllowed } from "./effective-plan";
import { readEffectivePlan } from "./read-effective-plan";

/**
 * Server-action premium ingestion gate (PRD #1160 S2, #1162): resolve the
 * caller's effective plan and return the honest paywall `message` when ingestion
 * is NOT allowed (an authenticated free workspace), or null when it is
 * (trial/premium, and the demo/local bypass). The caller turns a non-null result
 * into its own honest failure — a `{ ok: false, error }` for a `formAction`, or a
 * redirect for a bare action. Reads and manual tracking never call this.
 */
export async function ingestionBlockedMessage(message: string): Promise<string | null> {
  const target = await readStoreTarget();
  const plan = await readEffectivePlan(target);
  return isPremiumIngestionAllowed(plan) ? null : message;
}
