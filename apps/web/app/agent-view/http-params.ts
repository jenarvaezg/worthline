import { AgentViewHttpError } from "./contract";

/**
 * Query-param parsers for the agent-view HTTP transport. Every rejection is the
 * documented `400 bad_request` carrying `details: { <field>: <raw value> }`, so a
 * caller always learns WHICH param it got wrong — there is no silent coercion.
 */

/** The documented `400` for a param whose value is outside its enum. */
export function enumError(field: string, value: string): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "bad_request",
    details: { [field]: value },
    message: `Invalid ${field} value.`,
    status: 400,
  });
}

/**
 * Parse one enum-valued query param against its allowed set (#1695: ONE parser
 * for every enum on the transport). With a `defaultValue` the param is optional
 * with that default; without one, an absent param stays `undefined` so the
 * builder decides. An unknown value is always {@link enumError}.
 */
export function parseEnum<T extends string>(
  field: string,
  raw: string | null,
  allowed: readonly T[],
  defaultValue: T,
): T;
export function parseEnum<T extends string>(
  field: string,
  raw: string | null,
  allowed: readonly T[],
): T | undefined;
export function parseEnum<T extends string>(
  field: string,
  raw: string | null,
  allowed: readonly T[],
  defaultValue?: T,
): T | undefined {
  if (raw === null) {
    return defaultValue;
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw enumError(field, raw);
  }

  return raw as T;
}

/**
 * Parse `growthAssumption`. It keeps its own documented message (rather than the
 * generic {@link enumError} one) because it names both accepted values inline.
 */
export function parseGrowthAssumption(value: string): "flat" | "historical" {
  if (value === "flat" || value === "historical") {
    return value;
  }
  throw new AgentViewHttpError({
    code: "bad_request",
    message: 'growthAssumption must be "flat" or "historical".',
    status: 400,
  });
}

/** Validate an ISO calendar date (`YYYY-MM-DD`); rejects malformed and non-existent dates. */
export function parseIsoDate(raw: string | null, field: string): string | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!isIsoCalendarDate(raw)) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { [field]: raw },
      message: `${field} must be an ISO calendar date (YYYY-MM-DD).`,
      status: 400,
    });
  }

  return raw;
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Parse the `holdingLimit` cap on summarized holdings; must be a positive integer. */
export function parseHoldingLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { holdingLimit: raw },
      message: "holdingLimit must be a positive integer.",
      status: 400,
    });
  }

  return Number(raw);
}

/** Parse a minor-unit amount param; must be a non-negative integer. */
export function parseNonNegativeInteger(
  raw: string | null,
  field: string,
): number | undefined {
  if (raw === null) {
    return undefined;
  }

  if (!/^\d+$/.test(raw)) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { [field]: raw },
      message: `${field} must be a non-negative integer (minor units).`,
      status: 400,
    });
  }

  return Number(raw);
}
