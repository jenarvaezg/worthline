/**
 * Re-scoping the unified add form to the canonical names the parsers expect
 * (#1611, extracted from `createHoldingAction`).
 *
 * Every instrument's pane is in the DOM at once — the disclosure is pure CSS
 * (ADR 0009) — so every pane POSTS, and each field is suffixed with its own
 * instrument (`name_fund`, `name_mortgage`…) to keep them from colliding. The
 * ownership footer is the exception: it is shared, so it posts unsuffixed.
 *
 * These helpers are all the families share of that mechanics. Each family builds
 * its OWN scoped form out of them, reading only the fields its pane posts — which
 * is what keeps adding a field to one pane from touching the others.
 */

import type { Workspace } from "@worthline/domain";
import type { AltaContext, AltaResult } from "./alta-contract";

/** The field every alta pane posts, whatever the instrument. */
export const SHARED_REFILL_FIELDS: readonly string[] = ["name"];

/**
 * The workspace, or the refusal every family answers with without it — the
 * members are what an ownership split is validated against, so no command can
 * parse anything before this read.
 *
 * Each family still makes the read at its own point in the sequence, because
 * that point is part of the behavior: an unreadable capture must be reported
 * before a workspace that cannot be missing in practice.
 */
export async function requireWorkspace(
  ctx: AltaContext,
): Promise<{ ok: true; workspace: Workspace } | Extract<AltaResult, { ok: false }>> {
  const workspace = await ctx.store.workspace.readWorkspace();

  return workspace
    ? { ok: true, workspace }
    : { ok: false, message: "Workspace no inicializado." };
}

/** Copy a suffixed field onto a canonical name, when present. */
export function carry(
  from: FormData,
  to: FormData,
  sourceKey: string,
  canonicalKey: string,
): void {
  const value = from.get(sourceKey);
  if (value !== null) {
    to.set(canonicalKey, String(value));
  }
}

/** Copy the shared ownership fields (canonical, not suffixed) onto the scoped form. */
export function carryOwnership(from: FormData, to: FormData): void {
  for (const [key, value] of from.entries()) {
    if (
      key === "ownershipPreset" ||
      key === "scopeMemberId" ||
      key.startsWith("owner_")
    ) {
      to.set(key, String(value));
    }
  }
}
