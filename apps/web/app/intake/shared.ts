import type { Member, OwnershipShare } from "@worthline/domain";
import { parseDecimal } from "@worthline/domain";

import {
  type OwnershipPreset,
  parseMoneyMinor,
  resolveOwnershipSplit,
  type ShortfallCompletion,
} from "../intake-primitives";

/**
 * Shared parse helpers composed by every per-instrument parser family
 * (asset, investment, debt, fire, workspace). Family modules import these
 * DIRECTLY (never via the `../intake` barrel) so the split introduces no
 * import cycles. Pure and framework-agnostic, like the rest of the seam.
 */

/** Result type for strict parse functions that can fail with a user-facing error. */
export type StrictParseResult<T> =
  | { ok: true; command: T }
  | { ok: false; error: string };

export function parseEntityId(formData: FormData, field = "id"): string | null {
  const id = String(formData.get(field) ?? "").trim();

  return id || null;
}

export function parseMoneyMinorField(formData: FormData, field: string): number | null {
  return parseMoneyMinor(String(formData.get(field) ?? ""));
}

export function parseOwnership(
  formData: FormData,
  members: Member[],
  options: { completeShortfall?: boolean } = {},
): OwnershipShare[] {
  const activeMembers = members.filter((member) => !member.disabledAt);
  const preset = parseOwnershipPreset(formData.get("ownershipPreset"));
  const scopeMemberId = String(formData.get("scopeMemberId") ?? "") || undefined;
  const customBps = Object.fromEntries(
    activeMembers.map((member) => [
      member.id,
      Math.round(parseDecimal(String(formData.get(`owner_${member.id}`) ?? "")) * 100),
    ]),
  );

  // The historical default was to silently complete a partial split to full
  // ownership; preserve that for callers that don't opt out (#241 makes the
  // choice explicit at the primitive's seam while keeping this public default).
  const shortfall: ShortfallCompletion =
    options.completeShortfall === false
      ? "leave-as-entered"
      : "complete-to-full-ownership";

  return resolveOwnershipSplit({
    activeMembers,
    customBps,
    preset,
    scopeMemberId,
    shortfall,
  });
}

function parseOwnershipPreset(value: FormDataEntryValue | null): OwnershipPreset {
  return value === "scope" || value === "even" ? value : "custom";
}

export function createStableId(prefix: string, name: string, seed: number): string {
  const slug =
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || prefix;

  return `${prefix}_${slug}_${seed}`;
}
