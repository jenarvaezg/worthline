import type { DecimalString } from "@worthline/domain";
import { parseDecimalStrict, parseDecimalToMinorStrict } from "@worthline/domain";
import type { Member, OwnershipShare } from "@worthline/domain";

/**
 * The intake field-validator primitives: the small, shared building blocks every
 * `parse*` entry point in `intake.ts` composes. Each primitive owns one
 * cross-cutting concern (an ISO date, a percent→decimal rate, a money amount, an
 * ownership split) so the validate-then-error-message logic lives in exactly one
 * place instead of being copy-inlined at every parser. Callers supply their own
 * field-specific error messages, keeping the user-facing text at the call site.
 */

// ─── ISO date ────────────────────────────────────────────────────────────────

/** The canonical YYYY-MM-DD shape every dated intake field must match. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Outcome of validating an ISO date field: the validated date or a typed error. */
export type IsoDateResult = { ok: true; date: string } | { ok: false; error: string };

/**
 * Validate an already-trimmed candidate as an ISO YYYY-MM-DD date string.
 *
 * This primitive owns only the format check and the optional "must not be future"
 * guard — the two pieces that were copy-inlined at every dated parser. Presence
 * (blank) checks and cross-field comparisons stay at the call site because they
 * carry site-specific messages and semantics. The caller passes its own messages
 * and decides explicitly whether a future date is rejected (`rejectFuture`),
 * preserving each site's exact behaviour.
 */
export function parseIsoDateField(
  value: string,
  options: {
    invalidMessage: string;
  } & (
    | { rejectFuture: true; today: string; futureMessage: string }
    | { rejectFuture: false }
  ),
): IsoDateResult {
  if (!ISO_DATE.test(value)) {
    return { ok: false, error: options.invalidMessage };
  }

  if (options.rejectFuture && value > options.today) {
    return { ok: false, error: options.futureMessage };
  }

  return { ok: true, date: value };
}

// ─── Rate (percent → decimal) ──────────────────────────────────────────────────

/**
 * Convert an es-ES user percentage (e.g. "3", "2,5") into the decimal string the
 * store persists ("0.03", "0.025"), trimming trailing float noise to a clean
 * decimal. The single home of the `pct/100` then integer-or-toString
 * normalization that two separate parsers used to each carry. Returns null on a
 * blank/unparseable or negative value so the caller can attach its own message.
 */
export function parsePercentToDecimal(raw: string): DecimalString | null {
  const pct = parseDecimalStrict(raw.trim());

  if (pct === null || pct < 0) {
    return null;
  }

  const decimal = pct / 100;

  return (
    Number.isInteger(decimal) ? String(decimal) : decimal.toString()
  ) as DecimalString;
}

// ─── Money / decimal (minor units) ─────────────────────────────────────────────

/**
 * Parse an es-ES money string into integer minor units, or null when blank or
 * unparseable. The shared seam in front of the domain's `parseDecimalToMinorStrict`
 * so callers never re-inline the es-ES normalization-then-validate logic.
 */
export function parseMoneyMinor(raw: string): number | null {
  return parseDecimalToMinorStrict(raw);
}

/** Turn an es-ES decimal string into a canonical one (1.234,56 → 1234.56). */
function normalizeEsDecimal(raw: string): string {
  const trimmed = raw.trim();

  return trimmed.includes(",") ? trimmed.replace(/\./g, "").replace(",", ".") : trimmed;
}

/**
 * Normalize an es-ES decimal string to a canonical decimal string, returning a
 * fallback when the value is blank or does not match the (optionally signed)
 * numeric shape. Used by the operation parser, which tolerates garbage by
 * collapsing it to a sentinel ("0") and validating afterwards. `allowNegative`
 * mirrors the call site's regex (operations allow a leading "-").
 */
export function normalizeDecimalString(
  raw: string,
  options: { allowNegative: boolean; fallback: string },
): string {
  const normalized = normalizeEsDecimal(raw);
  const pattern = options.allowNegative ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/;

  return pattern.test(normalized) ? normalized : options.fallback;
}

/**
 * Strictly normalize a non-negative es-ES decimal string, returning the
 * canonical decimal string (trailing zeros preserved, e.g. "12,50" → "12.50")
 * or null when it does not match the numeric shape. The shared seam for the
 * manual-price parsers, which must both reject garbage and keep the entered
 * precision.
 */
export function normalizeNonNegativeDecimalString(raw: string): string | null {
  const normalized = normalizeEsDecimal(raw);

  if (!/^\d+(\.\d+)?$/.test(normalized) || parseFloat(normalized) < 0) {
    return null;
  }

  return normalized;
}

// ─── Ownership split ───────────────────────────────────────────────────────────

export type OwnershipPreset = "scope" | "even" | "custom";

/**
 * How a custom ownership split below 100% is finished. Making this an explicit,
 * named choice (rather than a hidden `?? true` default) forces every caller to
 * declare whether a partial split is silently topped up to full ownership across
 * the unset members, or left exactly as entered.
 */
export type ShortfallCompletion = "complete-to-full-ownership" | "leave-as-entered";

/**
 * Resolve an ownership split from form input. A single active member always owns
 * 100%. Presets: "scope" (100% to the active scope member), "even" (split
 * equally, distributing the remainder deterministically), and "custom" (honor
 * entered bps). For a custom split below 100%, `shortfall` decides — explicitly —
 * whether the remainder is auto-distributed across the unset members or the split
 * is preserved exactly as entered.
 */
export function resolveOwnershipSplit(input: {
  activeMembers: Member[];
  scopeMemberId?: string | undefined;
  preset: OwnershipPreset;
  customBps?: Record<string, number> | undefined;
  shortfall: ShortfallCompletion;
}): OwnershipShare[] {
  const members = input.activeMembers;

  if (members.length === 0) {
    return [];
  }

  const scopeMember =
    members.find((member) => member.id === input.scopeMemberId) ?? members[0]!;

  if (members.length === 1 && input.preset !== "custom") {
    return [{ memberId: scopeMember.id, shareBps: 10_000 }];
  }

  if (input.preset === "scope") {
    return [{ memberId: scopeMember.id, shareBps: 10_000 }];
  }

  if (input.preset === "even") {
    return evenSplit(members);
  }

  const customBps = input.customBps ?? {};
  const entries = members.map((member) => ({
    memberId: member.id,
    shareBps: Math.max(0, Math.round(customBps[member.id] ?? 0)),
  }));
  const provided = entries.reduce((sum, entry) => sum + entry.shareBps, 0);

  if (provided === 0) {
    return [{ memberId: scopeMember.id, shareBps: 10_000 }];
  }

  if (input.shortfall === "complete-to-full-ownership" && provided < 10_000) {
    const unset = entries.filter((entry) => entry.shareBps === 0);

    if (unset.length > 0) {
      distributeRemainder(unset, 10_000 - provided);
    }
  }

  return entries.filter((entry) => entry.shareBps > 0);
}

function evenSplit(members: Member[]): OwnershipShare[] {
  const base = Math.floor(10_000 / members.length);
  let remainder = 10_000 - base * members.length;

  return members.map((member) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;

    return { memberId: member.id, shareBps: base + extra };
  });
}

function distributeRemainder(
  entries: Array<{ memberId: string; shareBps: number }>,
  amount: number,
): void {
  const base = Math.floor(amount / entries.length);
  let remainder = amount - base * entries.length;

  for (const entry of entries) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    entry.shareBps = base + extra;
  }
}
