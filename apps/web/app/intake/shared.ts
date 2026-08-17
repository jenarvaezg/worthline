import {
  type OwnershipPreset,
  parseMoneyMinor,
  resolveOwnershipSplit,
  type ShortfallCompletion,
} from "@web/intake-primitives";
import type { Member, OwnershipShare } from "@worthline/domain";
import { parseDecimal } from "@worthline/domain";

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

/**
 * A client-supplied idempotency key (#1394), or null when the form carries none.
 *
 * The value is untrusted input that ends up INSIDE a persisted id, so it is
 * squeezed through the `[a-z0-9]` alphabet and capped — a UUID survives as its
 * 32 hex digits, anything else stops being able to shape the id. Absent (the
 * no-JS path) means "no dedupe key": the caller keeps seeding ids off the clock.
 */
export function parseSubmissionId(
  formData: FormData,
  field = "submissionId",
): string | null {
  const key = String(formData.get(field) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 40);

  return key || null;
}

/**
 * A readable, stable id. `seed` is normally a timestamp, but a caller that owns
 * an idempotency key passes THAT instead (#1394): the id is then a pure function
 * of the submission, so a replayed form lands on the same id rather than minting
 * a second row.
 */
export function createStableId(
  prefix: string,
  name: string,
  seed: number | string,
): string {
  const slug =
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || prefix;

  return `${prefix}_${slug}_${seed}`;
}
